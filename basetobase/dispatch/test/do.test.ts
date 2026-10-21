import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Triage } from "../../shared/src/triage.ts";
import type { AgentEvent, LiveMessage } from "../../shared/src/types.ts";
import { runStub, listRuns } from "../src/runs/index.ts";
import { AGENT_TIMEOUT_MS, STALL_MS, type RunState } from "../src/run/machine.ts";
import { fakeFetch, prRef } from "./helpers.ts";

const AGENT = "mainline-sweep-0";
const JOB_URL = "https://github.com/aghchan/simplegoapp/actions/runs/99";
const DISPATCH_PATH =
  "/repos/aghchan/simplegoapp/actions/workflows/basetobase-agent.yml/dispatches";

const triage: Triage = {
  panels: ["backend"],
  rating: "black",
  runName: "Red Dog Face",
  files: 3,
  additions: 120,
  deletions: 10,
};
const evs: AgentEvent[] = [
  { seq: 1, ts: 1000, kind: "say", text: "reading the diff" },
  { seq: 2, ts: 1001, kind: "tool", text: "Read orders.go" },
];
const clearVerdict = {
  role: "mainline",
  headSha: "head58",
  status: "clear",
  hazards: [],
  summary: "No functional issues found.",
};

let runCount = 0;
let dispatches: { ref: string; inputs: Record<string, string> }[];

// The body is recorded inside the route: a Request made in the Durable Object can't be read here.
function stubGitHub(
  respond: () => Response | Promise<Response> = () => new Response(null, { status: 204 }),
): void {
  const github = fakeFetch({
    "POST /app/installations/7/access_tokens": () =>
      Response.json(
        { token: "installation-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        { status: 201 },
      ),
    [`POST ${DISPATCH_PATH}`]: async (req) => {
      dispatches.push(await req.json());
      return respond();
    },
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(github);
}

async function startRun() {
  const id = `r${++runCount}`;
  const stub = runStub(env, id);
  const snapshot = await stub.start(prRef(), id, triage);
  return { id, stub, snapshot, nonce: dispatches[0]!.inputs.nonce as string };
}

function collect(ws: WebSocket): LiveMessage[] {
  const messages: LiveMessage[] = [];
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data as string) as LiveMessage);
  });
  return messages;
}

type Stub = ReturnType<typeof runStub>;

async function storedState(stub: Stub) {
  return runInDurableObject(stub, async (_instance, state) => ({
    run: (await state.storage.get<RunState>("state"))!,
    alarm: await state.storage.getAlarm(),
  }));
}

async function connect(stub: Stub) {
  const res = await stub.fetch("https://do/live", { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket!;
  ws.accept();
  return { res, ws, messages: collect(ws) };
}

// Makes the run's next `times` D1 writes fail, as an unreachable database would.
async function failIndexWrites(stub: Stub, times: number): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const real = Reflect.get(instance, "env") as Env;
    let remaining = times;
    const db = {
      prepare(sql: string) {
        if (remaining > 0) {
          remaining--;
          throw new Error("D1 unreachable");
        }
        return real.DB.prepare(sql);
      },
    } as unknown as D1Database;
    Object.defineProperty(instance, "env", { value: { ...real, DB: db } });
  });
}

