import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Triage } from "../../shared/src/triage.ts";
import { createApp } from "../src/index.ts";
import { runStub } from "../src/runs/index.ts";
import { agentClaims, agentIdentity, prRef, REJECTED_CLAIMS, stubGitHub } from "./helpers.ts";

const AGENT = "mainline-sweep-0";
const KIB = 1024;
const MIB = 1024 * KIB;
const identity = await agentIdentity();
const app = createApp({ agentKey: identity.getKey });

const triage: Triage = {
  panels: ["backend"],
  rating: "black",
  runName: "Red Dog Face",
  files: 3,
  additions: 120,
  deletions: 10,
};
const event = { seq: 1, ts: 1000, kind: "say", text: "reading the diff" };
const clearVerdict = {
  role: "mainline",
  headSha: "head58",
  status: "clear",
  hazards: [],
  summary: "No functional issues found.",
};

let runCount = 0;
let dispatches: Record<string, string>[];

async function startRun() {
  const runId = `r${++runCount}`;
  const stub = runStub(env, runId);
  await stub.start(prRef(), runId, triage);
  const nonce = dispatches.at(-1)!.nonce!;
  return { runId, stub, nonce, ids: { run_id: runId, agent_id: AGENT, nonce } };
}

interface Call {
  query?: Record<string, string | undefined>;
  json?: unknown;
  body?: BodyInit;
  // The whole header value; null sends none, and left out sends a valid token.
  authorization?: string | null;
}

