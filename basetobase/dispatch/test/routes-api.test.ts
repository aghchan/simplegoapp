import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createLocalJWKSet } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, SESSION_TTL_MS, signSession } from "../src/auth/session.ts";
import { createApp } from "../src/index.ts";
import { runStub } from "../src/runs/index.ts";
import type { Triage } from "../../shared/src/triage.ts";
import type { LiveMessage, LobbyMessage } from "../../shared/src/types.ts";
import { envWith, prRef, stubGitHub } from "./helpers.ts";

const app = createApp({ agentKey: createLocalJWKSet({ keys: [] }) });
const AGENT = "mainline-sweep-0";
const NO_STORE = "no-store";

const triage: Triage = {
  panels: ["backend"],
  rating: "black",
  runName: "Red Dog Face",
  files: 3,
  additions: 120,
  deletions: 10,
};

interface Call {
  // The whole Cookie header; null sends none, and left out signs in as the owner.
  cookie?: string | null;
  headers?: Record<string, string>;
  workerEnv?: Env;
}

async function signedIn(login = "aghchan", now = Date.now()): Promise<string> {
  return `${SESSION_COOKIE}=${await signSession(env.SESSION_SECRET, login, now)}`;
}

async function get(path: string, call: Call = {}): Promise<Response> {
  const headers = new Headers(call.headers);
  const cookie = call.cookie === undefined ? await signedIn() : call.cookie;
  if (cookie !== null) headers.set("Cookie", cookie);
  const req = new Request(`https://b2b.test${path}`, { headers });
  return app.fetch(req, call.workerEnv ?? env, createExecutionContext());
}

// A POST from the dashboard's own page, as a browser sends it; `origin` null sends none.
async function post(
  path: string,
  call: Call & { origin?: string | null } = {},
): Promise<Response> {
  const headers = new Headers(call.headers);
  const cookie = call.cookie === undefined ? await signedIn() : call.cookie;
  if (cookie !== null) headers.set("Cookie", cookie);
  const origin = call.origin === undefined ? new URL(env.PUBLIC_URL).origin : call.origin;
  if (origin !== null) headers.set("Origin", origin);
  const req = new Request(`https://b2b.test${path}`, { method: "POST", headers });
  return app.fetch(req, call.workerEnv ?? env, createExecutionContext());
}

let runCount = 0;

async function startRun(): Promise<string> {
  const runId = `r${++runCount}`;
  await runStub(env, runId).start(prRef(), runId, triage);
  return runId;
}

const transcriptKey = (runId: string) => `runs/${runId}/${AGENT}.jsonl`;
const transcriptPath = (runId: string) => `/api/runs/${runId}/agents/${AGENT}/transcript`;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM runs").run();
  stubGitHub();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/api authentication", () => {
  const paths = [
    "/api/me",
    "/api/runs",
    "/api/runs/r1",
    "/api/runs/r1/live",
    "/api/runs/r1/agents/mainline-sweep-0/transcript",
    "/api/live",
    "/api/anything-else",
  ];

  it.each(paths)("401 without a session on %s", async (path) => {
    const res = await get(path, { cookie: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed out" });
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });

  it.each(["/api/runs/r1/live", "/api/live"])(
    "401 on a websocket upgrade without a session on %s",
    async (path) => {
      const res = await get(path, { cookie: null, headers: { Upgrade: "websocket" } });
      expect(res.status).toBe(401);
      expect(res.webSocket).toBeNull();
    },
  );

  it.each<[string, () => Promise<string>]>([
    ["garbage", async () => `${SESSION_COOKIE}=garbage`],
    ["another cookie", async () => "theme=dark"],
    [
      "a session signed under another secret",
      async () => `${SESSION_COOKIE}=${await signSession("another-secret", "aghchan", Date.now())}`,
    ],
    ["an expired session", async () => signedIn("aghchan", Date.now() - SESSION_TTL_MS - 1000)],
    ["a session for someone else", () => signedIn("eve")],
    ["a session for a login that only contains the owner's", () => signedIn("aghchan-evil")],
  ])("401 with %s", async (_name, cookie) => {
    const res = await get("/api/me", { cookie: await cookie() });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed out" });
  });

  // An unset Worker secret arrives as undefined, which is the state between the first deploy and
  // `wrangler secret put`.
  describe.each([
    ["empty", ""],
    ["unset", undefined],
  ])("with an %s session secret", (_name, secret) => {
    const workerEnv = () => envWith(env, { SESSION_SECRET: secret });

    it.each<[string, () => Promise<string>]>([
      ["a session signed under the real secret", () => signedIn()],
      ["a well-formed forgery", async () => `${SESSION_COOKIE}=e30.AAAA`],
    ])("401, not a crash, for %s", async (_cookieName, cookie) => {
      const res = await get("/api/runs", { cookie: await cookie(), workerEnv: workerEnv() });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "signed out" });
    });
  });

  it.each(["someone-else", "", undefined])("401 once the owner is %j", async (owner) => {
    const workerEnv = envWith(env, { OWNER_LOGIN: owner });
    const res = await get("/api/me", { workerEnv });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed out" });
  });

  it("accepts the owner's login in another case", async () => {
    const res = await get("/api/me", { cookie: await signedIn("AghChan") });
    expect(res.status).toBe(200);
  });
});

