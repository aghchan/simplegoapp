import { join } from "node:path";
import { createDispatchClient, githubOidcToken } from "./client.ts";
import { runAgent } from "./run.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return value;
}

const runId = required("RUN_ID");
const agentId = required("AGENT_ID");
const nonce = required("NONCE");
const dispatchUrl = required("DISPATCH_URL");
const runnerTemp = required("RUNNER_TEMP");
const repoDir = required("B2B_REPO_DIR");
const templatesDir = required("B2B_TEMPLATES_DIR");

const client = createDispatchClient({
  baseUrl: dispatchUrl,
  runId,
  agentId,
  nonce,
  token: githubOidcToken(process.env, dispatchUrl),
});

process.exit(
  await runAgent({
    client,
    claudeBin: "claude",
    repoDir,
    templatesDir,
    workDir: join(runnerTemp, "basetobase"),
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  }),
);