async function call(method: string, path: string, init: Call = {}): Promise<Response> {
  const url = new URL(`https://b2b.test/agent/${path}`);
  for (const [name, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  const headers = new Headers();
  const authorization =
    init.authorization === undefined
      ? `Bearer ${await identity.token(agentClaims(env.PUBLIC_URL))}`
      : init.authorization;
  if (authorization !== null) headers.set("Authorization", authorization);
  const body = init.json === undefined ? init.body : JSON.stringify(init.json);
  const req = new Request(url, { method, headers, body });
  return app.fetch(req, env, createExecutionContext());
}

const get = (path: string, init?: Call) => call("GET", path, init);
const post = (path: string, json: unknown, init?: Call) => call("POST", path, { ...init, json });

async function viewOf(runId: string) {
  return (await runStub(env, runId).view())!;
}

beforeEach(() => {
  dispatches = stubGitHub();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/agent authentication", () => {
  const routes: [string, string, Call][] = [
    ["GET", "brief", {}],
    ["POST", "events", { json: {} }],
    ["POST", "verdict", { json: {} }],
    ["POST", "failure", { json: {} }],
    ["PUT", "transcript", { body: "{}" }],
  ];

  it.each(routes)("401 without a token on %s /agent/%s", async (method, path, init) => {
    const res = await call(method, path, { ...init, authorization: null });
    expect(res.status).toBe(401);
  });

  it("401 without a token", async () => {
    const { ids } = await startRun();
    expect((await get("brief", { query: ids, authorization: null })).status).toBe(401);
  });

  it.each([
    [
      "a scheme other than Bearer",
      async () => `Basic ${await identity.token(agentClaims(env.PUBLIC_URL))}`,
    ],
    ["a bare token", async () => identity.token(agentClaims(env.PUBLIC_URL))],
    ["an empty bearer", async () => "Bearer "],
    ["garbage", async () => "Bearer not-a-jwt"],
    [
      "a token signed with another key",
      async () => `Bearer ${await (await agentIdentity()).token(agentClaims(env.PUBLIC_URL))}`,
    ],
  ])("401 for %s", async (_name, authorization) => {
    const { ids } = await startRun();
    const res = await get("brief", { query: ids, authorization: await authorization() });
    expect(res.status).toBe(401);
  });

  it.each(REJECTED_CLAIMS)("401 for a token with a wrong %s", async (_name, over) => {
    const { ids } = await startRun();
    const token = await identity.token(agentClaims(env.PUBLIC_URL, over));
    const res = await get("brief", { query: ids, authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
  });

  it("says nothing about which check failed", async () => {
    const { ids } = await startRun();
    const bodies = new Set<string>();
    for (const [, over] of REJECTED_CLAIMS) {
      const token = await identity.token(agentClaims(env.PUBLIC_URL, over));
      const res = await get("brief", { query: ids, authorization: `Bearer ${token}` });
      bodies.add(await res.text());
    }
    bodies.add(await (await get("brief", { query: ids, authorization: null })).text());
    expect([...bodies]).toEqual(['{"error":"unauthorized"}']);
  });

  it("checks the token before looking at the request", async () => {
    const res = await post("events", "not an object", { authorization: null });
    expect(res.status).toBe(401);
  });

  it("404 JSON for an unknown route once authenticated", async () => {
    const res = await get("nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("GET /agent/brief", () => {
  it("brief returns role, model, goal, shas", async () => {
    const { ids } = await startRun();
    const res = await get("brief", { query: ids });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      role: "mainline",
      model: "sonnet",
      baseSha: "base58",
      headSha: "head58",
      prefix: "FUN",
    });
  });

  it("403 on wrong nonce", async () => {
    const { ids } = await startRun();
    expect((await get("brief", { query: { ...ids, nonce: "wrong" } })).status).toBe(403);
  });

  it("403 for another agent's id", async () => {
    const { ids } = await startRun();
    expect((await get("brief", { query: { ...ids, agent_id: "corduroy-sweep-0" } })).status).toBe(
      403,
    );
  });

  it("starts the agent's clocks, linking the job from the verified token", async () => {
    const { runId, ids } = await startRun();
    const token = await identity.token(agentClaims(env.PUBLIC_URL, { run_id: "12345" }));
    const query = { ...ids, jobUrl: "https://evil.example/runs/1" };
    await get("brief", { query, authorization: `Bearer ${token}` });
    const agent = (await viewOf(runId)).run.agents[0]!;
    expect(agent.briefedAt).toEqual(expect.any(Number));
    expect(agent.jobUrl).toBe("https://github.com/aghchan/simplegoapp/actions/runs/12345");
  });

  // The agent's status tells the forwarder what colour the job should end.
  it.each<[string, (ids: Record<string, string>) => Promise<unknown>, string]>([
    ["the run was stopped", (ids) => runStub(env, ids.run_id!).stop("PR closed"), "stopped"],
    [
      "the agent gave its verdict",
      (ids) => post("verdict", { ...ids, verdict: clearVerdict }),
      "clear",
    ],
    ["the agent reported a failure", (ids) => post("failure", { ...ids, reason: "boom" }), "error"],
  ])("410 with the agent's status once %s", async (_ending, end, status) => {
    const { runId, ids } = await startRun();
    await end(ids);
    const before = await viewOf(runId);
    const res = await get("brief", { query: ids });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "no longer wanted", agent: status });
    expect(await viewOf(runId)).toEqual(before);
  });

  it("403 for a run that does not exist, and does not create it", async () => {
    const ids = { run_id: "no-such-run", agent_id: AGENT, nonce: "x" };
    expect((await get("brief", { query: ids })).status).toBe(403);
    expect(await runStub(env, "no-such-run").view()).toBeNull();
  });

  it.each(["run_id", "agent_id", "nonce"])("400 when %s is missing", async (field) => {
    const { ids } = await startRun();
    const res = await get("brief", { query: { ...ids, [field]: undefined } });
    expect(res.status).toBe(400);
  });

  it.each(["run_id", "agent_id", "nonce"])("400 when %s is empty", async (field) => {
    const { ids } = await startRun();
    expect((await get("brief", { query: { ...ids, [field]: "" } })).status).toBe(400);
  });
});

describe("POST /agent/events", () => {
  it("events land in the run log with the job url", async () => {
    const { runId, ids } = await startRun();
    const res = await post("events", { ...ids, events: [event] });
    expect(res.status).toBe(204);
    const v = await viewOf(runId);
    expect(v.run.agents[0]!.jobUrl).toBe("https://github.com/aghchan/simplegoapp/actions/runs/99");
    expect(v.run.agents[0]!.status).toBe("running");
    expect(v.log.filter((line) => line.agentId === AGENT)).toMatchObject([
      { kind: "say", text: "reading the diff", ts: 1000 },
    ]);
  });

  it("takes the job url from the verified token, never the body", async () => {
    const { runId, ids } = await startRun();
    const forged = "https://evil.example/runs/1";
    const token = await identity.token(agentClaims(env.PUBLIC_URL, { run_id: "12345" }));
    const body = { ...ids, events: [event], jobUrl: forged, job_url: forged };
    await post("events", body, { authorization: `Bearer ${token}` });
    const { jobUrl } = (await viewOf(runId)).run.agents[0]!;
    expect(jobUrl).toBe("https://github.com/aghchan/simplegoapp/actions/runs/12345");
  });

  it("keeps only the four event fields", async () => {
    const { runId, ids } = await startRun();
    await post("events", { ...ids, events: [{ ...event, id: 9999, agentId: "corduroy-sweep-0" }] });
    const lines = (await viewOf(runId)).log.filter((line) => line.agentId !== null);
    expect(lines).toMatchObject([{ agentId: AGENT }]);
    expect(lines[0]!.id).not.toBe(9999);
  });

  it("accepts an empty batch", async () => {
    const { ids } = await startRun();
    expect((await post("events", { ...ids, events: [] })).status).toBe(204);
  });

  it("accepts 500 events", async () => {
    const { runId, ids } = await startRun();
    const events = Array.from({ length: 500 }, (_, seq) => ({ ...event, seq }));
    expect((await post("events", { ...ids, events })).status).toBe(204);
    expect((await viewOf(runId)).log.filter((line) => line.agentId === AGENT)).toHaveLength(500);
  });

  it("403 on wrong nonce, logging nothing", async () => {
    const { runId, ids } = await startRun();
    const res = await post("events", { ...ids, nonce: "wrong", events: [event] });
    expect(res.status).toBe(403);
    expect((await viewOf(runId)).log.filter((line) => line.agentId !== null)).toEqual([]);
  });

  it("403 for a run that does not exist, and does not create it", async () => {
    const res = await post("events", { run_id: "ghost", agent_id: AGENT, nonce: "x", events: [] });
    expect(res.status).toBe(403);
    expect(await runStub(env, "ghost").view()).toBeNull();
  });

  describe("validation", () => {
    const bad: [string, unknown][] = [
      ["events that are not an array", { ...event }],
      ["events that are missing", undefined],
      ["501 events", Array.from({ length: 501 }, (_, seq) => ({ ...event, seq }))],
      ["an event that is not an object", ["say"]],
      ["a null event", [null]],
      ["a negative seq", [{ ...event, seq: -1 }]],
      ["a fractional seq", [{ ...event, seq: 1.5 }]],
      ["a string seq", [{ ...event, seq: "1" }]],
      ["a missing seq", [{ ...event, seq: undefined }]],
      ["a string ts", [{ ...event, ts: "1000" }]],
      ["a null ts", [{ ...event, ts: null }]],
      ["an unknown kind", [{ ...event, kind: "shout" }]],
      ["an inherited kind", [{ ...event, kind: "constructor" }]],
      ["a numeric text", [{ ...event, text: 5 }]],
      ["a missing text", [{ ...event, text: undefined }]],
      ["one bad event among good ones", [event, { ...event, seq: 2, kind: "shout" }]],
    ];

    it.each(bad)("400 for %s, logging nothing", async (_name, events) => {
      const { runId, ids } = await startRun();
      const res = await post("events", { ...ids, events });
      expect(res.status).toBe(400);
      expect((await viewOf(runId)).log.filter((line) => line.agentId !== null)).toEqual([]);
    });

    it.each(["system", "say", "tool", "tool_result", "done", "error"])(
      "accepts the kind %s",
      async (kind) => {
        const { ids } = await startRun();
        expect((await post("events", { ...ids, events: [{ ...event, kind }] })).status).toBe(204);
      },
    );

    it.each([
      ["missing", undefined],
      ["a number", 7],
      ["null", null],
      ["an object", {}],
      ["empty", ""],
    ])("400 when run_id is %s", async (_name, value) => {
      const { ids } = await startRun();
      expect((await post("events", { ...ids, run_id: value, events: [] })).status).toBe(400);
    });

    it.each(["agent_id", "nonce"])("400 when %s is not a string", async (field) => {
      const { ids } = await startRun();
      expect((await post("events", { ...ids, [field]: 7, events: [] })).status).toBe(400);
    });

    it.each([
      ["JSON that does not parse", "{nope"],
      ["an empty body", ""],
      ["a JSON array", "[]"],
      ["JSON null", "null"],
      ["a JSON string", '"events"'],
    ])("400 for %s", async (_name, body) => {
      expect((await call("POST", "events", { body })).status).toBe(400);
    });
  });

  describe("size limit", () => {
    it("413 over 256 KiB, logging nothing", async () => {
      const { runId, ids } = await startRun();
      const text = "x".repeat(256 * KIB);
      const res = await post("events", { ...ids, events: [{ ...event, text }] });
      expect(res.status).toBe(413);
      expect((await viewOf(runId)).log.filter((line) => line.agentId !== null)).toEqual([]);
    });

    it("accepts a body just under 256 KiB", async () => {
      const { ids } = await startRun();
      const text = "x".repeat(200 * KIB);
      expect((await post("events", { ...ids, events: [{ ...event, text }] })).status).toBe(204);
    });

    it("413 for a body that never declares its length", async () => {
      const { ids } = await startRun();
      const chunk = new TextEncoder().encode(JSON.stringify({ ...ids, pad: "x".repeat(64 * KIB) }));
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent++ < 8) controller.enqueue(chunk);
          else controller.close();
        },
      });
      const res = await call("POST", "events", { body });
      expect(res.status).toBe(413);
    });
  });
});

