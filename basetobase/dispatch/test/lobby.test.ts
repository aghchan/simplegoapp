import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Triage } from "../../shared/src/triage.ts";
import type { LobbyMessage, RunSummary } from "../../shared/src/types.ts";
import { announce, lobbyStub } from "../src/lobby/do.ts";
import { listRuns, runStub } from "../src/runs/index.ts";
import { envWith, prRef, stubGitHub } from "./helpers.ts";

const triage: Triage = {
  panels: ["backend"],
  rating: "black",
  runName: "Red Dog Face",
  files: 3,
  additions: 120,
  deletions: 10,
};

const summary: RunSummary = {
  id: "r1",
  prNumber: 58,
  prTitle: "orders: add cancel endpoint",
  runName: "Red Dog Face",
  rating: "black",
  status: "on_the_hill",
  outcome: "pending",
  currentStep: "sweep",
  createdAt: 1,
  updatedAt: 1,
};

const open: WebSocket[] = [];

async function listen(): Promise<{ ws: WebSocket; messages: LobbyMessage[] }> {
  const res = await lobbyStub(env).fetch("https://lobby/live", {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const messages: LobbyMessage[] = [];
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data as string) as LobbyMessage);
  });
  ws.accept();
  open.push(ws);
  return { ws, messages };
}

let runCount = 0;

async function startRun(): Promise<string> {
  const id = `lobby-r${++runCount}`;
  await runStub(env, id).start(prRef(), id, triage);
  return id;
}

const about = (messages: LobbyMessage[], runId: string) =>
  messages.filter((message) => message.run.id === runId);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM runs").run();
  stubGitHub();
});

afterEach(() => {
  for (const ws of open.splice(0)) ws.close(1000, "done");
  vi.restoreAllMocks();
});

describe("LobbyDO", () => {
  it("refuses a plain request", async () => {
    expect((await lobbyStub(env).fetch("https://lobby/live")).status).toBe(426);
  });

  it("sends a summary to every viewer", async () => {
    const viewers = [await listen(), await listen()];
    await lobbyStub(env).summary(summary);
    for (const { messages } of viewers) {
      await vi.waitFor(() => expect(messages).toEqual([{ type: "summary", run: summary }]));
    }
  });

  it("ignores what a viewer sends", async () => {
    const { ws, messages } = await listen();
    ws.send("hello");
    await lobbyStub(env).summary(summary);
    await vi.waitFor(() => expect(messages).toEqual([{ type: "summary", run: summary }]));
  });

  it("announce says whether the lobby heard", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await announce(env, summary)).toBe(true);
    const down = envWith(env, {
      LOBBY: {
        idFromName: () => env.LOBBY.idFromName("lobby"),
        get() {
          throw new Error("lobby unreachable");
        },
      },
    });
    expect(await announce(down, summary)).toBe(false);
  });

  it("a closed viewer socket fails neither the call nor the other viewers", async () => {
    const viewers = [await listen(), await listen(), await listen()];
    // Called inside the lobby, before the runtime drops the socket it just closed: it is still
    // listed, and send() on it throws.
    await runInDurableObject(lobbyStub(env), (instance, state) => {
      state.getWebSockets()[1]!.close(1000, "closed");
      return instance.summary(summary);
    });
    const got = () => viewers.filter(({ messages }) => messages.length > 0);
    await vi.waitFor(() => expect(got()).toHaveLength(2));
  });
});

describe("a run's index writes reach the lobby", () => {
  it("as the summary the runs list reads", async () => {
    const { messages } = await listen();
    const runId = await startRun();
    const [listed] = await listRuns(env.DB);
    await vi.waitFor(() => expect(about(messages, runId).at(-1)?.run).toEqual(listed));
  });

  it("including the run's end", async () => {
    const { messages } = await listen();
    const runId = await startRun();
    await runStub(env, runId).stop("PR closed");
    await vi.waitFor(() =>
      expect(about(messages, runId).at(-1)?.run).toMatchObject({ status: "stopped" }),
    );
  });

  it("not when the write failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { messages } = await listen();
    const id = `lobby-r${++runCount}`;
    const stub = runStub(env, id);
    await runInDurableObject(stub, (instance) => {
      const real = Reflect.get(instance, "env") as Env;
      const db = {
        prepare() {
          throw new Error("D1 unreachable");
        },
      } as unknown as D1Database;
      Object.defineProperty(instance, "env", { value: { ...real, DB: db } });
    });
    await stub.start(prRef(), id, triage);
    // Another run's summary, sent after: once it is in, this run's would have been too.
    const later = await startRun();
    await vi.waitFor(() => expect(about(messages, later)).not.toHaveLength(0));
    expect(about(messages, id)).toEqual([]);
  });

  // Nothing else would send a finished run's row to an open runs list again.
  it("again when the lobby missed it, until it hears", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { messages } = await listen();
    const id = `lobby-r${++runCount}`;
    const stub = runStub(env, id);
    await stub.start(prRef(), id, triage);
    await runInDurableObject(stub, (instance) => {
      const real = Reflect.get(instance, "env") as Env;
      let refusals = 1;
      const lobby = {
        idFromName: (name: string) => real.LOBBY.idFromName(name),
        get(lobbyId: DurableObjectId) {
          if (refusals-- > 0) throw new Error("lobby unreachable");
          return real.LOBBY.get(lobbyId);
        },
      };
      Object.defineProperty(instance, "env", { value: { ...real, LOBBY: lobby } });
    });
    await stub.stop("PR closed");
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("lobby unreachable"));
    const { alarm } = await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
    }));
    expect(alarm).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(about(messages, id).at(-1)?.run).toMatchObject({ status: "on_the_hill" });

    await stub.view();
    await vi.waitFor(() =>
      expect(about(messages, id).at(-1)?.run).toMatchObject({ status: "stopped" }),
    );
  });

  it("and a lobby that fails does not fail the run", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = `lobby-r${++runCount}`;
    const stub = runStub(env, id);
    await runInDurableObject(stub, (instance) => {
      const real = Reflect.get(instance, "env") as Env;
      const lobby = {
        idFromName: () => real.LOBBY.idFromName("lobby"),
        get() {
          throw new Error("lobby unreachable");
        },
      };
      Object.defineProperty(instance, "env", { value: { ...real, LOBBY: lobby } });
    });
    const snapshot = await stub.start(prRef(), id, triage);
    expect(snapshot.agents[0]?.status).toBe("dispatched");
    expect(await listRuns(env.DB)).toMatchObject([{ id, status: "on_the_hill" }]);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("lobby unreachable"));
    await stub.stop("PR closed");
    expect(await listRuns(env.DB)).toMatchObject([{ id, status: "stopped" }]);
  });
});
