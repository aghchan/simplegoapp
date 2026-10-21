import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { EVENT_TEXT_MAX, mapStreamLine } from "../../shared/src/stream.ts";
import type { AgentBrief, AgentEvent, EventKind } from "../../shared/src/types.ts";
import { createBatcher, isPermanent, RETRY_DELAYS_MS } from "./batcher.ts";
import type { Batcher } from "./batcher.ts";
import { DispatchError } from "./client.ts";
import type { DispatchClient } from "./client.ts";
import { buildPrompt } from "./prompt.ts";

// What authenticates the forwarder to Dispatch. Claude runs the pull request's code and has no use
// for it.
const FORWARDER_ONLY_ENV = [
  "NONCE",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
];

// Under the agent job's 25-minute timeout, which also covers the setup steps before claude starts,
// so the reason and the transcript still reach Dispatch.
const DEADLINE_MS = 20 * 60_000;
const PAST_DEADLINE = "claude ran past 20 min";
const JOB_CANCELLED = "job cancelled";
const TOKEN_REJECTED =
  "Claude token rejected: renew the CLAUDE_CODE_OAUTH_TOKEN repo secret with `claude setup-token`";
// What claude prints when the Claude token is missing, expired or cut short.
const TOKEN_REJECTED_TEXT = /OAuth access token is invalid|Failed to authenticate|Invalid API key/i;
const KILL_GRACE_MS = 5000;
// On cancel the runner sends SIGTERM 7.5 s after its first signal, and a second signal ends the
// forwarder at once: each of the cancel's three steps waits at most this long.
const CANCEL_STEP_MS = 2000;
const CANCEL = Symbol("cancel");

type Claude = ChildProcessWithoutNullStreams;
type Lines = { stdout(line: string): void; stderr(line: string): void };