describe("POST /agent/verdict", () => {
  it("a valid verdict sweeps the run", async () => {
    const { runId, ids } = await startRun();
    const res = await post("verdict", { ...ids, verdict: clearVerdict });
    expect(res.status).toBe(204);
    expect((await viewOf(runId)).run).toMatchObject({
      status: "swept",
      agents: [{ id: AGENT, status: "clear" }],
    });
  });

  it("422 on invalid verdict", async () => {
    const { runId, ids } = await startRun();
    const res = await post("verdict", { ...ids, verdict: { ...clearVerdict, status: "great" } });
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("status");
    expect((await viewOf(runId)).run.agents[0]).toMatchObject({ status: "error" });
  });

  it("422 when the verdict is missing", async () => {
    const { ids } = await startRun();
    expect((await post("verdict", ids)).status).toBe(422);
  });

  it("403 on wrong nonce, whatever the verdict says", async () => {
    const { runId, ids } = await startRun();
    for (const verdict of [clearVerdict, { nope: 1 }]) {
      const res = await post("verdict", { ...ids, nonce: "wrong", verdict });
      expect(res.status).toBe(403);
    }
    expect((await viewOf(runId)).run.agents[0]).toMatchObject({ status: "dispatched" });
  });

  it("403 for a run that does not exist, and does not create it", async () => {
    const ids = { run_id: "ghost", agent_id: AGENT, nonce: "x" };
    expect((await post("verdict", { ...ids, verdict: clearVerdict })).status).toBe(403);
    expect(await runStub(env, "ghost").view()).toBeNull();
  });

  it("400 when a field is not a string", async () => {
    const { ids } = await startRun();
    expect((await post("verdict", { ...ids, agent_id: 3, verdict: clearVerdict })).status).toBe(
      400,
    );
  });
});

