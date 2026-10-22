// basetobase-ci's deploy, on main only, from basetobase/:
//   node scripts/src/ci-deploy.ts plan    whether to deploy, as `deploy=true|false` in GITHUB_OUTPUT
//   node scripts/src/ci-deploy.ts deploy  after `npm run build`: migrate, deploy, check, roll back
// Both need BASETOBASE_URL and DEPLOY_SHA. `deploy` also needs CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID, the production environment's, which wrangler reads from the environment.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parseHealth, planDeploy, runDeploy, workerDiffArgs, type DeployIO } from "./ci-deploy-lib.ts";

const HEALTH_TIMEOUT_MS = 10_000;
const SETUP_HINT = "Auto-deploy is not set up: run `npm run setup:deploy` on your machine.";

function fail(message: string): never {
  console.log(`::error::${message}`);
  process.exit(1);
}

function required(name: string, hint = ""): string {
  const value = process.env[name];
  if (!value) fail(`${name} is not set.${hint && ` ${hint}`}`);
  return value;
}

// git's answers go to the caller, not the log; wrangler's progress goes to the log.
function run(cmd: string, args: string[], quiet: boolean): Promise<{ status: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", quiet ? "pipe" : "inherit", quiet ? "pipe" : "inherit"] });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => resolve({ status: -1, out }));
    child.on("close", (status) => resolve({ status: status ?? -1, out }));
  });
}

const mode = process.argv[2];
if (mode !== "plan" && mode !== "deploy") fail("usage: ci-deploy.ts plan|deploy");
const sha = required("DEPLOY_SHA");
const url = required("BASETOBASE_URL").replace(/\/+$/, "");
const summaries: string[] = [];

const io: DeployIO = {
  async health() {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      // 503 carries the same body; a version older than /health answers the dashboard's page.
      return parseHealth(await res.json());
    } catch {
      return undefined;
    }
  },
  hasCommit: async (commit) => (await run("git", ["cat-file", "-e", `${commit}^{commit}`], true)).status === 0,
  isAncestor: async (ancestor, descendant) =>
    (await run("git", ["merge-base", "--is-ancestor", ancestor, descendant], true)).status === 0,
  // Exit 1 is a difference; any other failure counts as one too, so a broken check deploys.
  workerChanged: async (from, to) => (await run("git", workerDiffArgs(from, to), true)).status !== 0,
  subject: async (commit) => (await run("git", ["log", "-1", "--format=%s", commit], true)).out.trim(),
  wrangler: async (args) => (await run("npx", ["wrangler", ...args], false)).status === 0,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
  summary(line) {
    summaries.push(line);
    console.log(line);
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (file) appendFileSync(file, `${line}\n`);
  },
};

if (mode === "plan") {
  const deploy = await planDeploy(io, sha);
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `deploy=${deploy}\n`);
} else {
  required("CLOUDFLARE_API_TOKEN", SETUP_HINT);
  required("CLOUDFLARE_ACCOUNT_ID", SETUP_HINT);
  const outcome = await runDeploy(io, sha);
  if (outcome === "rolled back" || outcome === "failed") fail(summaries.at(-1) ?? `deploy ${outcome}`);
}