// Runs Claude Code on the brief, streams what it does, and reports how it ended. Resolves to the
// process exit code: 1 when Dispatch was not told everything it should have been, when claude ran
// past the deadline, or when the job was cancelled; 0 once Dispatch no longer wants reports.
// `retryDelaysMs` is how long the brief, the verdict and the failure report wait between attempts.
export async function runAgent(o: {
  client: DispatchClient;
  claudeBin: string;
  claudeArgs?: string[];
  repoDir: string;
  templatesDir: string;
  workDir: string;
  batcher?: (send: (b: AgentEvent[]) => Promise<void>) => Batcher;
  retryDelaysMs?: number[];
  signals?: Pick<NodeJS.EventEmitter, "on" | "off">;
  deadlineMs?: number;
  killGraceMs?: number;
  cancelStepMs?: number;
}): Promise<number> {
  const retryDelaysMs = o.retryDelaysMs ?? RETRY_DELAYS_MS;
  const killGraceMs = o.killGraceMs ?? KILL_GRACE_MS;
  const cancelStepMs = o.cancelStepMs ?? CANCEL_STEP_MS;
  let brief: AgentBrief;
  try {
    brief = await withRetries("fetching the brief", retryDelaysMs, () => o.client.brief());
  } catch (error) {
    // Dispatch refuses the brief of a stopped run and of an agent that has already reported.
    if (error instanceof DispatchError && error.status === 403) {
      warn("the agent is no longer wanted", error);
      return 0;
    }
    warn("fetching the brief failed", error);
    return 1;
  }
  console.log(`brief: ${brief.name} reviewing ${brief.headSha.slice(0, 7)}`);

  let failure: string | undefined;
  try {
    await mkdir(o.workDir, { recursive: true });
  } catch (error) {
    failure = startFailure(error);
  }
  const verdictPath = join(o.workDir, "verdict.json");
  const transcriptPath = join(o.workDir, "transcript.jsonl");
  const transcript = createWriteStream(transcriptPath);
  // Surfaced by finished() below; without a listener a write error would end the process.
  transcript.on("error", () => {});

  let claude: { child: Claude; exited: Promise<string | undefined> } | undefined;
  let unwanted = false;
  let pastDeadline = false;
  let cancelled = false;

  // Dispatch answers 410 once the run is stopped or it is done with this agent.
  async function unlessUnwanted(call: () => Promise<void>): Promise<void> {
    if (unwanted) return;
    try {
      await call();
    } catch (error) {
      if (!(error instanceof DispatchError && error.status === 410)) throw error;
      if (unwanted) return;
      unwanted = true;
      warn("Dispatch no longer wants reports (run stopped or agent finished)", error);
      batcher.abandon();
      if (claude) stopClaude(claude.child, killGraceMs);
    }
  }
  const reports = {
    verdict: (verdict: unknown) => unlessUnwanted(() => o.client.verdict(verdict)),
    failure: (reason: string) => unlessUnwanted(() => o.client.failure(reason)),
  };
  const batcher = (o.batcher ?? createBatcher)((batch) =>
    unlessUnwanted(() => o.client.events(batch)),
  );

  let seq = 0;
  let tokenRejected = false;
  const push = (kind: EventKind, text: string) =>
    batcher.push({ seq: seq++, ts: Date.now(), kind, text });
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const redact = (text: string) => (oauthToken ? text.replaceAll(oauthToken, "[redacted]") : text);
  const lines: Lines = {
    stdout(raw) {
      if (raw.trim() === "") return;
      const line = redact(raw);
      // A cancel closes the transcript while a stopped claude may still be printing.
      if (!transcript.writableEnded) transcript.write(`${line}\n`);
      for (const event of mapStreamLine(line)) {
        push(event.kind, event.text);
        // Tool output can quote any text, so only claude's own messages count.
        const own = event.kind !== "tool" && event.kind !== "tool_result";
        if (own && TOKEN_REJECTED_TEXT.test(event.text)) tokenRejected = true;
        // The job log shows how claude ended, so a failed run is readable from GitHub alone.
        if (event.kind === "done" || event.kind === "error") console.log(`claude: ${event.text}`);
      }
    },
    stderr(raw) {
      const text = redact(raw).trim();
      if (!text) return;
      push("system", text.slice(0, EVENT_TEXT_MAX));
      if (TOKEN_REJECTED_TEXT.test(text)) tokenRejected = true;
      console.error(`claude: ${text}`);
    },
  };

  let transcriptClosed: Promise<void> | undefined;
  const closeTranscript = () =>
    (transcriptClosed ??= (async () => {
      transcript.end();
      try {
        await finished(transcript);
      } catch (error) {
        warn("writing the transcript failed", error);
      }
    })());
  let uploaded: Promise<void> | undefined;
  const upload = () => (uploaded ??= uploadTranscript(o.client, transcriptPath));

  // Resolves to why claude did not finish, or undefined when it exited cleanly.
  async function runClaude(): Promise<string | undefined> {
    let prompt: string;
    try {
      prompt = await readPrompt(o.templatesDir, brief, verdictPath);
    } catch (error) {
      warn("reading the agent templates failed", error);
      return "cannot read agent templates";
    }
    if (cancelled) return undefined;
    let child: Claude;
    try {
      child = startClaude(o, brief.model, prompt);
    } catch (error) {
      return startFailure(error);
    }
    const exited = watchClaude(child, lines);
    claude = { child, exited };
    const deadline = setTimeout(() => {
      pastDeadline = true;
      console.error(`${PAST_DEADLINE}: stopping it`);
      stopClaude(child, killGraceMs);
    }, o.deadlineMs ?? DEADLINE_MS);
    try {
      return await exited;
    } finally {
      clearTimeout(deadline);
    }
  }

  // A signal rejects whichever step is awaited, so the cancel's bounded steps take over from there.
  let signalCancel: () => void = () => {};
  const cancelling = new Promise<never>((_, reject) => {
    signalCancel = () => reject(CANCEL);
  });
  cancelling.catch(() => {});
  const untilCancelled = <T>(step: Promise<T>) => Promise.race([step, cancelling]);

  async function finish(): Promise<number> {
    failure ??= await untilCancelled(runClaude());
    if (pastDeadline) failure = PAST_DEADLINE;
    // "claude exited 1" alone sends the owner to the transcript for what is a secret to renew.
    else if (tokenRejected && failure?.startsWith("claude exited")) failure = TOKEN_REJECTED;
    await untilCancelled(closeTranscript());
    const drained = await untilCancelled(drain(batcher));
    await untilCancelled(upload());
    if (unwanted) return 0;
    const outcome = await untilCancelled(report(reports, failure, verdictPath, retryDelaysMs));
    if (unwanted) return 0;
    // A failed agent fails the job too, so GitHub never shows green for a review that did not run.
    return drained && outcome === "verdict" && !pastDeadline ? 0 : 1;
  }

  async function finishCancelled(): Promise<number> {
    batcher.abandon();
    if (claude) {
      stopClaude(claude.child, cancelStepMs);
      await within("waiting for claude to exit", cancelStepMs, claude.exited);
    }
    await closeTranscript();
    await within("uploading the transcript", cancelStepMs, upload());
    const reported = reports
      .failure(JOB_CANCELLED)
      .catch((error) => warn("reporting the failure failed", error));
    await within("reporting the failure", cancelStepMs, reported);
    return 1;
  }

  let exitNow: (code: number) => void = () => {};
  const exitedNow = new Promise<number>((resolve) => {
    exitNow = resolve;
  });
  const onSignal = (name: string) => {
    if (cancelled) {
      claude?.child.kill("SIGKILL");
      exitNow(1);
      return;
    }
    cancelled = true;
    console.error(`${name} received: stopping claude`);
    signalCancel();
  };
  const handlers = (["SIGINT", "SIGTERM"] as const).map((name) => ({
    name,
    handler: () => onSignal(name),
  }));
  const signals = o.signals ?? process;
  for (const { name, handler } of handlers) signals.on(name, handler);
  try {
    return await Promise.race([
      finish().catch((error: unknown) => {
        if (error !== CANCEL) throw error;
        return finishCancelled();
      }),
      exitedNow,
    ]);
  } finally {
    for (const { name, handler } of handlers) signals.off(name, handler);
  }
}