describe("POST /agent/failure", () => {
  it("fails the agent with the reason", async () => {
    const { runId, ids } = await startRun();
    const res = await post("failure", { ...ids, reason: "claude exited without a verdict" });
    expect(res.status).toBe(204);
    expect((await viewOf(runId)).run.agents[0]).toMatchObject({
      status: "error",
      summary: "claude exited without a verdict",
    });
  });

  it("keeps the first 500 characters of the reason", async () => {
    const { runId, ids } = await startRun();
    await post("failure", { ...ids, reason: "a".repeat(499) + "bc" });
    expect((await viewOf(runId)).run.agents[0]!.summary).toBe("a".repeat(499) + "b");
  });

  it.each([
    ["missing", undefined],
    ["a number", 5],
    ["null", null],
    ["an array", ["boom"]],
  ])("400 when the reason is %s", async (_name, reason) => {
    const { runId, ids } = await startRun();
    expect((await post("failure", { ...ids, reason })).status).toBe(400);
    expect((await viewOf(runId)).run.agents[0]!.status).toBe("dispatched");
  });

  it("403 on wrong nonce", async () => {
    const { runId, ids } = await startRun();
    const res = await post("failure", { ...ids, nonce: "wrong", reason: "boom" });
    expect(res.status).toBe(403);
    expect((await viewOf(runId)).run.agents[0]!.status).toBe("dispatched");
  });
});

