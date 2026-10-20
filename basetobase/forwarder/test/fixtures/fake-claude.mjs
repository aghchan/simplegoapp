// Stands in for the claude binary: replays stream.jsonl, writes a verdict, exits.
// FAKE_VERDICT_DIR + FAKE_VERDICT (valid | none | broken) control the verdict file; FAKE_EXIT the exit code.
// FAKE_SPLIT writes every line in two chunks, FAKE_STDERR adds a stderr line, FAKE_LEAK echoes the
// secrets a real agent could echo, FAKE_ARGS_FILE records how the process was started.
import { readFileSync, writeFileSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const env = process.env;

if (env.FAKE_ARGS_FILE) {
  writeFileSync(
    env.FAKE_ARGS_FILE,
    JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      stdinIsDevNull: fstatSync(0).isCharacterDevice(),
    }),
  );
}

const lines = readFileSync(new URL("./stream.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean);
if (env.FAKE_LEAK) {
  const text = `env ${env.NONCE} ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN} ${env.CLAUDE_CODE_OAUTH_TOKEN}`;
  lines.splice(
    2,
    0,
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
  );
}

for (const line of lines) {
  if (env.FAKE_SPLIT) {
    const middle = Math.floor(line.length / 2);
    process.stdout.write(line.slice(0, middle));
    await sleep(30);
    process.stdout.write(`${line.slice(middle)}\n`);
    await sleep(30);
  } else {
    process.stdout.write(`${line}\n`);
  }
}
if (env.FAKE_STDERR) process.stderr.write(`${env.FAKE_STDERR}\n`);

const verdicts = {
  valid: JSON.stringify({
    role: "mainline",
    headSha: "head58",
    status: "clear",
    hazards: [],
    summary: "Works.",
  }),
  broken: "{not json",
};
const verdict = verdicts[env.FAKE_VERDICT ?? "none"];
if (verdict !== undefined) writeFileSync(join(env.FAKE_VERDICT_DIR, "verdict.json"), verdict);

process.exitCode = Number(env.FAKE_EXIT ?? 0);
