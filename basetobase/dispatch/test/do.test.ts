import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Triage } from "../../shared/src/triage.ts";
import type { AgentEvent, LiveMessage } from "../../shared/src/types.ts";
import { runStub, listOwedDesigns, listRuns } from "../src/runs/index.ts";
import { AGENT_TIMEOUT_MS, JOB_START_MS, STALL_MS, type RunState } from "../src/run/machine.ts";
import { fakeFetch, prRef } from "./helpers.ts";
import { addGraniteChief } from "./seed.ts";

const AGENT = "mainline-sweep-0";
const JOB_URL = "https://github.com/aghchan/simplegoapp/actions/runs/99";
const JOB = { githubRunId: "99", jobUrl: JOB_URL };
const DISPATCH_PATH =
  "/repos/aghchan/simplegoapp/actions/workflows/basetobase-agent.yml/dispatches";
const CANCEL_PATH = "/repos/aghchan/simplegoapp/actions/runs/99/cancel";

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
const hazardVerdict = {
  ...clearVerdict,
  status: "hazards",
  hazards: [{ id: "FUN-1", title: "Cancel skips the owner check", detail: "d" }],
};

const CHECKS_PATH = "/repos/aghchan/simplegoapp/check-runs";
const CHECK_ID = 501;
// The check run a repost creates.
const NEW_CHECK_ID = 502;

let runCount = 0;
let dispatches: { ref: string; inputs: Record<string, string> }[];
let checks: { method: string; body: Record<string, unknown> }[];
// The check runs updated, by id, in order.
let patched: number[];
// How GitHub answers each check-run call; a test replaces it to fail or hold one.
let checkReply: (method: string) => Response | Promise<Response>;
let cancels: number;
let cancelReply: () => Response;

const acceptCheck = (method: string) =>
  method === "POST"
    ? Response.json({ id: CHECK_ID }, { status: 201 })
    : Response.json({ id: CHECK_ID });

// The body is recorded inside the route: a Request made in the Durable Object can't be read here.
function stubGitHub(
  respond: () => Response | Promise<Response> = () => new Response(null, { status: 204 }),
): void {
  const recordCheck = (method: string, id?: number) => async (req: Request) => {
    checks.push({ method, body: await req.json() });
    if (id !== undefined) patched.push(id);
    return checkReply(method);
  };
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
    [`POST ${CHECKS_PATH}`]: recordCheck("POST"),
    [`PATCH ${CHECKS_PATH}/${CHECK_ID}`]: recordCheck("PATCH", CHECK_ID),
    [`PATCH ${CHECKS_PATH}/${NEW_CHECK_ID}`]: recordCheck("PATCH", NEW_CHECK_ID),
    [`POST ${CANCEL_PATH}`]: () => {
      cancels++;
      return cancelReply();
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

// Holds the run's D1 writes until `release` settles.
async function holdIndexWrites(stub: Stub, release: Promise<void>): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const real = Reflect.get(instance, "env") as Env;
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            await release;
            return real.DB.prepare(sql).bind(...values).run();
          },
        }),
      }),
    } as unknown as D1Database;
    Object.defineProperty(instance, "env", { value: { ...real, DB: db } });
  });
}

type Clock = "dispatchedAt" | "briefedAt" | "lastEventAt";

// Sets the agent's clocks `ms` back from now and fires the alarm.
async function backdate(stub: Stub, clocks: Clock[], ms: number): Promise<boolean> {
  await runInDurableObject(stub, async (_instance, state) => {
    const run = (await state.storage.get<RunState>("state"))!;
    const at = Date.now() - ms;
    const old = run.agents.map((agent) => ({
      ...agent,
      ...Object.fromEntries(clocks.map((clock) => [clock, at])),
    }));
    await state.storage.put("state", { ...run, agents: old });
  });
  return runDurableObjectAlarm(stub);
}