// The prompt goes in on stdin: it holds the whole PR description, which can be longer than the
// kernel allows for one argument. The setting sources leave out the PR's own .claude/ settings
// (hooks, env, permissions) and MCP config: the PR must not configure its reviewer.
function startClaude(
  o: { claudeBin: string; claudeArgs?: string[]; repoDir: string },
  model: string,
  prompt: string,
): Claude {
  const child = spawn(
    o.claudeBin,
    [
      ...(o.claudeArgs ?? []),
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      model,
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--dangerously-skip-permissions",
    ],
    { cwd: o.repoDir, stdio: ["pipe", "pipe", "pipe"], env: claudeEnv() },
  );
  // EPIPE when claude exits without reading it; the exit is reported on its own.
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  return child;
}

// Resolves to why claude did not finish, or undefined when it exited cleanly. Lines are handled as
// they arrive, so nothing waits on a send to Dispatch.
function watchClaude(child: Claude, lines: Lines): Promise<string | undefined> {
  const exited = new Promise<string | undefined>((resolve) => {
    child.once("error", (error) => resolve(startFailure(error)));
    child.once("close", (code, signal) =>
      resolve(code === 0 ? undefined : `claude exited ${code ?? signal}`),
    );
  });
  createInterface({ input: child.stdout }).on("line", lines.stdout);
  createInterface({ input: child.stderr }).on("line", lines.stderr);
  return exited;
}

// SIGTERM now, then SIGKILL if claude is still running `graceMs` later.
function stopClaude(child: Claude, graceMs: number): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const kill = setTimeout(() => child.kill("SIGKILL"), graceMs);
  child.once("exit", () => clearTimeout(kill));
}