// 410 tells the forwarder to stop claude: nothing it sends will be used.
describe("reports the run no longer wants", () => {
  const reports: [string, string, Record<string, unknown>][] = [
    ["events", "events", { events: [event] }],
    ["a verdict", "verdict", { verdict: clearVerdict }],
    ["an invalid verdict", "verdict", { verdict: { nope: 1 } }],
    ["a failure", "failure", { reason: "boom" }],
  ];

  it.each(reports)("410 for %s once the run was stopped, changing nothing", async (...report) => {
    const [, path, fields] = report;
    const { runId, ids, stub } = await startRun();
    await stub.stop("PR closed");
    const before = await viewOf(runId);
    const res = await post(path, { ...ids, ...fields });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "no longer wanted", agent: "stopped" });
    expect(await viewOf(runId)).toEqual(before);
  });

  it.each(reports)("410 for %s once the agent gave its verdict", async (...report) => {
    const [, path, fields] = report;
    const { runId, ids } = await startRun();
    await post("verdict", { ...ids, verdict: clearVerdict });
    const before = await viewOf(runId);
    const res = await post(path, { ...ids, ...fields });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "no longer wanted", agent: "clear" });
    expect(await viewOf(runId)).toEqual(before);
  });

  it.each(reports)("410 for %s once the agent reported a failure", async (...report) => {
    const [, path, fields] = report;
    const { ids } = await startRun();
    await post("failure", { ...ids, reason: "claude exited 1" });
    const res = await post(path, { ...ids, ...fields });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "no longer wanted", agent: "error" });
  });

  it.each(reports)("still 403 for %s with a wrong nonce", async (...report) => {
    const [, path, fields] = report;
    const { ids, stub } = await startRun();
    await stub.stop("PR closed");
    expect((await post(path, { ...ids, ...fields, nonce: "wrong" })).status).toBe(403);
  });

  it.each(reports)("still 401 for %s without a token", async (...report) => {
    const [, path, fields] = report;
    const { ids, stub } = await startRun();
    await stub.stop("PR closed");
    expect((await post(path, { ...ids, ...fields }, { authorization: null })).status).toBe(401);
  });
});