// Backdates the agent's dispatch past the timeout and fires the alarm that fails it.
async function timeOut(stub: Stub): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const run = (await state.storage.get<RunState>("state"))!;
    const old = run.agents.map((agent) => ({
      ...agent,
      dispatchedAt: Date.now() - AGENT_TIMEOUT_MS - 1,
    }));
    await state.storage.put("state", { ...run, agents: old });
  });
  await runDurableObjectAlarm(stub);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM runs").run();
  dispatches = [];
  stubGitHub();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RunDO", () => {
  it("start dispatches mainline and indexes the run", async () => {
    const { snapshot } = await startRun();
    expect(snapshot.agents[0]?.status).toBe("dispatched");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      ref: "main",
      inputs: { run_id: "r1", agent_id: AGENT, sha: "head58" },
    });
    expect(dispatches[0]!.inputs.nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(await listRuns(env.DB)).toMatchObject([
      { id: "r1", status: "on_the_hill", runName: "Red Dog Face" },
    ]);
  });

  it("logs the run's creation as a dispatch line", async () => {
    const { stub } = await startRun();
    const log = (await stub.view())!.log;
    expect(log).toMatchObject([
      { agentId: null, kind: "system", text: "run created · Red Dog Face" },
    ]);
  });

  it("view is null before a run starts", async () => {
    expect(await runStub(env, "never-started").view()).toBeNull();
  });

  describe("agent authentication", () => {
    const wrongNonces = [
      ["wrong content", (nonce: string) => nonce.replace(/.$/, nonce.endsWith("0") ? "1" : "0")],
      ["a prefix", (nonce: string) => nonce.slice(0, 10)],
      ["too long", (nonce: string) => `${nonce}0`],
      ["empty", () => ""],
    ] as const;

    it.each(wrongNonces)(
      "rejects a nonce that is %s on every agent method",
      async (_name, mangle) => {
        const { stub, nonce } = await startRun();
        const bad = mangle(nonce);
        expect(await stub.checkNonce(AGENT, bad)).toBe(false);
        expect(await stub.brief(AGENT, bad)).toBeNull();
        expect(await stub.events(AGENT, bad, evs, JOB_URL)).toBe("forbidden");
        expect(await stub.verdict(AGENT, bad, clearVerdict)).toBe("forbidden");
        expect(await stub.verdict(AGENT, bad, { nope: 1 })).toBe("forbidden");
        expect(await stub.failure(AGENT, bad, "boom")).toBe("forbidden");
        expect(await stub.transcriptStored(AGENT, bad)).toBe(false);

        const view = (await stub.view())!;
        expect(view.run.agents[0]).toMatchObject({ status: "dispatched", hasTranscript: false });
        expect(view.log.filter((line) => line.agentId !== null)).toHaveLength(0);
        expect(view.log).toHaveLength(1);
      },
    );

    // The nonce an unguarded `nonces[agentId]` lookup would yield for an inherited property.
    it.each(["not-an-agent", "__proto__", "constructor", "toString"])(
      "rejects the agent id %s",
      async (agentId) => {
        const { stub, nonce } = await startRun();
        const inherited = String(({} as Record<string, unknown>)[agentId] ?? nonce);
        for (const attempt of [nonce, inherited]) {
          expect(await stub.checkNonce(agentId, attempt)).toBe(false);
          expect(await stub.brief(agentId, attempt)).toBeNull();
          expect(await stub.events(agentId, attempt, evs, JOB_URL)).toBe("forbidden");
          expect(await stub.verdict(agentId, attempt, clearVerdict)).toBe("forbidden");
          expect(await stub.failure(agentId, attempt, "boom")).toBe("forbidden");
          expect(await stub.transcriptStored(agentId, attempt)).toBe(false);
        }
        expect((await stub.view())!.log).toHaveLength(1);
      },
    );
  });

  describe("checkNonce", () => {
    it("accepts the agent's own nonce", async () => {
      const { stub, nonce } = await startRun();
      expect(await stub.checkNonce(AGENT, nonce)).toBe(true);
    });

    it("answers for a run that was stopped and an agent that has reported", async () => {
      const { stub, nonce } = await startRun();
      await stub.verdict(AGENT, nonce, clearVerdict);
      await stub.stop("PR closed");
      expect(await stub.brief(AGENT, nonce)).toBeNull();
      expect(await stub.checkNonce(AGENT, nonce)).toBe(true);
    });

    it("changes nothing", async () => {
      const { stub, nonce } = await startRun();
      const before = await stub.view();
      await stub.checkNonce(AGENT, nonce);
      await stub.checkNonce(AGENT, "wrong");
      expect(await stub.view()).toEqual(before);
    });

    it("rejects every nonce for a run that never started", async () => {
      expect(await runStub(env, "never-started").checkNonce(AGENT, "anything")).toBe(false);
    });
  });

  describe("brief", () => {
    it("returns the agent's brief for the right nonce", async () => {
      const { stub, nonce } = await startRun();
      expect(await stub.brief(AGENT, nonce)).toMatchObject({
        role: "mainline",
        model: "sonnet",
        prefix: "FUN",
        prNumber: 58,
        baseSha: "base58",
        headSha: "head58",
      });
    });

    it("is refused once the run is stopped", async () => {
      const { stub, nonce } = await startRun();
      await stub.stop("PR closed");
      expect(await stub.brief(AGENT, nonce)).toBeNull();
    });

    it("is refused once the agent has reported", async () => {
      const { stub, nonce } = await startRun();
      await stub.verdict(AGENT, nonce, clearVerdict);
      expect(await stub.brief(AGENT, nonce)).toBeNull();
    });
  });

  describe("events", () => {
    it("dedupes events by agent seq", async () => {
      const { stub, nonce } = await startRun();
      expect(await stub.events(AGENT, nonce, evs, JOB_URL)).toBe("accepted");
      expect(await stub.events(AGENT, nonce, evs, JOB_URL)).toBe("accepted");
      const lines = (await stub.view())!.log.filter((line) => line.agentId === AGENT);
      expect(lines).toHaveLength(evs.length);
      expect(lines.map((line) => line.text)).toEqual(["reading the diff", "Read orders.go"]);
    });

    it("marks the agent running and records the job url", async () => {
      const { stub, nonce } = await startRun();
      await stub.events(AGENT, nonce, evs, JOB_URL);
      expect((await stub.view())!.run.agents[0]).toMatchObject({
        status: "running",
        jobUrl: JOB_URL,
      });
    });

    it("caps logged text at 2000 characters", async () => {
      const { stub, nonce } = await startRun();
      await stub.events(
        AGENT,
        nonce,
        [{ seq: 1, ts: 1, kind: "say", text: "x".repeat(5000) }],
        JOB_URL,
      );
      const line = (await stub.view())!.log.find((entry) => entry.agentId === AGENT);
      expect(line?.text).toHaveLength(2000);
    });
  });

  describe("verdict", () => {
    it("a valid verdict sweeps and updates the index", async () => {
      const { stub, nonce } = await startRun();
      expect(await stub.verdict(AGENT, nonce, clearVerdict)).toBe("accepted");
      expect((await listRuns(env.DB))[0]?.status).toBe("swept");
      const view = (await stub.view())!;
      expect(view.run.agents[0]).toMatchObject({
        status: "clear",
        summary: "No functional issues found.",
      });
      expect(view.log.at(-1)?.text).toBe("all 1 sweeps in · 0 hazards");
    });

    it("an invalid verdict marks the agent error and completes the sweep", async () => {
      const { stub, nonce } = await startRun();
      expect(await stub.verdict(AGENT, nonce, { nope: 1 })).toEqual({
        invalid: expect.any(String),
      });
      const view = (await stub.view())!;
      expect(view.run.agents[0]?.status).toBe("error");
      expect(view.run.status).toBe("swept");
    });

    it("names the broken field without echoing the error object", async () => {
      const { stub, nonce } = await startRun();
      const result = await stub.verdict(AGENT, nonce, { ...clearVerdict, role: "corduroy" });
      expect(result).toEqual({ invalid: "role must be mainline" });
      expect((await stub.view())!.run.agents[0]?.summary).toBe(
        "invalid verdict: role must be mainline",
      );
    });

    it("rejects a verdict for another commit", async () => {
      const { stub, nonce } = await startRun();
      const result = await stub.verdict(AGENT, nonce, { ...clearVerdict, headSha: "other" });
      expect(result).toEqual({ invalid: "headSha must be head58" });
    });
  });

  describe("failure", () => {
    it("marks the agent error with the reason and completes the sweep", async () => {
      const { stub, nonce } = await startRun();
      expect(await stub.failure(AGENT, nonce, "claude exited without a verdict")).toBe("accepted");
      const view = (await stub.view())!;
      expect(view.run.agents[0]).toMatchObject({
        status: "error",
        summary: "claude exited without a verdict",
      });
      expect(view.run.status).toBe("swept");
      expect(
        view.log.some((line) => line.text === `${AGENT} failed · claude exited without a verdict`),
      ).toBe(true);
    });
  });

  // "gone" is the forwarder's cue to stop claude: the run will never use what the agent sends.
  describe("reports the run no longer wants", () => {
    type Call = (stub: Stub, nonce: string) => Promise<unknown>;
    const reports: [string, Call][] = [
      ["events", (stub, nonce) => stub.events(AGENT, nonce, evs, JOB_URL)],
      ["a verdict", (stub, nonce) => stub.verdict(AGENT, nonce, clearVerdict)],
      ["an invalid verdict", (stub, nonce) => stub.verdict(AGENT, nonce, { nope: 1 })],
      ["a failure", (stub, nonce) => stub.failure(AGENT, nonce, "boom")],
    ];
    const endings: [string, Call][] = [
      ["the run was stopped", (stub) => stub.stop("PR closed")],
      ["the agent gave its verdict", (stub, nonce) => stub.verdict(AGENT, nonce, clearVerdict)],
      ["the agent reported a failure", (stub, nonce) => stub.failure(AGENT, nonce, "exited 1")],
      ["the agent timed out", (stub) => timeOut(stub)],
    ];

    describe.each(endings)("once %s", (_ending, end) => {
      it.each(reports)("answers %s with gone and changes nothing", async (_report, send) => {
        const { stub, nonce } = await startRun();
        await end(stub, nonce);
        const before = await stub.view();
        expect(await send(stub, nonce)).toBe("gone");
        expect(await stub.view()).toEqual(before);
      });
    });

    it("broadcasts nothing", async () => {
      const { stub, nonce } = await startRun();
      await stub.stop("PR closed");
      const { messages } = await connect(stub);
      for (const [, send] of reports) await send(stub, nonce);
      // A stopped run still takes the transcript; its broadcast comes after any the reports made.
      await stub.transcriptStored(AGENT, nonce);
      await vi.waitFor(() => expect(messages).toHaveLength(2));
      expect(messages[1]).toMatchObject({ type: "run", run: { agents: [{ hasTranscript: true }] } });
    });

    it("still forbids a wrong nonce", async () => {
      const { stub, nonce } = await startRun();
      await stub.stop("PR closed");
      for (const [, send] of reports) expect(await send(stub, `${nonce}0`)).toBe("forbidden");
    });
  });

  describe("dispatch", () => {
    it("marks the agent error when the dispatch is refused", async () => {
      stubGitHub(() => new Response(null, { status: 500 }));
      const id = `r${++runCount}`;
      const snapshot = await runStub(env, id).start(prRef(), id, triage);
      expect(snapshot.agents[0]).toMatchObject({
        status: "error",
        summary: expect.stringMatching(/dispatch failed/),
      });
      expect(snapshot.status).toBe("swept");
      expect((await listRuns(env.DB))[0]?.status).toBe("swept");
    });

    it("marks the agent error when the app key is PKCS#1", async () => {
      const pkcs1 = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n";
      const id = `r${++runCount}`;
      const stub = runStub(env, id);
      await runInDurableObject(stub, (instance) => {
        Object.defineProperty(instance, "env", {
          value: { ...env, GITHUB_APP_PRIVATE_KEY: pkcs1 },
        });
      });
      const snapshot = await stub.start(prRef(), id, triage);
      expect(snapshot.agents[0]).toMatchObject({
        status: "error",
        summary: expect.stringMatching(/dispatch failed: .*PKCS#1/),
      });
    });

    it("keeps an agent's early events when they beat the dispatch response", async () => {
      const release = deferred<void>();
      stubGitHub(async () => {
        await release.promise;
        return new Response(null, { status: 204 });
      });
      const id = `r${++runCount}`;
      const stub = runStub(env, id);
      const started = stub.start(prRef(), id, triage);
      await vi.waitFor(() => expect(dispatches).toHaveLength(1));
      await stub.events(AGENT, dispatches[0]!.inputs.nonce as string, evs, JOB_URL);
      release.resolve();
      expect((await started).agents[0]?.status).toBe("running");
      expect((await stub.view())!.run.agents[0]?.status).toBe("running");
    });
  });

  describe("transcript", () => {
    it("flags the agent's transcript", async () => {
      const { stub, nonce } = await startRun();
      expect(await stub.transcriptStored(AGENT, nonce)).toBe(true);
      expect((await stub.view())!.run.agents[0]?.hasTranscript).toBe(true);
    });

    it("is still flagged after the run was stopped", async () => {
      const { stub, nonce } = await startRun();
      await stub.stop("PR closed");
      expect(await stub.transcriptStored(AGENT, nonce)).toBe(true);
      const view = (await stub.view())!;
      expect(view.run.status).toBe("stopped");
      expect(view.run.agents[0]).toMatchObject({ status: "stopped", hasTranscript: true });
    });
  });

  describe("stop", () => {
    it("stops the run, logs why, and updates the index", async () => {
      const { stub } = await startRun();
      await stub.stop("PR closed");
      const view = (await stub.view())!;
      expect(view.run.status).toBe("stopped");
      expect(view.log.at(-1)).toMatchObject({ agentId: null, text: "stopped · PR closed" });
      expect((await listRuns(env.DB))[0]?.status).toBe("stopped");
    });

    it("stopping a run that never started does nothing", async () => {
      const stub = runStub(env, "never-started");
      await stub.stop("PR closed");
      expect(await stub.view()).toBeNull();
    });
  });

  describe("alarm", () => {
    it("is set when the run starts", async () => {
      const { stub } = await startRun();
      const { run, alarm } = await storedState(stub);
      expect(alarm).toBe(run.agents[0]!.dispatchedAt! + STALL_MS);
    });

    it("moves with the agent's last event", async () => {
      const { stub, nonce } = await startRun();
      await stub.events(AGENT, nonce, evs, JOB_URL);
      const { run, alarm } = await storedState(stub);
      expect(alarm).toBe(run.agents[0]!.lastEventAt! + STALL_MS);
    });

    it("is cleared once the sweep is in", async () => {
      const { stub, nonce } = await startRun();
      await stub.verdict(AGENT, nonce, clearVerdict);
      expect((await storedState(stub)).alarm).toBeNull();
    });

    it("is cleared when the run is stopped", async () => {
      const { stub } = await startRun();
      await stub.stop("PR closed");
      expect((await storedState(stub)).alarm).toBeNull();
    });

    it("is cleared when the dispatch failed", async () => {
      stubGitHub(() => new Response(null, { status: 500 }));
      const id = `r${++runCount}`;
      const stub = runStub(env, id);
      await stub.start(prRef(), id, triage);
      expect((await storedState(stub)).alarm).toBeNull();
    });

    it("stalls a silent agent and keeps watching for its timeout", async () => {
      const { stub } = await startRun();
      await runInDurableObject(stub, async (_instance, state) => {
        const run = (await state.storage.get<RunState>("state"))!;
        const silent = run.agents.map((agent) => ({
          ...agent,
          dispatchedAt: Date.now() - STALL_MS - 1,
        }));
        await state.storage.put("state", { ...run, agents: silent });
      });
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      const { run, alarm } = await storedState(stub);
      expect(run.agents[0]?.status).toBe("stalled");
      expect(alarm).toBe(run.agents[0]!.dispatchedAt! + AGENT_TIMEOUT_MS);
    });

    it("times out an agent that never finishes", async () => {
      const { stub } = await startRun();
      await timeOut(stub);
      const view = (await stub.view())!;
      expect(view.run.agents[0]).toMatchObject({ status: "error", summary: "timed out" });
      expect(view.run.status).toBe("swept");
      expect((await listRuns(env.DB))[0]?.status).toBe("swept");
      expect((await storedState(stub)).alarm).toBeNull();
    });
  });

  describe("index retries", () => {
    let consoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    async function indexedStatus() {
      return (await listRuns(env.DB))[0]?.status;
    }

    it("retries a failed write on the next alarm", async () => {
      const { stub, nonce } = await startRun();
      await failIndexWrites(stub, 1);
      expect(await stub.verdict(AGENT, nonce, clearVerdict)).toBe("accepted");
      expect(await indexedStatus()).toBe("on_the_hill");
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("run index write failed"));

      const { alarm } = await storedState(stub);
      expect(alarm).toBeLessThanOrEqual(Date.now() + 60_000);
      await runDurableObjectAlarm(stub);
      expect(await indexedStatus()).toBe("swept");
      expect((await storedState(stub)).alarm).toBeNull();
    });

    it("retries when the run is next called", async () => {
      const { stub, nonce } = await startRun();
      await failIndexWrites(stub, 1);
      await stub.verdict(AGENT, nonce, clearVerdict);
      expect(await indexedStatus()).toBe("on_the_hill");
      await stub.view();
      expect(await indexedStatus()).toBe("swept");
    });

    it("retries when the agent repeats its report, though the run is done with it", async () => {
      const { stub, nonce } = await startRun();
      await failIndexWrites(stub, 1);
      await stub.verdict(AGENT, nonce, clearVerdict);
      expect(await stub.verdict(AGENT, nonce, clearVerdict)).toBe("gone");
      expect(await indexedStatus()).toBe("swept");
    });

    it("keeps retrying until a write succeeds", async () => {
      const { stub, nonce } = await startRun();
      await failIndexWrites(stub, 2);
      await stub.verdict(AGENT, nonce, clearVerdict);
      await runDurableObjectAlarm(stub);
      expect(await indexedStatus()).toBe("on_the_hill");
      expect((await storedState(stub)).alarm).toBeLessThanOrEqual(Date.now() + 60_000);
      await runDurableObjectAlarm(stub);
      expect(await indexedStatus()).toBe("swept");
    });

    it("still broadcasts the transition when the write fails", async () => {
      const { stub, nonce } = await startRun();
      const { messages } = await connect(stub);
      await failIndexWrites(stub, 1);
      await stub.verdict(AGENT, nonce, clearVerdict);
      await vi.waitFor(() =>
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: "run",
            run: expect.objectContaining({ status: "swept" }),
          }),
        ),
      );
    });

    it("retries a failed first write, then returns to the machine's own deadline", async () => {
      const id = `r${++runCount}`;
      const stub = runStub(env, id);
      await failIndexWrites(stub, 1);
      await stub.start(prRef(), id, triage);
      expect(await listRuns(env.DB)).toEqual([]);
      const pending = await storedState(stub);
      expect(pending.alarm).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(pending.alarm).toBeLessThan(pending.run.agents[0]!.dispatchedAt! + STALL_MS);

      await stub.view();
      expect(await indexedStatus()).toBe("on_the_hill");
      const settled = await storedState(stub);
      expect(settled.alarm).toBe(settled.run.agents[0]!.dispatchedAt! + STALL_MS);
    });
  });

  describe("live socket", () => {
    it("gets a snapshot then log lines", async () => {
      const { stub, nonce } = await startRun();
      const { res, messages } = await connect(stub);
      expect(res.status).toBe(101);
      await stub.events(AGENT, nonce, evs, JOB_URL);
      await vi.waitFor(() => expect(messages.some((message) => message.type === "log")).toBe(true));
      expect(messages[0]).toMatchObject({
        type: "snapshot",
        run: { id: "r" + runCount },
        log: [{ text: "run created · Red Dog Face" }],
      });
      const logged = messages.find((message) => message.type === "log");
      expect(logged).toMatchObject({
        lines: [{ text: "reading the diff" }, { text: "Read orders.go" }],
      });
    });

    it("gets the run update after the events", async () => {
      const { stub, nonce } = await startRun();
      const { messages } = await connect(stub);
      await stub.events(AGENT, nonce, evs, JOB_URL);
      await vi.waitFor(() => expect(messages.some((message) => message.type === "run")).toBe(true));
      const update = messages.find((message) => message.type === "run");
      expect(update).toMatchObject({ run: { agents: [{ status: "running" }] } });
    });

    it("never carries the nonces", async () => {
      const { stub, nonce } = await startRun();
      const { messages } = await connect(stub);
      await stub.events(AGENT, nonce, evs, JOB_URL);
      await vi.waitFor(() => expect(messages.length).toBeGreaterThan(2));
      expect(JSON.stringify(messages)).not.toContain(nonce);
    });

    it("ignores what a viewer sends", async () => {
      const { stub, nonce } = await startRun();
      const { ws, messages } = await connect(stub);
      ws.send("hello");
      await stub.events(AGENT, nonce, evs, JOB_URL);
      await vi.waitFor(() => expect(messages.some((message) => message.type === "log")).toBe(true));
      expect((await stub.view())!.log.filter((line) => line.agentId === AGENT)).toHaveLength(
        evs.length,
      );
    });

    it("keeps serving after a viewer disconnects", async () => {
      const { stub, nonce } = await startRun();
      const { ws } = await connect(stub);
      ws.close(1000, "done");
      expect(await stub.events(AGENT, nonce, evs, JOB_URL)).toBe("accepted");
      expect(await stub.verdict(AGENT, nonce, clearVerdict)).toBe("accepted");
    });

    it("a closed viewer socket fails neither the call nor the other viewers", async () => {
      const { stub, nonce } = await startRun();
      const viewers = [await connect(stub), await connect(stub), await connect(stub)];
      // Called inside the run, before the runtime drops the socket it just closed: it is still
      // listed, and send() on it throws.
      const handled = await runInDurableObject(stub, (instance, state) => {
        state.getWebSockets()[1]!.close(1000, "closed");
        return instance.events(AGENT, nonce, evs, JOB_URL);
      });
      expect(handled).toBe("accepted");
      expect((await stub.view())!.run.agents[0]?.status).toBe("running");
      const gotLines = () =>
        viewers.filter(({ messages }) => messages.some((message) => message.type === "log"));
      await vi.waitFor(() => expect(gotLines()).toHaveLength(2));
      expect(await stub.verdict(AGENT, nonce, clearVerdict)).toBe("accepted");
    });

    it("refuses a plain request", async () => {
      const { stub } = await startRun();
      expect((await stub.fetch("https://do/live")).status).toBe(426);
    });

    it("refuses a socket for a run that never started", async () => {
      const res = await runStub(env, "never-started").fetch("https://do/live", {
        headers: { Upgrade: "websocket" },
      });
      expect(res.status).toBe(404);
    });
  });
});