// By code before message: some spawn errors quote their arguments.
function startFailure(error: unknown): string {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  const reason = code ?? (error instanceof Error ? error.message : String(error));
  return `cannot start claude: ${reason}`;
}

async function readPrompt(
  templatesDir: string,
  brief: AgentBrief,
  verdictPath: string,
): Promise<string> {
  const patrol = join(templatesDir, ".basetobase", "patrol");
  const [role, verdict] = await Promise.all([
    readFile(join(patrol, `${brief.role}.md`), "utf8"),
    readFile(join(patrol, "_verdict.md"), "utf8"),
  ]);
  return buildPrompt(brief, role, verdict, verdictPath);
}

function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of FORWARDER_ONLY_ENV) delete env[name];
  return env;
}

async function drain(batcher: Batcher): Promise<boolean> {
  try {
    await batcher.close();
    return true;
  } catch (error) {
    warn("events not delivered", error);
    return false;
  }
}

// A transcript that cannot be stored must not keep the verdict from Dispatch.
async function uploadTranscript(client: DispatchClient, path: string): Promise<void> {
  try {
    await client.transcript(path);
  } catch (error) {
    warn("uploading the transcript failed", error);
  }
}

async function report(
  client: Pick<DispatchClient, "verdict" | "failure">,
  failure: string | undefined,
  verdictPath: string,
  retryDelaysMs: number[],
): Promise<"verdict" | "failure" | "undelivered"> {
  const outcome = failure === undefined ? await readVerdict(verdictPath) : { failure };
  if ("failure" in outcome) {
    try {
      await withRetries("reporting the failure", retryDelaysMs, () =>
        client.failure(outcome.failure),
      );
      console.log(`reported: failure · ${outcome.failure}`);
      return "failure";
    } catch (error) {
      warn("reporting the failure failed", error);
      return "undelivered";
    }
  }
  try {
    await withRetries("reporting the verdict", retryDelaysMs, () =>
      client.verdict(outcome.verdict),
    );
    console.log(`reported: verdict ${verdictStatus(outcome.verdict)}`);
    return "verdict";
  } catch (error) {
    // Dispatch has already marked the agent as errored, so there is nothing left to report.
    if (error instanceof DispatchError && error.status === 422) {
      warn("verdict rejected", error);
      return "failure";
    }
    warn("reporting the verdict failed", error);
    return "undelivered";
  }
}

// Goes through `delaysMs` once: no endless retrying for a call the job's outcome hangs on. A
// permanent error is thrown straight away.
async function withRetries<T>(
  what: string,
  delaysMs: number[],
  call: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const delay = delaysMs[attempt];
      if (delay === undefined || isPermanent(error)) throw error;
      warn(`${what} failed, retrying in ${delay} ms`, error);
      await sleep(delay);
    }
  }
}

// `step` must not reject. Whatever it still does after `ms` is left behind.
async function within(what: string, ms: number, step: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<"gave up">((resolve) => {
    timer = setTimeout(() => resolve("gave up"), ms);
  });
  const outcome = await Promise.race([step.then(() => "done" as const), gaveUp]);
  clearTimeout(timer);
  if (outcome === "gave up") console.error(`${what}: gave up after ${ms} ms`);
}

async function readVerdict(path: string): Promise<{ verdict: unknown } | { failure: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { failure: "no verdict written" };
  }
  try {
    return { verdict: JSON.parse(text) };
  } catch {
    return { failure: "verdict is not JSON" };
  }
}

function verdictStatus(verdict: unknown): string {
  const status = typeof verdict === "object" && verdict !== null ? (verdict as { status?: unknown }).status : undefined;
  return typeof status === "string" ? status : "(no status)";
}

function warn(what: string, error: unknown): void {
  console.error(`${what}: ${error instanceof Error ? error.message : String(error)}`);
}