describe("PUT /agent/transcript", () => {
  const body = '{"type":"assistant"}\n{"type":"result"}\n';
  const stored = (runId: string) => env.TRANSCRIPTS.get(`runs/${runId}/${AGENT}.jsonl`);

  it("transcript stored in KV and flagged", async () => {
    const { runId, ids } = await startRun();
    const res = await call("PUT", "transcript", { query: ids, body });
    expect(res.status).toBe(204);
    expect(await stored(runId)).toBe(body);
    expect((await viewOf(runId)).run.agents[0]!.hasTranscript).toBe(true);
  });

  it("keeps the transcript for 30 days", async () => {
    const { runId, ids } = await startRun();
    const before = Math.floor(Date.now() / 1000);
    await call("PUT", "transcript", { query: ids, body });
    const { keys } = await env.TRANSCRIPTS.list({ prefix: `runs/${runId}/` });
    expect(keys).toHaveLength(1);
    expect(keys[0]!.expiration).toBeGreaterThanOrEqual(before + 30 * 24 * 3600);
    expect(keys[0]!.expiration).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000) + 30 * 24 * 3600);
  });

  it("stores the transcript of a run that was stopped", async () => {
    const { runId, ids, stub } = await startRun();
    await stub.stop("PR closed");
    expect((await call("PUT", "transcript", { query: ids, body })).status).toBe(204);
    expect(await stored(runId)).toBe(body);
    expect((await viewOf(runId)).run.agents[0]).toMatchObject({
      status: "stopped",
      hasTranscript: true,
    });
  });

  it("stores the transcript of an agent that has already reported", async () => {
    const { runId, ids } = await startRun();
    await post("verdict", { ...ids, verdict: clearVerdict });
    expect((await call("PUT", "transcript", { query: ids, body })).status).toBe(204);
    expect((await viewOf(runId)).run.agents[0]!.hasTranscript).toBe(true);
  });

  it("replaces an earlier upload", async () => {
    const { runId, ids } = await startRun();
    await call("PUT", "transcript", { query: ids, body: "first\n" });
    await call("PUT", "transcript", { query: ids, body });
    expect(await stored(runId)).toBe(body);
  });

  it("403 on wrong nonce, writing nothing", async () => {
    const { runId, ids } = await startRun();
    const res = await call("PUT", "transcript", { query: { ...ids, nonce: "wrong" }, body });
    expect(res.status).toBe(403);
    expect(await stored(runId)).toBeNull();
    expect((await viewOf(runId)).run.agents[0]!.hasTranscript).toBe(false);
  });

  it("403 for a run that does not exist, writing nothing and not creating it", async () => {
    const ids = { run_id: "ghost", agent_id: AGENT, nonce: "x" };
    expect((await call("PUT", "transcript", { query: ids, body })).status).toBe(403);
    expect(await stored("ghost")).toBeNull();
    expect(await runStub(env, "ghost").view()).toBeNull();
  });

  it.each(["run_id", "agent_id", "nonce"])("400 when %s is missing", async (field) => {
    const { ids } = await startRun();
    const res = await call("PUT", "transcript", { query: { ...ids, [field]: undefined }, body });
    expect(res.status).toBe(400);
  });

  // 25 MiB is also the most a KV value may hold.
  it("accepts a transcript of exactly 25 MiB", async () => {
    const { runId, ids } = await startRun();
    const res = await call("PUT", "transcript", { query: ids, body: new Uint8Array(25 * MIB) });
    expect(res.status).toBe(204);
    const value = await env.TRANSCRIPTS.get(`runs/${runId}/${AGENT}.jsonl`, "arrayBuffer");
    expect(value!.byteLength).toBe(25 * MIB);
  });

  it("413 over 25 MiB, writing nothing and flagging nothing", async () => {
    const { runId, ids } = await startRun();
    const res = await call("PUT", "transcript", {
      query: ids,
      body: new Uint8Array(25 * MIB + 1),
    });
    expect(res.status).toBe(413);
    expect(await stored(runId)).toBeNull();
    expect((await viewOf(runId)).run.agents[0]!.hasTranscript).toBe(false);
  });
});
