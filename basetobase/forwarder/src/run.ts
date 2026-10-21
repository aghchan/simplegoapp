import { spawn } from "node:child_process";
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

// Runs Claude Code on the brief, streams what it does, and reports how it ended. Resolves to the
// process exit code: 1 when Dispatch was not told everything it should have been. `retryDelaysMs`
// is how long the brief, the verdict and the failure report wait between attempts.
export async function runAgent(o: {
  client: DispatchClient;
  claudeBin: string;
  claudeArgs?: string[];
  repoDir: string;
  templatesDir: string;
  workDir: string;
  batcher?: (send: (b: AgentEvent[]) => Promise<void>) => Batcher;
  retryDelaysMs?: number[];
}): Promise<number> {
  const retryDelaysMs = o.retryDelaysMs ?? RETRY_DELAYS_MS;
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

  let failure: string | undefined;
  try {
    await mkdir(o.workDir, { recursive: true });
  } catch (error) {
    failure = startFailure(error);
  }
  const verdictPath = join(o.workDir, "verdict.json");
  const transcriptPath = join(o.workDir, "transcript.jsonl");
  const batcher = (o.batcher ?? createBatcher)((batch) => o.client.events(batch));
  const transcript = createWriteStream(transcriptPath);
  // Surfaced by finished() below; without a listener a write error would end the process.
  transcript.on("error", () => {});

  let seq = 0;
  const push = (kind: EventKind, text: string) =>
    batcher.push({ seq: seq++, ts: Date.now(), kind, text });
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const redact = (text: string) => (oauthToken ? text.replaceAll(oauthToken, "[redacted]") : text);

  failure ??= await runClaude(o, brief, verdictPath, {
    stdout(raw) {
      if (raw.trim() === "") return;
      const line = redact(raw);
      transcript.write(`${line}\n`);
      for (const event of mapStreamLine(line)) push(event.kind, event.text);
    },
    stderr(raw) {
      const text = redact(raw).trim();
      if (text) push("system", text.slice(0, EVENT_TEXT_MAX));
    },
  });

  transcript.end();
  try {
    await finished(transcript);
  } catch (error) {
    warn("writing the transcript failed", error);
  }
  const drained = await drain(batcher);
  await uploadTranscript(o.client, transcriptPath);
  const reported = await report(o.client, failure, verdictPath, retryDelaysMs);
  return drained && reported ? 0 : 1;
}

// Resolves to why Claude did not finish, or undefined when it exited cleanly.
async function runClaude(
  o: { claudeBin: string; claudeArgs?: string[]; repoDir: string; templatesDir: string },
  brief: AgentBrief,
  verdictPath: string,
  onLine: { stdout(line: string): void; stderr(line: string): void },
): Promise<string | undefined> {
  let prompt: string;
  try {
    prompt = await readPrompt(o.templatesDir, brief, verdictPath);
  } catch (error) {
    warn("reading the agent templates failed", error);
    return "cannot read agent templates";
  }

  let child: ReturnType<typeof startClaude>;
  try {
    child = startClaude(o, brief.model, prompt);
  } catch (error) {
    return startFailure(error);
  }
  const finishedWith = new Promise<string | undefined>((resolve) => {
    child.once("error", (error) => resolve(startFailure(error)));
    child.once("close", (code, signal) =>
      resolve(code === 0 ? undefined : `claude exited ${code ?? signal}`),
    );
  });
  // Lines are handled as they arrive, so nothing waits on a send to Dispatch.
  createInterface({ input: child.stdout }).on("line", onLine.stdout);
  createInterface({ input: child.stderr }).on("line", onLine.stderr);
  return finishedWith;
}

// The prompt goes in on stdin: it holds the whole PR description, which can be longer than the
// kernel allows for one argument.
function startClaude(
  o: { claudeBin: string; claudeArgs?: string[]; repoDir: string },
  model: string,
  prompt: string,
) {
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
      "--dangerously-skip-permissions",
    ],
    { cwd: o.repoDir, stdio: ["pipe", "pipe", "pipe"], env: claudeEnv() },
  );
  // EPIPE when claude exits without reading it; the exit is reported on its own.
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  return child;
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
  client: DispatchClient,
  failure: string | undefined,
  verdictPath: string,
  retryDelaysMs: number[],
): Promise<boolean> {
  const outcome = failure === undefined ? await readVerdict(verdictPath) : { failure };
  if ("failure" in outcome) {
    try {
      await withRetries("reporting the failure", retryDelaysMs, () =>
        client.failure(outcome.failure),
      );
      return true;
    } catch (error) {
      warn("reporting the failure failed", error);
      return false;
    }
  }
  try {
    await withRetries("reporting the verdict", retryDelaysMs, () =>
      client.verdict(outcome.verdict),
    );
    return true;
  } catch (error) {
    // Dispatch has already marked the agent as errored, so there is nothing left to report.
    if (error instanceof DispatchError && error.status === 422) {
      warn("verdict rejected", error);
      return true;
    }
    warn("reporting the verdict failed", error);
    return false;
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

function warn(what: string, error: unknown): void {
  console.error(`${what}: ${error instanceof Error ? error.message : String(error)}`);
}
