// The deploy job's decisions (basetobase-ci). Side effects come in through DeployIO, so the tests
// drive the real sequence; scripts/src/ci-deploy.ts wires git, wrangler and fetch to it.
import { D1_NAME } from "./setup-lib.ts";

// What GET /health answers (dispatch/src/routes/health.ts). `tag` is the commit the deploy job
// shipped; a version deployed by hand has none.
export interface Health {
  ok: boolean;
  version: string;
  tag: string | null;
}

export interface DeployIO {
  // Undefined when /health does not answer as Base to Base does: down, or a version older than it.
  health(): Promise<Health | undefined>;
  hasCommit(sha: string): Promise<boolean>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  // Whether a file the Worker ships differs between the two commits (workerDiffArgs).
  workerChanged(from: string, to: string): Promise<boolean>;
  subject(sha: string): Promise<string>;
  // True when wrangler exits 0.
  wrangler(args: string[]): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  // A line for the job summary, which is also where a failure's reason goes.
  summary(line: string): void;
}

export type Outcome = "skipped" | "deployed" | "rolled back" | "failed";

export interface Timing {
  pollMs: number;
  // How long /health has to show the new version, and later the one rolled back to.
  timeoutMs: number;
}

export const TIMING: Timing = { pollMs: 3_000, timeoutMs: 120_000 };

// What the Worker ships, relative to basetobase/: everything but the runner, the owner's tools, the
// tests and the docs. Listed by exclusion, so a new directory deploys until someone decides it doesn't.
export const WORKER_PATHSPEC = [
  ".",
  ":(exclude)forwarder",
  ":(exclude)scripts",
  ":(exclude)e2e",
  ":(glob,exclude)**/test/**",
  ":(glob,exclude)**/*.md",
];

// `git diff --quiet` exits 1 when those files differ.
export function workerDiffArgs(from: string, to: string): string[] {
  return ["diff", "--quiet", from, to, "--", ...WORKER_PATHSPEC];
}

export function parseHealth(body: unknown): Health | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { ok, version, tag } = body as Record<string, unknown>;
  if (typeof ok !== "boolean" || typeof version !== "string" || version === "") return undefined;
  if (tag !== null && typeof tag !== "string") return undefined;
  return { ok, version, tag: tag || null };
}

// Why this commit needs no deploy, or undefined when it does. Only a healthy live version is kept.
export async function skipReason(
  io: DeployIO,
  live: Health | undefined,
  sha: string,
): Promise<string | undefined> {
  if (!live?.ok || !live.tag) return undefined;
  const liveShort = live.tag.slice(0, 7);
  if (live.tag === sha) return "this commit is already live";
  // A commit main no longer has (history rewritten) says nothing about what is live.
  if (!(await io.hasCommit(live.tag))) return undefined;
  // Deploys can finish out of order: a later push's job may have shipped first.
  if (await io.isAncestor(sha, live.tag)) return `a newer commit (${liveShort}) is already live`;
  if (!(await io.workerChanged(live.tag, sha))) {
    return `nothing the Worker ships changed since ${liveShort}, which is live`;
  }
  return undefined;
}

// The plan job's answer: whether the deploy job should run at all.
export async function planDeploy(io: DeployIO, sha: string): Promise<boolean> {
  const live = await io.health();
  io.log(describe(live));
  const skip = await skipReason(io, live, sha);
  io.summary(skip ? `No deploy for ${sha.slice(0, 7)}: ${skip}.` : `${sha.slice(0, 7)} deploys.`);
  return skip === undefined;
}

// Migrate, deploy, and check /health shows the commit serving; otherwise roll back to the version
// that served before. The plan is checked again first: another deploy may have finished meanwhile.
export async function runDeploy(io: DeployIO, sha: string, timing: Timing = TIMING): Promise<Outcome> {
  const short = sha.slice(0, 7);
  const before = await io.health();
  io.log(describe(before));
  const skip = await skipReason(io, before, sha);
  if (skip) {
    io.summary(`No deploy for ${short}: ${skip}.`);
    return "skipped";
  }

  // Before the code that needs them; migrations must suit the version still serving, too.
  if (!(await io.wrangler(["d1", "migrations", "apply", D1_NAME, "--remote"]))) {
    io.summary(`Not deployed: D1 migrations failed for ${short}. The Worker is unchanged.`);
    return "failed";
  }
  const message = `${short} ${await io.subject(sha)}`.slice(0, 100);
  if (!(await io.wrangler(["deploy", "--tag", sha, "--message", message]))) {
    const now = await io.health();
    if (now?.tag !== sha) {
      io.summary(`Not deployed: wrangler deploy failed for ${short}. ${describe(now)}.`);
      return "failed";
    }
    // It went out despite the error, so it is checked like any other.
  }

  const serving = await waitFor(io, timing, (h) => h.ok && h.tag === sha);
  if (serving) {
    io.summary(`Deployed ${short} as version ${serving.version}.`);
    return "deployed";
  }
  return rollBack(io, timing, before, sha);
}

async function rollBack(
  io: DeployIO,
  timing: Timing,
  before: Health | undefined,
  sha: string,
): Promise<Outcome> {
  const short = sha.slice(0, 7);
  const failed = `${short} never served a healthy /health within ${timing.timeoutMs / 1000} s`;
  // Without the version that served before, wrangler takes the one before the current.
  const target = before?.version;
  const args = ["rollback", ...(target ? [target] : []), "--yes", "--message", failed];
  if (!(await io.wrangler(args))) {
    io.summary(`${failed}, and the rollback failed too. Roll back by hand: npx wrangler rollback`);
    return "failed";
  }
  const back = await waitFor(io, timing, (h) => (target ? h.version === target : h.tag !== sha));
  if (!back) {
    io.summary(`${failed}. Rolled back${target ? ` to version ${target}` : ""}; /health has not confirmed it.`);
  } else {
    const health = back.ok ? "healthy" : "unhealthy too";
    io.summary(`${failed}. Rolled back to version ${back.version}, ${health}.`);
  }
  return "rolled back";
}

// Polls /health until `good` holds or the time is up.
async function waitFor(
  io: DeployIO,
  timing: Timing,
  good: (health: Health) => boolean,
): Promise<Health | undefined> {
  let last: Health | undefined;
  for (let waited = 0; ; waited += timing.pollMs) {
    last = await io.health();
    if (last && good(last)) return last;
    if (waited >= timing.timeoutMs) break;
    await io.sleep(timing.pollMs);
  }
  io.log(`Gave up waiting. ${describe(last)}.`);
  return undefined;
}

function describe(health: Health | undefined): string {
  if (!health) return "Live: /health does not answer as Base to Base";
  const commit = health.tag ? `commit ${health.tag.slice(0, 7)}` : "deployed by hand";
  return `Live: version ${health.version}, ${commit}, ${health.ok ? "healthy" : "unhealthy"}`;
}
