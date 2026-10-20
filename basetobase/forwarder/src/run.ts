import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { EVENT_TEXT_MAX, mapStreamLine } from "../../shared/src/stream.ts";
import type { AgentBrief, AgentEvent, EventKind } from "../../shared/src/types.ts";
import { createBatcher } from "./batcher.ts";
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
// process exit code: 1 when Dispatch was not told everything it should have been.
export async function runAgent(o: {
  client: DispatchClient;
  claudeBin: string;
  claudeArgs?: string[];
  repoDir: string;
  templatesDir: string;
  workDir: string;
  batcher?: (send: (b: AgentEvent[]) => Promise<void>) => Batcher;
}): Promise<number> {
  let brief: AgentBrief;
  try {
    brief = await o.client.brief();
  } catch (error) {
    warn("fetching the brief failed", error);
    return 1;
  }

  await mkdir(o.workDir, { recursive: true });
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

  const failure = await runClaude(o, brief, verdictPath, {
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
  const reported = await report(o.client, failure, verdictPath);
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

  const child = spawn(
    o.claudeBin,
    [
      ...(o.claudeArgs ?? []),
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      brief.model,
      "--dangerously-skip-permissions",
    ],
    { cwd: o.repoDir, stdio: ["ignore", "pipe", "pipe"], env: claudeEnv() },
  );
  const finishedWith = new Promise<string | undefined>((resolve) => {
    child.once("error", (error: NodeJS.ErrnoException) =>
      resolve(`cannot start claude: ${error.code ?? error.message}`),
    );
    child.once("close", (code, signal) =>
      resolve(code === 0 ? undefined : `claude exited ${code ?? signal}`),
    );
  });
  // Lines are handled as they arrive, so nothing waits on a send to Dispatch.
  createInterface({ input: child.stdout }).on("line", onLine.stdout);
  createInterface({ input: child.stderr }).on("line", onLine.stderr);
  return finishedWith;
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
): Promise<boolean> {
  const outcome = failure === undefined ? await readVerdict(verdictPath) : { failure };
  if ("failure" in outcome) {
    try {
      await client.failure(outcome.failure);
      return true;
    } catch (error) {
      warn("reporting the failure failed", error);
      return false;
    }
  }
  try {
    await client.verdict(outcome.verdict);
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
