import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBrief, AgentEvent } from "../../shared/src/types.ts";
import { createBatcher } from "../src/batcher.ts";
import { createDispatchClient, DispatchError } from "../src/client.ts";
import type { DispatchClient } from "../src/client.ts";
import { buildPrompt } from "../src/prompt.ts";
import { runAgent } from "../src/run.ts";

const fixtures = new URL("./fixtures/", import.meta.url);
const fakeClaude = new URL("fake-claude.mjs", fixtures).pathname;
const brief: AgentBrief = {
  role: "mainline",
  name: "Mainline",
  model: "sonnet",
  prefix: "FUN",
  goal: "orders: add cancel endpoint",
  prNumber: 58,
  baseSha: "base58",
  headSha: "head58",
};

let root: string;
let workDir: string;
let repoDir: string;
let templatesDir: string;
let errors: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "b2b-run-"));
  workDir = join(root, "work");
  repoDir = join(root, "repo");
  templatesDir = join(root, "templates");
  await mkdir(repoDir);
  await mkdir(join(templatesDir, ".basetobase", "patrol"), { recursive: true });
  await writeFile(join(templatesDir, ".basetobase", "patrol", "mainline.md"), "MAINLINE ROLE\n");
  await writeFile(join(templatesDir, ".basetobase", "patrol", "_verdict.md"), "VERDICT RULES\n");
  errors = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(line));
  vi.stubEnv("FAKE_VERDICT_DIR", workDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function recorder(over: Partial<DispatchClient> = {}) {
  const c = {
    order: [] as string[],
    events: [] as AgentEvent[][],
    verdicts: [] as unknown[],
    failures: [] as string[],
    transcripts: [] as string[],
  };
  const client: DispatchClient = {
    brief: async () => brief,
    events: async (batch) => void (c.order.push("events"), c.events.push(batch)),
    verdict: async (v) => void (c.order.push("verdict"), c.verdicts.push(v)),
    failure: async (reason) => void (c.order.push("failure"), c.failures.push(reason)),
    transcript: async (path) =>
      void (c.order.push("transcript"), c.transcripts.push(await readFile(path, "utf8"))),
    ...over,
  };
  return { c, client };
}

type RunOptions = Parameters<typeof runAgent>[0];
type Verdict = "valid" | "none" | "broken";

function start(
  verdict: Verdict,
  env: Record<string, string> = {},
  client = recorder().client,
  extra: Partial<RunOptions> = {},
) {
  vi.stubEnv("FAKE_VERDICT", verdict);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return runAgent({
    client,
    claudeBin: process.execPath,
    claudeArgs: [fakeClaude],
    repoDir,
    templatesDir,
    workDir,
    retryDelaysMs: [1, 1],
    ...extra,
  });
}

async function run(
  verdict: Verdict,
  env: Record<string, string> = {},
  over: Partial<DispatchClient> = {},
  extra: Partial<RunOptions> = {},
) {
  const r = recorder(over);
  const code = await start(verdict, env, r.client, extra);
  return { ...r, code };
}

// Rejects with `error` for the first `failures` calls, then resolves to `result`.
function flaky<R>(failures: number, error: Error, result: R) {
  const calls = { count: 0 };
  const fn = async (..._args: unknown[]) => {
    if (calls.count++ < failures) throw error;
    return result;
  };
  return { calls, fn };
}

const unavailable = (what: string) => new DispatchError(`${what} → 503`, 503);

describe("runAgent", () => {
  it("streams events in order and posts the verdict", async () => {
    const { c, code } = await run("valid");
    expect(code).toBe(0);
    expect(c.events.flat().map((e) => e.seq)).toEqual([...Array(c.events.flat().length).keys()]);
    expect(c.verdicts[0]).toMatchObject({ role: "mainline", status: "clear" });
    expect(c.transcripts).toHaveLength(1);
    expect(c.failures).toEqual([]);
  });

  it("maps the stream, keeps the raw transcript, and reports events, then transcript, then verdict", async () => {
    const { c } = await run("valid");
    expect(c.events.flat().map((e) => [e.kind, e.text])).toEqual([
      ["system", "session started · model test-model"],
      ["say", "Starting the app."],
      ["tool", "Bash go run ."],
      ["tool_result", "listening on :8080"],
      ["error", "curl: (7) Failed to connect to localhost port 8080"],
      ["done", "success · 12 turns · 84s"],
    ]);
    expect(c.events.flat().every((e) => Number.isFinite(e.ts) && e.ts > 1.7e12)).toBe(true);
    expect(c.transcripts[0]).toBe(await readFile(new URL("stream.jsonl", fixtures), "utf8"));
    expect(c.order).toEqual([...c.events.map(() => "events"), "transcript", "verdict"]);
  });

  it("starts claude headless in the repo and gives it the prompt on stdin", async () => {
    const argsFile = join(root, "args.json");
    await run("valid", { FAKE_ARGS_FILE: argsFile });
    const seen = JSON.parse(await readFile(argsFile, "utf8"));
    expect(seen.argv).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "sonnet",
      "--dangerously-skip-permissions",
    ]);
    expect(seen.stdin).toBe(
      buildPrompt(brief, "MAINLINE ROLE", "VERDICT RULES", join(workDir, "verdict.json")),
    );
    expect(seen.cwd).toBe(await realpath(repoDir));
  });

  it("hands claude a prompt too large for argv intact", async () => {
    const argsFile = join(root, "args.json");
    const big = { ...brief, goal: "漢字 ".repeat(60_000) };
    const { c, code } = await run(
      "valid",
      { FAKE_ARGS_FILE: argsFile },
      { brief: async () => big },
    );
    const prompt = buildPrompt(
      big,
      "MAINLINE ROLE",
      "VERDICT RULES",
      join(workDir, "verdict.json"),
    );
    const seen = JSON.parse(await readFile(argsFile, "utf8"));
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(200_000);
    expect(seen.stdin).toBe(prompt);
    expect(seen.argv.join(" ")).not.toContain("漢");
    expect(code).toBe(0);
    expect(c.verdicts).toHaveLength(1);
  });

  it("reports a missing verdict", async () => {
    const { c } = await run("none");
    expect(c.failures).toEqual(["no verdict written"]);
    expect(c.verdicts).toEqual([]);
  });

  it("reports unparseable verdict", async () => {
    const { c } = await run("broken");
    expect(c.failures).toEqual(["verdict is not JSON"]);
    expect(c.verdicts).toEqual([]);
  });

  it("reports a non-zero exit", async () => {
    const { c, code } = await run("valid", { FAKE_EXIT: "3" });
    expect(c.failures).toEqual(["claude exited 3"]);
    expect(c.verdicts).toEqual([]);
    expect(code).toBe(0);
  });

  it("sends stderr lines as system events", async () => {
    const { c } = await run("valid", { FAKE_STDERR: "warning: slow disk" });
    expect(c.events.flat()).toContainEqual(
      expect.objectContaining({ kind: "system", text: "warning: slow disk" }),
    );
  });

  it("parses a JSON line that arrives in two chunks", async () => {
    const whole = await run("valid");
    const split = await run("valid", { FAKE_SPLIT: "1" });
    expect(split.c.events.flat().map((e) => [e.kind, e.text])).toEqual(
      whole.c.events.flat().map((e) => [e.kind, e.text]),
    );
    expect(split.c.transcripts[0]).toBe(whole.c.transcripts[0]);
  });

  it("reports unreadable templates without starting claude", async () => {
    await rm(join(templatesDir, ".basetobase", "patrol", "_verdict.md"));
    const argsFile = join(root, "args.json");
    const { c, code } = await run("valid", { FAKE_ARGS_FILE: argsFile });
    expect(c.failures).toEqual(["cannot read agent templates"]);
    expect(code).toBe(0);
    await expect(readFile(argsFile)).rejects.toThrow();
  });

  it("reports a claude binary that cannot start", async () => {
    const r = recorder();
    const code = await runAgent({
      client: r.client,
      claudeBin: join(root, "no-such-claude"),
      repoDir,
      templatesDir,
      workDir,
    });
    expect(r.c.failures).toEqual(["cannot start claude: ENOENT"]);
    expect(code).toBe(0);
  });

  it.each([
    ["a NUL in the binary name", { claudeBin: "claude\0" }, "ERR_INVALID_ARG_VALUE"],
    ["arguments over the kernel limit", { claudeArgs: ["x".repeat(2_000_000)] }, "E2BIG"],
  ])("reports a spawn that throws (%s) without the prompt", async (_name, extra, reason) => {
    const { c, code } = await run("valid", {}, {}, extra);
    expect(c.failures).toEqual([`cannot start claude: ${reason}`]);
    expect(code).toBe(0);
  });

  it("reports a work directory that cannot be created", async () => {
    await writeFile(join(root, "blocker"), "");
    const { c, code } = await run("valid", {}, {}, { workDir: join(root, "blocker", "work") });
    expect(c.failures).toEqual(["cannot start claude: ENOTDIR"]);
    expect(c.verdicts).toEqual([]);
    expect(code).toBe(0);
  });

  describe("the brief", () => {
    it("is retried when Dispatch is unavailable", async () => {
      const briefAfterOutage = flaky(2, unavailable("GET /agent/brief"), brief);
      const { c, code } = await run("valid", {}, { brief: briefAfterOutage.fn });
      expect(briefAfterOutage.calls.count).toBe(3);
      expect(c.verdicts).toHaveLength(1);
      expect(code).toBe(0);
      expect(errors).toEqual([
        "fetching the brief failed, retrying in 1 ms: GET /agent/brief → 503",
        "fetching the brief failed, retrying in 1 ms: GET /agent/brief → 503",
      ]);
    });

    it("gives up with 1 once the retry schedule is used up", async () => {
      const outage = flaky(Infinity, unavailable("GET /agent/brief"), brief);
      const { c, code } = await run("valid", {}, { brief: outage.fn });
      expect(code).toBe(1);
      expect(outage.calls.count).toBe(3);
      expect(c.order).toEqual([]);
      expect(errors.at(-1)).toBe("fetching the brief failed: GET /agent/brief → 503");
    });

    it("is refused for a stopped run or a finished agent: exit 0 and nothing else sent", async () => {
      const argsFile = join(root, "args.json");
      const refused = flaky(
        Infinity,
        new DispatchError("GET /agent/brief → 403: forbidden", 403),
        brief,
      );
      const { c, code } = await run("valid", { FAKE_ARGS_FILE: argsFile }, { brief: refused.fn });
      expect(code).toBe(0);
      expect(refused.calls.count).toBe(1);
      expect(c.order).toEqual([]);
      await expect(readFile(argsFile)).rejects.toThrow();
      expect(errors).toEqual(["the agent is no longer wanted: GET /agent/brief → 403: forbidden"]);
    });

    it("is not retried after another permanent answer", async () => {
      const refused = flaky(Infinity, new DispatchError("GET /agent/brief → 401", 401), brief);
      const { code } = await run("valid", {}, { brief: refused.fn });
      expect(code).toBe(1);
      expect(refused.calls.count).toBe(1);
    });
  });

  describe("when Dispatch misbehaves", () => {
    it("returns 1 after still reporting the outcome when the events cannot be drained", async () => {
      const calls: number[] = [];
      const { c, code } = await run(
        "valid",
        {},
        {
          events: async (batch) => {
            calls.push(batch.length);
            throw new Error("POST /agent/events failed: fetch failed");
          },
        },
        {
          batcher: (send: (b: AgentEvent[]) => Promise<void>) =>
            createBatcher(send, { intervalMs: 5, retryDelaysMs: [5], closeTimeoutMs: 100 }),
        },
      );
      expect(code).toBe(1);
      expect(calls.length).toBeGreaterThan(1);
      expect(c.transcripts).toHaveLength(1);
      expect(c.verdicts).toHaveLength(1);
      expect(errors.at(-1)).toBe("events not delivered: event queue not drained within 100 ms");
      const attempts = calls.length;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(calls).toHaveLength(attempts);
    });

    it("drops a batch Dispatch rejects for good and finishes normally", async () => {
      const { c, code } = await run(
        "valid",
        {},
        {
          events: async () =>
            Promise.reject(new DispatchError("POST /agent/events → 400: bad", 400)),
        },
      );
      expect(code).toBe(0);
      expect(c.verdicts).toHaveLength(1);
      expect(errors).toEqual(["dropped 6 events: POST /agent/events → 400: bad"]);
    });

    it("still posts the verdict when the transcript upload fails", async () => {
      const { c, code } = await run(
        "valid",
        {},
        {
          transcript: async () =>
            Promise.reject(new DispatchError("PUT /agent/transcript → 413", 413)),
        },
      );
      expect(code).toBe(0);
      expect(c.verdicts).toHaveLength(1);
      expect(errors).toEqual(["uploading the transcript failed: PUT /agent/transcript → 413"]);
    });

    it("still posts the failure when the transcript upload fails", async () => {
      const { c } = await run(
        "none",
        {},
        {
          transcript: async () =>
            Promise.reject(new DispatchError("PUT /agent/transcript → 413", 413)),
        },
      );
      expect(c.failures).toEqual(["no verdict written"]);
    });

    it("counts a 422 on the verdict as reported", async () => {
      const { c, code } = await run(
        "valid",
        {},
        {
          verdict: async () =>
            Promise.reject(
              new DispatchError(
                'POST /agent/verdict → 422: {"error":"status must be clear or hazards"}',
                422,
              ),
            ),
        },
      );
      expect(code).toBe(0);
      expect(c.failures).toEqual([]);
      expect(errors).toEqual([
        'verdict rejected: POST /agent/verdict → 422: {"error":"status must be clear or hazards"}',
      ]);
    });

    it("returns 1 when another verdict error means Dispatch has not heard", async () => {
      const refused = flaky(
        Infinity,
        new DispatchError("POST /agent/verdict → 403: forbidden", 403),
        undefined,
      );
      const { c, code } = await run("valid", {}, { verdict: refused.fn });
      expect(code).toBe(1);
      expect(refused.calls.count).toBe(1);
      expect(c.failures).toEqual([]);
      expect(errors).toEqual([
        "reporting the verdict failed: POST /agent/verdict → 403: forbidden",
      ]);
    });

    it("retries a verdict that gets a 503", async () => {
      const busy = flaky(1, unavailable("POST /agent/verdict"), undefined);
      const { c, code } = await run("valid", {}, { verdict: busy.fn });
      expect(code).toBe(0);
      expect(busy.calls.count).toBe(2);
      expect(c.failures).toEqual([]);
      expect(errors).toEqual([
        "reporting the verdict failed, retrying in 1 ms: POST /agent/verdict → 503",
      ]);
    });

    it("returns 1 when the verdict keeps getting a 503", async () => {
      const busy = flaky(Infinity, unavailable("POST /agent/verdict"), undefined);
      const { code } = await run("valid", {}, { verdict: busy.fn });
      expect(code).toBe(1);
      expect(busy.calls.count).toBe(3);
      expect(errors.at(-1)).toBe("reporting the verdict failed: POST /agent/verdict → 503");
    });

    it("retries a failure report after a network error", async () => {
      const down = flaky(1, new Error("POST /agent/failure failed: fetch failed"), undefined);
      const { code } = await run("none", {}, { failure: down.fn });
      expect(code).toBe(0);
      expect(down.calls.count).toBe(2);
    });

    it("returns 1 when the failure report is not accepted", async () => {
      const down = flaky(
        Infinity,
        new Error("POST /agent/failure failed: fetch failed"),
        undefined,
      );
      const { code } = await run("none", {}, { failure: down.fn });
      expect(code).toBe(1);
      expect(down.calls.count).toBe(3);
      expect(errors.at(-1)).toBe(
        "reporting the failure failed: POST /agent/failure failed: fetch failed",
      );
    });
  });

  describe("secrets", () => {
    const secrets = {
      NONCE: "nonce-secret-0123",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-secret-4567",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.test/idtoken?x=1",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-8901",
    };

    it("keeps them away from claude, the events and the transcript", async () => {
      const { c } = await run("valid", { ...secrets, FAKE_LEAK: "1" });
      const leak = c.events.flat().find((e) => e.text.startsWith("env "));
      expect(leak?.text).toBe("env undefined undefined [redacted]");
      const everything = JSON.stringify([c.events, c.transcripts, c.verdicts, errors]);
      for (const secret of Object.values(secrets)) expect(everything).not.toContain(secret);
      expect(c.transcripts[0]).toContain("env undefined undefined [redacted]");
    });

    it("keeps them out of stderr when every call to Dispatch fails", async () => {
      for (const [name, value] of Object.entries(secrets)) vi.stubEnv(name, value);
      const answers: Record<string, Response> = {
        "/agent/events": new Response("bad", { status: 400 }),
        "/agent/transcript": new Response(null, { status: 413 }),
        "/agent/verdict": Response.json({ error: "role must be mainline" }, { status: 422 }),
      };
      const client = createDispatchClient({
        baseUrl: "https://dispatch.test",
        runId: "run-1",
        agentId: "mainline-sweep-0",
        nonce: secrets.NONCE,
        token: async () => "oidc-secret-2345",
        fetch: async (input) => {
          const url = new URL(String(input));
          if (url.pathname === "/agent/brief") return Response.json(brief);
          return (answers[url.pathname] ?? new Response(null, { status: 500 })).clone();
        },
      });
      expect(await start("valid", { FAKE_LEAK: "1" }, client)).toBe(0);
      expect(errors.length).toBeGreaterThanOrEqual(3);
      for (const secret of [...Object.values(secrets), "oidc-secret-2345"]) {
        expect(errors.join("\n")).not.toContain(secret);
      }
    });
  });
});