describe("GET /api/me", () => {
  it("names the signed-in owner", async () => {
    const res = await get("/api/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ login: "aghchan" });
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });
});

describe("GET /api/runs", () => {
  it("is empty before any run", async () => {
    const res = await get("/api/runs");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("lists the runs", async () => {
    const runId = await startRun();
    const res = await get("/api/runs");
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
    const runs = (await res.json()) as { id: string }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: runId,
      prNumber: 58,
      prTitle: "orders: add cancel endpoint",
      runName: "Red Dog Face",
      rating: "black",
      status: "on_the_hill",
    });
  });
});

describe("GET /api/runs/:id", () => {
  it("returns the run with its log", async () => {
    const runId = await startRun();
    const res = await get(`/api/runs/${runId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
    const body = (await res.json()) as { run: { id: string }; log: unknown[] };
    expect(body.run.id).toBe(runId);
    expect(Array.isArray(body.log)).toBe(true);
  });

  it("404 for a run that never started", async () => {
    const res = await get("/api/runs/no-such-run");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });
});

describe("GET /api/runs/:id/agents/:agentId/transcript", () => {
  it("returns the stored transcript as ndjson", async () => {
    const runId = await startRun();
    const lines = '{"type":"assistant"}\n{"type":"result"}\n';
    await env.TRANSCRIPTS.put(transcriptKey(runId), lines);
    const res = await get(transcriptPath(runId));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(lines);
  });

  it("404 when the agent has stored none", async () => {
    const runId = await startRun();
    const res = await get(transcriptPath(runId));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });

  it("404 for another agent's transcript", async () => {
    const runId = await startRun();
    await env.TRANSCRIPTS.put(transcriptKey(runId), "{}\n");
    const res = await get(`/api/runs/${runId}/agents/corduroy-sweep-0/transcript`);
    expect(res.status).toBe(404);
  });

  it("passes the stored body through as a stream", async () => {
    const encoder = new TextEncoder();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(encoder.encode("first\n"));
          return;
        }
        await released;
        controller.enqueue(encoder.encode("second\n"));
        controller.close();
      },
    });
    const kvGet = vi.fn(async () => body);
    const workerEnv = envWith(env, { TRANSCRIPTS: { get: kvGet } });

    const res = await get(transcriptPath("r1"), { workerEnv });

    expect(kvGet).toHaveBeenCalledWith(transcriptKey("r1"), "stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    // The second chunk is still being held back, so a buffered body would never have got here.
    expect(decoder.decode((await reader.read()).value)).toBe("first\n");
    release();
    expect(decoder.decode((await reader.read()).value)).toBe("second\n");
    expect((await reader.read()).done).toBe(true);
  });
});

describe("GET /api/runs/:id/live", () => {
  const upgrade = { Upgrade: "websocket" };

  it("426 for a request that is not a websocket upgrade", async () => {
    const runId = await startRun();
    const res = await get(`/api/runs/${runId}/live`);
    expect(res.status).toBe(426);
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });

  it("upgrades a signed-in owner and sends the run as it stands", async () => {
    const runId = await startRun();
    const res = await get(`/api/runs/${runId}/live`, { headers: upgrade });
    expect(res.status).toBe(101);
    const socket = res.webSocket!;
    const first = new Promise<string>((resolve) => {
      socket.addEventListener("message", (event) => resolve(event.data as string));
    });
    socket.accept();
    const message = JSON.parse(await first) as LiveMessage;
    expect(message.type).toBe("snapshot");
    if (message.type !== "snapshot") throw new Error("expected a snapshot");
    expect(message.run.id).toBe(runId);
    socket.close();
  });

  it("404 for a run that never started", async () => {
    const res = await get("/api/runs/no-such-run/live", { headers: upgrade });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });
});

describe("GET /api/live", () => {
  it("426 for a request that is not a websocket upgrade", async () => {
    const res = await get("/api/live");
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({ error: "expected a websocket upgrade" });
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });

  it("upgrades a signed-in owner into the lobby, which sends each run's summary", async () => {
    const res = await get("/api/live", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const socket = res.webSocket!;
    const messages: LobbyMessage[] = [];
    socket.addEventListener("message", (event) => {
      messages.push(JSON.parse(event.data as string) as LobbyMessage);
    });
    socket.accept();
    const runId = await startRun();
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        type: "summary",
        run: expect.objectContaining({ id: runId, status: "on_the_hill" }),
      }),
    );
    socket.close();
  });
});

describe("POST retries", () => {
  const stepRetry = (runId: string) => `/api/runs/${runId}/steps/sweep/retry`;
  const agentRetry = (runId: string) => `/api/runs/${runId}/agents/${AGENT}/retry`;

  // A run whose one agent has failed: its dispatch was refused.
  async function failedRun(): Promise<string> {
    stubGitHub({
      [`POST /repos/aghchan/simplegoapp/actions/workflows/basetobase-agent.yml/dispatches`]: () =>
        new Response(null, { status: 422 }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const runId = await startRun();
    vi.restoreAllMocks();
    return runId;
  }

  it.each([stepRetry, agentRetry])("runs the failed agent again: %s", async (path) => {
    const runId = await failedRun();
    const dispatched = stubGitHub();
    const res = await post(path(runId));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ retried: [AGENT] });
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(dispatched).toMatchObject([{ run_id: runId, agent_id: AGENT }]);
  });

  it("409 when there is nothing to retry", async () => {
    const runId = await startRun();
    for (const path of [stepRetry(runId), agentRetry(runId)]) {
      const res = await post(path);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "nothing to retry" });
    }
  });

  it("404 for a run that never started, or a step there is no such thing as", async () => {
    expect((await post(stepRetry("no-such-run"))).status).toBe(404);
    expect((await post(agentRetry("no-such-run"))).status).toBe(404);
    const runId = await startRun();
    const res = await post(`/api/runs/${runId}/steps/everything/retry`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("401 without a session", async () => {
    const res = await post(stepRetry("r1"), { cookie: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed out" });
  });

  it.each([
    ["another site", "https://evil.example"],
    ["another Worker on the same workers.dev subdomain", "https://other.soulygrail.workers.dev"],
    ["no origin", null],
  ])("403 for a POST from %s, retrying nothing", async (_name, origin) => {
    const runId = await failedRun();
    const dispatched = stubGitHub();
    const res = await post(agentRetry(runId), { origin });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross-origin request" });
    expect(dispatched).toEqual([]);
  });
});