// Briefs the agent and backdates the brief past the timeout, whose alarm fails it.
async function timeOut(stub: Stub, nonce: string): Promise<void> {
  await stub.brief(AGENT, nonce, JOB);
  await backdate(stub, ["briefedAt"], AGENT_TIMEOUT_MS + 1);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM runs").run();
  dispatches = [];
  checks = [];
  patched = [];
  checkReply = acceptCheck;
  cancels = 0;
  cancelReply = () => new Response(null, { status: 202 });
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
        expect(await stub.brief(AGENT, bad, JOB)).toBe("forbidden");
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
          expect(await stub.brief(agentId, attempt, JOB)).toBe("forbidden");
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
      expect(await stub.brief(AGENT, nonce, JOB)).toEqual({ gone: "clear" });
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
      expect(await stub.brief(AGENT, nonce, JOB)).toMatchObject({
        role: "mainline",
        model: "sonnet",
        prefix: "FUN",
        prNumber: 58,
        baseSha: "base58",
        headSha: "head58",
      });
    });

    it("starts the agent's clocks and records its job", async () => {
      const { stub, nonce } = await startRun();
      const before = Date.now();
      await stub.brief(AGENT, nonce, JOB);
      const { run, alarm } = await storedState(stub);
      const agent = run.agents[0]!;
      expect(agent.briefedAt).toBeGreaterThanOrEqual(before);
      expect(agent.jobUrl).toBe(JOB_URL);
      expect(run.jobRuns).toEqual({ [AGENT]: "99" });
      expect(alarm).toBe(agent.briefedAt! + STALL_MS);
      expect((await stub.view())!.run.agents[0]).not.toHaveProperty("jobRuns");
    });

    it("restarts the clocks for a re-run of the job", async () => {
      const { stub, nonce } = await startRun();
      await stub.brief(AGENT, nonce, JOB);
      await stub.events(AGENT, nonce, evs, JOB_URL);
      // The first attempt went quiet nine minutes ago: a minute short of a stall.
      await backdate(stub, ["briefedAt", "lastEventAt"], STALL_MS - 60_000);
      await stub.brief(AGENT, nonce, JOB);
      const { run, alarm } = await storedState(stub);
      expect(run.agents[0]).not.toHaveProperty("lastEventAt");
      expect(alarm).toBe(run.agents[0]!.briefedAt! + STALL_MS);
      expect(alarm).toBeGreaterThan(Date.now() + STALL_MS - 60_000);
    });

    it.each<[string, (stub: Stub, nonce: string) => Promise<unknown>, string]>([
      ["the run is stopped", (stub) => stub.stop("PR closed"), "stopped"],
      [
        "the agent gave its verdict",
        (stub, nonce) => stub.verdict(AGENT, nonce, clearVerdict),
        "clear",
      ],
      ["the agent failed", (stub, nonce) => stub.failure(AGENT, nonce, "boom"), "error"],
    ])("is refused once %s, with the agent's status", async (_ending, end, status) => {
      const { stub, nonce } = await startRun();
      await end(stub, nonce);
      const before = await stub.view();
      expect(await stub.brief(AGENT, nonce, JOB)).toEqual({ gone: status });
      expect(await stub.view()).toEqual(before);
      expect((await storedState(stub)).run.jobRuns).toBeUndefined();
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

    // The job's failure step reports for a job that never asked for its brief.
    it("links the job that reported it", async () => {
      const { stub, nonce } = await startRun();
      await stub.failure(AGENT, nonce, "job failed before the agent reported", JOB_URL);
      const [agent] = (await stub.view())!.run.agents;
      expect(agent).toMatchObject({ status: "error", jobUrl: JOB_URL });
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
    // Each with the status the agent was left in, which decides the colour of its job.
    const endings: [string, Call, string][] = [
      ["the run was stopped", (stub) => stub.stop("PR closed"), "stopped"],
      [
        "the agent gave its verdict",
        (stub, nonce) => stub.verdict(AGENT, nonce, clearVerdict),
        "clear",
      ],
      [
        "the agent gave a verdict with hazards",
        (stub, nonce) => stub.verdict(AGENT, nonce, hazardVerdict),
        "hazards",
      ],
      [
        "the agent reported a failure",
        (stub, nonce) => stub.failure(AGENT, nonce, "exited 1"),
        "error",
      ],
      ["the agent timed out", (stub, nonce) => timeOut(stub, nonce), "error"],
      ["the PR merged", (stub) => stub.land("abc1234def"), "stopped"],
    ];

    describe.each(endings)("once %s", (_ending, end, status) => {
      it.each(reports)("answers %s with gone and changes nothing", async (_report, send) => {
        const { stub, nonce } = await startRun();
        await end(stub, nonce);
        const before = await stub.view();
        expect(await send(stub, nonce)).toEqual({ gone: status });
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

    it("stops a swept run, leaving its check as the sweep concluded it", async () => {
      const { stub, nonce } = await startRun();
      await stub.verdict(AGENT, nonce, hazardVerdict);
      await stub.stop("superseded by head59");
      const view = (await stub.view())!;
      expect(view.run).toMatchObject({ status: "stopped", outcome: "hazards" });
      expect(view.log.at(-1)).toMatchObject({ text: "stopped · superseded by head59" });
      expect(await listRuns(env.DB)).toMatchObject([{ status: "stopped", outcome: "hazards" }]);
      expect(checks.map((check) => check.method)).toEqual(["POST", "PATCH"]);
      expect(checks[1]).toMatchObject({ body: { conclusion: "failure" } });
    });

    it("cancels the job of an agent still out", async () => {
      const { stub, nonce } = await startRun();
      await stub.brief(AGENT, nonce, JOB);
      await stub.stop("PR closed");
      expect(cancels).toBe(1);
    });

    it("cancels nothing for an agent whose job never started", async () => {
      const { stub } = await startRun();
      await stub.stop("PR closed");
      expect(cancels).toBe(0);
    });

    it("takes a job that had already finished as cancelled", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      cancelReply = () => new Response(null, { status: 409 });
      const { stub, nonce } = await startRun();
      await stub.brief(AGENT, nonce, JOB);
      await stub.stop("PR closed");
      expect(cancels).toBe(1);
      expect(consoleError).not.toHaveBeenCalled();
    });

    // A job the cancel misses stops on the 410 its next report gets.
    it("logs a cancel GitHub refuses and does not retry it", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      cancelReply = () => new Response("leaky response body", { status: 500 });
      const { stub, nonce } = await startRun();
      await stub.brief(AGENT, nonce, JOB);
      await stub.stop("PR closed");
      expect((await stub.view())!.run.status).toBe("stopped");
      expect(consoleError).toHaveBeenCalledOnce();
      const logged = String(consoleError.mock.calls[0]![0]);
      expect(logged).toContain(`GitHub POST ${CANCEL_PATH} failed with status 500`);
      expect(logged).not.toContain("leaky");
      expect((await storedState(stub)).alarm).toBeNull();
      await stub.view();
      expect(cancels).toBe(1);
    });
  });

  describe("land", () => {
    it("lands a swept run on the merge commit and indexes it", async () => {
      const { stub, nonce } = await startRun();
      await stub.verdict(AGENT, nonce, clearVerdict);
      await stub.land("abc1234def");
      const view = (await stub.view())!;
      expect(view.run).toMatchObject({
        status: "landed",
        mergeSha: "abc1234def",
        outcome: "clear",
      });
      expect(view.log.at(-1)).toMatchObject({ text: "landed · merged as abc1234" });
      expect(await listRuns(env.DB)).toMatchObject([{ status: "landed", outcome: "clear" }]);
    });

    it("leaves the check of a finished review as it was", async () => {
      const { stub, nonce } = await startRun();
      await stub.verdict(AGENT, nonce, clearVerdict);
      await stub.land("abc1234def");
      expect(checks.map((check) => check.method)).toEqual(["POST", "PATCH"]);
    });

    it("ends the check and cancels the job when merged mid-review", async () => {
      const { stub, nonce } = await startRun();
      await stub.brief(AGENT, nonce, JOB);
      await stub.land("abc1234def");
      expect(checks.at(-1)).toMatchObject({
        method: "PATCH",
        body: {
          status: "completed",
          conclusion: "cancelled",
          output: { title: "Merged before the review finished" },
        },
      });
      expect(cancels).toBe(1);
      expect((await storedState(stub)).alarm).toBeNull();
    });

    it("does nothing the second time", async () => {
      const { stub, nonce } = await startRun();
      await stub.verdict(AGENT, nonce, clearVerdict);
      await stub.land("abc1234def");
      const before = await stub.view();
      await stub.land("abc1234def");
      expect(await stub.view()).toEqual(before);
    });
  });

  describe("retry", () => {
    // The run's agent fails its first attempt, as a job that died before it reported does.
    async function failedRun() {
      const run = await startRun();
      await run.stub.brief(AGENT, run.nonce, JOB);
      await run.stub.events(AGENT, run.nonce, evs, JOB_URL);
      await run.stub.failure(AGENT, run.nonce, "job failed before the agent reported");
      return run;
    }

    it("dispatches the failed agent again with a fresh nonce, and reopens the run", async () => {
      const { stub, nonce } = await failedRun();
      expect(await stub.retry({ agentId: AGENT })).toEqual([AGENT]);
      expect(dispatches).toHaveLength(2);
      const fresh = dispatches[1]!.inputs.nonce;
      expect(fresh).not.toBe(nonce);
      expect(dispatches[1]!.inputs).toMatchObject({ agent_id: AGENT, sha: "head58" });
      const { run } = (await stub.view())!;
      expect(run).toMatchObject({ status: "on_the_hill", outcome: "pending" });
      expect(run.agents[0]).toMatchObject({ status: "dispatched", retries: 1 });
      expect((await listRuns(env.DB))[0]).toMatchObject({
        status: "on_the_hill",
        outcome: "pending",
      });
    });

    it("cancels the failed attempt's job", async () => {
      const { stub } = await failedRun();
      await stub.retry({ step: "sweep" });
      expect(cancels).toBe(1);
    });

    it("refuses the old job's nonce from then on", async () => {
      const { stub, nonce } = await failedRun();
      await stub.retry({ agentId: AGENT });
      expect(await stub.brief(AGENT, nonce, JOB)).toBe("forbidden");
      expect(await stub.verdict(AGENT, nonce, clearVerdict)).toBe("forbidden");
      expect(await stub.checkNonce(AGENT, nonce)).toBe(false);
    });

    it("keeps the new attempt's events beside the failed one's, both counting from 1", async () => {
      const { stub } = await failedRun();
      await stub.retry({ agentId: AGENT });
      const fresh = dispatches[1]!.inputs.nonce!;
      await stub.brief(AGENT, fresh, JOB);
      await stub.events(AGENT, fresh, [{ ...evs[0]!, text: "reading it again" }], JOB_URL);
      const lines = (await stub.view())!.log.filter((line) => line.agentId === AGENT);
      expect(lines.map((line) => line.text)).toEqual([
        "reading the diff",
        "Read orders.go",
        "reading it again",
      ]);
    });

    it("posts a fresh check that the retried agent's verdict concludes", async () => {
      let next = CHECK_ID;
      checkReply = (method) =>
        method === "POST" ? Response.json({ id: next++ }, { status: 201 }) : acceptCheck(method);
      const { stub } = await failedRun();
      expect(checks.at(-1)).toMatchObject({ method: "PATCH", body: { conclusion: "failure" } });
      await stub.retry({ agentId: AGENT });
      expect(checks.slice(-2)).toEqual([
        { method: "POST", body: expect.objectContaining({ status: "in_progress" }) },
        { method: "PATCH", body: expect.objectContaining({ conclusion: "skipped" }) },
      ]);
      const fresh = dispatches[1]!.inputs.nonce!;
      expect(await stub.verdict(AGENT, fresh, clearVerdict)).toBe("accepted");
      expect(patched.at(-1)).toBe(NEW_CHECK_ID);
      expect(checks.at(-1)).toMatchObject({ method: "PATCH", body: { conclusion: "success" } });
    });

    it("retries nothing for an agent that did not fail, or a run that has stopped", async () => {
      const { stub, nonce } = await startRun();
      expect(await stub.retry({ step: "sweep" })).toEqual([]);
      await stub.failure(AGENT, nonce, "boom");
      await stub.stop("PR closed");
      expect(await stub.retry({ agentId: AGENT })).toEqual([]);
      expect(dispatches).toHaveLength(1);
    });

    it("is null for a run that never started", async () => {
      expect(await runStub(env, "never-started").retry({ step: "sweep" })).toBeNull();
    });
  });

  describe("bypassDesign", () => {
    // A run whose sweep is out only on Mainline, with Granite Chief's missing-design finding in,
    // which Mainline's clear verdict then closes into a failed review.
    async function missingDesignRun() {
      const run = await startRun();
      await addGraniteChief(run.stub);
      await run.stub.brief(AGENT, run.nonce, JOB);
      await run.stub.verdict(AGENT, run.nonce, clearVerdict);
      return run;
    }

    // The bypass time the run's D1 row holds.
    async function indexedBypass(runId: string): Promise<number | null | undefined> {
      const row = await env.DB.prepare("SELECT design_bypassed_at AS at FROM runs WHERE id = ?")
        .bind(runId)
        .first<{ at: number | null }>();
      return row?.at;
    }

    it("waives the finding, reposts the check as a success and indexes the bypass", async () => {
      let next = CHECK_ID;
      checkReply = (method) =>
        method === "POST" ? Response.json({ id: next++ }, { status: 201 }) : acceptCheck(method);
      const { id, stub } = await missingDesignRun();
      expect(checks.at(-1)).toMatchObject({ method: "PATCH", body: { conclusion: "failure" } });
      expect((await stub.view())!.run).toMatchObject({ status: "swept", outcome: "hazards" });
      const before = checks.length;

      expect(await stub.bypassDesign()).toBe(true);

      expect(checks.slice(before)).toEqual([
        {
          method: "POST",
          body: expect.objectContaining({
            head_sha: "head58",
            status: "completed",
            conclusion: "success",
          }),
        },
        { method: "PATCH", body: expect.objectContaining({ conclusion: "skipped" }) },
      ]);
      expect(patched.at(-1)).toBe(CHECK_ID);
      const { run, log } = (await stub.view())!;
      expect(run).toMatchObject({ status: "swept", outcome: "clear" });
      expect(run.designBypassedAt).toBeTypeOf("number");
      expect(log.at(-1)).toMatchObject({ kind: "system", text: "design bypassed by the owner" });

      expect(await indexedBypass(id)).toBe(run.designBypassedAt);
      expect(await listOwedDesigns(env.DB)).toMatchObject([{ runId: id, prNumber: 58 }]);
    });

    it("waives it while the sweep is out, so the check closes clear with it", async () => {
      const { stub, nonce } = await startRun();
      await addGraniteChief(stub);
      expect(await stub.bypassDesign()).toBe(true);
      expect((await stub.view())!.run).toMatchObject({ status: "on_the_hill", outcome: "pending" });
      await stub.verdict(AGENT, nonce, clearVerdict);
      expect((await stub.view())!.run).toMatchObject({ status: "swept", outcome: "clear" });
      expect(checks.at(-1)).toMatchObject({ method: "PATCH", body: { conclusion: "success" } });
    });

    it("is false the second time, changing nothing", async () => {
      const { stub } = await missingDesignRun();
      expect(await stub.bypassDesign()).toBe(true);
      const view = await stub.view();
      const posted = checks.length;
      expect(await stub.bypassDesign()).toBe(false);
      expect(await stub.view()).toEqual(view);
      expect(checks).toHaveLength(posted);
    });

    // Nothing to waive: no finding, Granite Chief not yet reported, or a run that no longer
    // speaks for its PR.
    it.each<[string, (run: Awaited<ReturnType<typeof startRun>>) => Promise<void>]>([
      ["Granite Chief has found nothing", async () => {}],
      [
        "Granite Chief has not reported",
        async ({ stub }) =>
          addGraniteChief(stub, { status: "running", hazards: [], finishedAt: undefined }),
      ],
      [
        "Granite Chief found a different hazard",
        async ({ stub }) =>
          addGraniteChief(stub, { hazards: [{ id: "DES-2", title: "Wrong design", detail: "d" }] }),
      ],
      [
        "the run has stopped",
        async ({ stub }) => {
          await addGraniteChief(stub);
          await stub.stop("PR closed");
        },
      ],
      [
        "the run has landed",
        async ({ stub }) => {
          await addGraniteChief(stub);
          await stub.land("abc1234def");
        },
      ],
    ])("is false, changing nothing, when %s", async (_name, setUp) => {
      const run = await startRun();
      await setUp(run);
      const view = await run.stub.view();
      const stored = await storedState(run.stub);
      const posted = checks.length;
      expect(await run.stub.bypassDesign()).toBe(false);
      expect(await run.stub.view()).toEqual(view);
      expect((await storedState(run.stub)).run).toEqual(stored.run);
      expect(checks).toHaveLength(posted);
      expect(await indexedBypass(run.id)).toBeNull();
    });

    it("is null for a run that never started", async () => {
      expect(await runStub(env, "never-started").bypassDesign()).toBeNull();
    });
  });

  describe("retitle", () => {
    it("retitles the run and its index row, keeping the goal", async () => {
      const { stub } = await startRun();
      const { goal } = (await stub.view())!.run;
      await stub.retitle("orders: cancel endpoint");
      expect((await stub.view())!.run).toMatchObject({ prTitle: "orders: cancel endpoint", goal });
      expect(await listRuns(env.DB)).toMatchObject([{ prTitle: "orders: cancel endpoint" }]);
    });
  });

  describe("alarm", () => {
    it("is set when the run starts, for the job to start", async () => {
      const { stub } = await startRun();
      const { run, alarm } = await storedState(stub);
      expect(alarm).toBe(run.agents[0]!.dispatchedAt! + JOB_START_MS);
    });

    it("moves with the agent's last event", async () => {
      const { stub, nonce } = await startRun();
      await stub.brief(AGENT, nonce, JOB);
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
      const { stub, nonce } = await startRun();
      await stub.brief(AGENT, nonce, JOB);
      expect(await backdate(stub, ["briefedAt"], STALL_MS + 1)).toBe(true);
      const { run, alarm } = await storedState(stub);
      expect(run.agents[0]?.status).toBe("stalled");
      expect(alarm).toBe(run.agents[0]!.briefedAt! + AGENT_TIMEOUT_MS);
    });

    it("times out an agent that never finishes", async () => {
      const { stub, nonce } = await startRun();
      await timeOut(stub, nonce);
      const view = (await stub.view())!;
      expect(view.run.agents[0]).toMatchObject({ status: "error", summary: "timed out" });
      expect(view.run.status).toBe("swept");
      expect((await listRuns(env.DB))[0]?.status).toBe("swept");
      expect((await storedState(stub)).alarm).toBeNull();
    });

    it("fails an agent whose job never started on GitHub", async () => {
      const { stub } = await startRun();
      await backdate(stub, ["dispatchedAt"], JOB_START_MS + 1);
      const view = (await stub.view())!;
      expect(view.run.agents[0]).toMatchObject({
        status: "error",
        summary: "job never started on GitHub",
      });
      expect(checks.at(-1)).toMatchObject({ body: { conclusion: "failure" } });
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
      expect(await stub.verdict(AGENT, nonce, clearVerdict)).toEqual({ gone: "clear" });
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

    it("retries a failed first write when the dispatch result comes in", async () => {
      const id = `r${++runCount}`;
      const stub = runStub(env, id);
      await failIndexWrites(stub, 1);
      await stub.start(prRef(), id, triage);
      expect(await indexedStatus()).toBe("on_the_hill");
    });

    it("keeps retrying a failing first write, then returns to the machine's deadline", async () => {
      const id = `r${++runCount}`;
      const stub = runStub(env, id);
      // The first write, then its retry when the dispatch result comes in.
      await failIndexWrites(stub, 2);
      await stub.start(prRef(), id, triage);
      expect(await listRuns(env.DB)).toEqual([]);
      const pending = await storedState(stub);
      expect(pending.alarm).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(pending.alarm).toBeLessThan(pending.run.agents[0]!.dispatchedAt! + JOB_START_MS);

      await stub.view();
      expect(await indexedStatus()).toBe("on_the_hill");
      const settled = await storedState(stub);
      expect(settled.alarm).toBe(settled.run.agents[0]!.dispatchedAt! + JOB_START_MS);
    });
  });

  // A reset can come between storing a change and making the writes it owes.
  describe("owed writes", () => {
    const marks = (stub: Stub) =>
      runInDurableObject(stub, async (_instance, state) => ({
        index: await state.storage.get("indexPending"),
        check: await state.storage.get("checkPending"),
        alarm: await state.storage.getAlarm(),
      }));

    it("are stored with the change, and the retry alarm set, before any is made", async () => {
      const { stub, nonce } = await startRun();
      const release = deferred<void>();
      await holdIndexWrites(stub, release.promise);
      const verdict = stub.verdict(AGENT, nonce, clearVerdict);
      await vi.waitFor(async () => expect((await storedState(stub)).run.status).toBe("swept"));
      const owed = await marks(stub);
      expect(owed.index).toBeDefined();
      expect(owed.check).toBe(owed.index);
      expect(owed.alarm).toBeLessThanOrEqual(Date.now() + 60_000);
      release.resolve();
      expect(await verdict).toBe("accepted");
      expect(await marks(stub)).toEqual({ index: undefined, check: undefined, alarm: null });
    });

    it("keep the check's mark until GitHub has taken the write", async () => {
      const { stub, nonce } = await startRun();
      const release = deferred<void>();
      checkReply = async (method) => {
        if (method === "PATCH") await release.promise;
        return acceptCheck(method);
      };
      const verdict = stub.verdict(AGENT, nonce, clearVerdict);
      await vi.waitFor(() => expect(checks).toHaveLength(2));
      expect((await marks(stub)).check).toBeDefined();
      release.resolve();
      await verdict;
      expect((await marks(stub)).check).toBeUndefined();
    });

    it("left behind by a reset are made by the alarm", async () => {
      const { stub } = await startRun();
      await runInDurableObject(stub, async (_instance, state) => {
        const run = (await state.storage.get<RunState>("state"))!;
        await state.storage.put({
          state: { ...run, prTitle: "orders: cancel endpoint" },
          indexPending: "lost",
          checkPending: "lost",
        });
        await state.storage.setAlarm(Date.now() + 60_000);
      });
      await runDurableObjectAlarm(stub);
      expect(await listRuns(env.DB)).toMatchObject([{ prTitle: "orders: cancel endpoint" }]);
      expect(checks.map((check) => check.method)).toEqual(["POST", "PATCH"]);
      const owed = await marks(stub);
      expect(owed).toMatchObject({ index: undefined, check: undefined });
      const { dispatchedAt } = (await storedState(stub)).run.agents[0]!;
      expect(owed.alarm).toBe(dispatchedAt! + JOB_START_MS);
    });

    it("do not hold a caller up behind a check write GitHub is slow to take", async () => {
      const { stub, nonce } = await startRun();
      const release = deferred<void>();
      checkReply = async (method) => {
        if (method === "PATCH") await release.promise;
        return acceptCheck(method);
      };
      const failure = stub.failure(AGENT, nonce, "boom");
      await vi.waitFor(() => expect(checks).toHaveLength(2));
      expect(await stub.view()).toMatchObject({ run: { status: "swept" } });
      release.resolve();
      await failure;
    });
  });

  describe("check run", () => {
    let consoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    const storedCheckId = async (stub: Stub) => (await storedState(stub)).run.checkRunId;

    it("is created in progress on the run's head, then updated as the run ends", async () => {
      const { id, stub, nonce } = await startRun();
      expect(checks).toEqual([
        {
          method: "POST",
          body: {
            name: "Base to Base",
            head_sha: "head58",
            details_url: `${env.PUBLIC_URL}/runs/${id}`,
            status: "in_progress",
            output: {
              title: "Red Dog Face · patrol sweep",
              summary: expect.stringContaining("0 of 1 patroller in"),
            },
          },
        },
      ]);
      expect(await storedCheckId(stub)).toBe(CHECK_ID);

      await stub.verdict(AGENT, nonce, clearVerdict);
      expect(checks).toHaveLength(2);
      expect(checks[1]).toMatchObject({
        method: "PATCH",
        body: { status: "completed", conclusion: "success", output: { title: "All clear" } },
      });
      expect(checks[1]!.body).not.toHaveProperty("head_sha");
      expect(consoleError).not.toHaveBeenCalled();
    });

    it("fails the check on hazards", async () => {
      const { stub, nonce } = await startRun();
      const hazard = { id: "FUN-1", title: "Cancel skips the owner check", detail: "d" };
      await stub.verdict(AGENT, nonce, { ...clearVerdict, status: "hazards", hazards: [hazard] });
      expect(checks.at(-1)).toMatchObject({
        method: "PATCH",
        body: { conclusion: "failure", output: { title: "1 hazard flagged" } },
      });
    });

    it("gives the check, the snapshot and the index row the same outcome", async () => {
      const { id, stub, nonce } = await startRun();
      const hazard = { id: "FUN-1", title: "Cancel skips the owner check", detail: "d" };
      await stub.verdict(AGENT, nonce, { ...clearVerdict, status: "hazards", hazards: [hazard] });
      expect(checks.at(-1)).toMatchObject({ body: { conclusion: "failure" } });
      expect((await stub.view())!.run.outcome).toBe("hazards");
      const row = (await listRuns(env.DB)).find((run) => run.id === id);
      expect(row).toMatchObject({ status: "swept", outcome: "hazards" });
    });

    it("posts a neutral check, never a success, when no patroller covers the change", async () => {
      const id = `r${++runCount}`;
      const stub = runStub(env, id);
      const snapshot = await stub.start(prRef(), id, { ...triage, panels: [] });
      expect(snapshot.outcome).toBe("none");
      expect(checks).toEqual([
        {
          method: "POST",
          body: expect.objectContaining({
            status: "completed",
            conclusion: "neutral",
            output: expect.objectContaining({ title: "No patrollers for this change" }),
          }),
        },
      ]);
      const row = (await listRuns(env.DB)).find((run) => run.id === id);
      expect(row?.outcome).toBe("none");
    });

    it("cancels the check of a stopped run", async () => {
      const { stub } = await startRun();
      await stub.stop("PR closed");
      expect(checks.at(-1)).toMatchObject({
        method: "PATCH",
        body: { status: "completed", conclusion: "cancelled" },
      });
    });

    it("keeps the id out of the snapshot", async () => {
      const { stub } = await startRun();
      expect(await storedCheckId(stub)).toBe(CHECK_ID);
      expect((await stub.view())!.run).not.toHaveProperty("checkRunId");
    });

    it("logs a refused create, carries on, and retries it with the next call", async () => {
      checkReply = () => new Response("leaky response body", { status: 500 });
      const { stub, snapshot } = await startRun();
      expect(snapshot.agents[0]?.status).toBe("dispatched");
      expect(await storedCheckId(stub)).toBeUndefined();
      expect(consoleError).toHaveBeenCalledOnce();
      const logged = String(consoleError.mock.calls[0]![0]);
      expect(logged).toContain(`GitHub POST ${CHECKS_PATH} failed with status 500`);
      expect(logged).not.toContain("leaky");
      expect(logged).not.toContain("installation-token");

      checkReply = acceptCheck;
      await stub.view();
      expect(checks).toHaveLength(2);
      expect(checks[1]).toMatchObject({
        method: "POST",
        body: { head_sha: "head58", status: "in_progress" },
      });
      expect(await storedCheckId(stub)).toBe(CHECK_ID);
    });

    it("retries a refused final update on the alarm, so the check completes", async () => {
      const { stub, nonce } = await startRun();
      let refusals = 1;
      checkReply = (method) => {
        if (method === "PATCH" && refusals-- > 0) return new Response(null, { status: 502 });
        return acceptCheck(method);
      };
      await stub.verdict(AGENT, nonce, clearVerdict);
      expect(checks.map((check) => check.method)).toEqual(["POST", "PATCH"]);
      const { alarm } = await storedState(stub);
      expect(alarm).not.toBeNull();
      expect(alarm).toBeLessThanOrEqual(Date.now() + 60_000);

      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(checks).toHaveLength(3);
      expect(checks[2]).toMatchObject({
        method: "PATCH",
        body: { status: "completed", conclusion: "success" },
      });
      expect((await storedState(stub)).alarm).toBeNull();
    });

    it("keeps retrying a refused update until GitHub takes it", async () => {
      const { stub, nonce } = await startRun();
      let refusals = 2;
      checkReply = (method) => {
        if (method === "PATCH" && refusals-- > 0) return new Response(null, { status: 502 });
        return acceptCheck(method);
      };
      await stub.verdict(AGENT, nonce, clearVerdict);
      await runDurableObjectAlarm(stub);
      expect((await storedState(stub)).alarm).toBeLessThanOrEqual(Date.now() + 60_000);
      await runDurableObjectAlarm(stub);
      expect(checks.map((check) => check.method)).toEqual(["POST", "PATCH", "PATCH", "PATCH"]);
      expect(checks.at(-1)).toMatchObject({ body: { conclusion: "success" } });
      expect((await storedState(stub)).alarm).toBeNull();
    });

    it("logs a refused update and carries on", async () => {
      const { stub, nonce } = await startRun();
      checkReply = (method) =>
        method === "PATCH" ? new Response(null, { status: 502 }) : acceptCheck(method);
      expect(await stub.verdict(AGENT, nonce, clearVerdict)).toBe("accepted");
      expect((await stub.view())!.run.status).toBe("swept");
      expect(String(consoleError.mock.calls[0]![0])).toContain(
        `GitHub PATCH ${CHECKS_PATH}/${CHECK_ID} failed with status 502`,
      );
    });

    it("sends one create at a time, so a change during it becomes an update", async () => {
      const release = deferred<void>();
      let posts = 0;
      checkReply = async (method) => {
        if (method === "POST" && ++posts === 1) await release.promise;
        return acceptCheck(method);
      };
      const id = `r${++runCount}`;
      const stub = runStub(env, id);
      const started = stub.start(prRef(), id, triage);
      await vi.waitFor(() => expect(checks).toHaveLength(1));
      const stopped = stub.stop("PR closed");
      // The stop has committed; its check effect follows. Give an unqueued one time to post.
      await vi.waitFor(async () => expect((await listRuns(env.DB))[0]?.status).toBe("stopped"));
      await new Promise((settle) => setTimeout(settle, 100));
      release.resolve();
      await Promise.all([started, stopped]);
      expect(checks.map((check) => check.method)).toEqual(["POST", "PATCH"]);
      expect(checks[0]!.body).toMatchObject({ status: "in_progress" });
      expect(checks[1]!.body).toMatchObject({ conclusion: "cancelled" });
    });

    // Created now, its cancelled check could be newer on the head than the check of the run that
    // replaced it.
    it("is never created for a review stopped while its first dispatch was out", async () => {
      const release = deferred<void>();
      stubGitHub(async () => {
        await release.promise;
        return new Response(null, { status: 204 });
      });
      const id = `r${++runCount}`;
      const stub = runStub(env, id);
      const started = stub.start(prRef(), id, triage);
      await vi.waitFor(() => expect(dispatches).toHaveLength(1));
      await stub.stop("superseded by head58");
      release.resolve();
      await started;
      expect(checks).toEqual([]);
      expect(await storedCheckId(stub)).toBeUndefined();
      expect((await storedState(stub)).alarm).toBeNull();
    });

    it.each<[string, (stub: Stub) => Promise<void>]>([
      ["stopped", (stub) => stub.stop("PR closed")],
      ["landed", (stub) => stub.land("abc1234def")],
    ])("is never created by a retry once the review was %s", async (_label, end) => {
      checkReply = () => new Response(null, { status: 502 });
      const { stub } = await startRun();
      await end(stub);
      checkReply = acceptCheck;
      expect(await runDurableObjectAlarm(stub)).toBe(false);
      await stub.view();
      // The creates GitHub refused while the review was on the hill, and nothing since.
      const statuses = checks.map((check) => [check.method, check.body.status]);
      expect(statuses).toEqual([
        ["POST", "in_progress"],
        ["POST", "in_progress"],
      ]);
      expect(await storedCheckId(stub)).toBeUndefined();
    });
  });

  // A run stopped on the head may have posted its check after this run's; GitHub reads the newest.
  describe("check repost", () => {
    let consoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    // Each create gets the next id, from CHECK_ID.
    function numberCreates(): void {
      let next = CHECK_ID;
      checkReply = (method) =>
        method === "POST" ? Response.json({ id: next++ }, { status: 201 }) : acceptCheck(method);
    }

    const refuse = () => new Response(null, { status: 502 });

    it("creates the run's check afresh, then marks the old one replaced", async () => {
      numberCreates();
      const { id, stub, nonce } = await startRun();
      await stub.repostCheck();
      expect(checks.slice(1)).toEqual([
        {
          method: "POST",
          body: expect.objectContaining({ head_sha: "head58", status: "in_progress" }),
        },
        {
          method: "PATCH",
          body: {
            name: "Base to Base",
            details_url: `${env.PUBLIC_URL}/runs/${id}`,
            status: "completed",
            conclusion: "skipped",
            output: { title: "Replaced by a newer check run", summary: expect.any(String) },
          },
        },
      ]);
      expect(patched).toEqual([CHECK_ID]);
      const { run } = await storedState(stub);
      expect(run.checkRunId).toBe(NEW_CHECK_ID);
      expect(run).not.toHaveProperty("checkReposts");

      await stub.verdict(AGENT, nonce, clearVerdict);
      expect(patched).toEqual([CHECK_ID, NEW_CHECK_ID]);
      expect(checks.at(-1)).toMatchObject({ method: "PATCH", body: { conclusion: "success" } });
    });

    it("stays owed until GitHub creates it", async () => {
      const { stub } = await startRun();
      checkReply = (method) => (method === "POST" ? refuse() : acceptCheck(method));
      await stub.repostCheck();
      const owed = await storedState(stub);
      expect(owed.run).toMatchObject({ checkRunId: CHECK_ID, checkReposts: 1 });
      expect(owed.alarm).toBeLessThanOrEqual(Date.now() + 60_000);

      const created = () => Response.json({ id: NEW_CHECK_ID }, { status: 201 });
      checkReply = (method) => (method === "POST" ? created() : acceptCheck(method));
      await runDurableObjectAlarm(stub);
      expect(checks.map((check) => check.method)).toEqual(["POST", "POST", "POST", "PATCH"]);
      expect(patched).toEqual([CHECK_ID]);
      expect((await storedState(stub)).run.checkRunId).toBe(NEW_CHECK_ID);
    });

    it("keeps the new check when the old one cannot be marked, never retrying it", async () => {
      numberCreates();
      const { stub } = await startRun();
      const create = checkReply;
      checkReply = (method) => (method === "PATCH" ? refuse() : create(method));
      await stub.repostCheck();
      expect(String(consoleError.mock.calls[0]![0])).toBe(
        `replaced check run: GitHub PATCH ${CHECKS_PATH}/${CHECK_ID} failed with status 502`,
      );
      const { run, alarm } = await storedState(stub);
      expect(run.checkRunId).toBe(NEW_CHECK_ID);
      expect(alarm).toBe(run.agents[0]!.dispatchedAt! + JOB_START_MS);
    });

    it("is made again when asked for while one is with GitHub", async () => {
      const release = deferred<void>();
      let creates = 0;
      checkReply = async (method) => {
        if (method === "PATCH") return acceptCheck(method);
        if (++creates === 2) await release.promise;
        return Response.json({ id: CHECK_ID + creates - 1 }, { status: 201 });
      };
      const { stub } = await startRun();
      const first = stub.repostCheck();
      await vi.waitFor(() => expect(creates).toBe(2));
      const second = stub.repostCheck();
      await vi.waitFor(async () => expect((await storedState(stub)).run.checkReposts).toBe(2));
      release.resolve();
      await Promise.all([first, second]);
      const methods = checks.map((check) => check.method);
      expect(methods).toEqual(["POST", "POST", "PATCH", "POST", "PATCH"]);
      expect(patched).toEqual([CHECK_ID, NEW_CHECK_ID]);
      const { run } = await storedState(stub);
      expect(run.checkRunId).toBe(NEW_CHECK_ID + 1);
      expect(run).not.toHaveProperty("checkReposts");
    });

    it("is not made for a run that has ended", async () => {
      const { stub } = await startRun();
      await stub.stop("PR closed");
      const before = checks.length;
      await stub.repostCheck();
      expect(checks).toHaveLength(before);
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
