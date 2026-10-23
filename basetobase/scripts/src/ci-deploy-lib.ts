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
  now(): number;
  log(line: string): void;
  // A line for the job summary, which is also where a failure's reason goes.
  summary(line: string): void;
}

export type Outcome = "skipped" | "deployed" | "rolled back" | "failed";

export interface Timing {
  pollMs: number;
  // How long /health has to show the new version, and later the one rolled back to. Measured by
  // the clock: a /health call that hangs counts against it.
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

// Why this commit needs no deploy, or undefined when it does.
export async function skipReason(
  io: DeployIO,
  live: Health | undefined,
  sha: string,
): Promise<string | undefined> {
  if (!live?.tag) return undefined;
  const liveShort = live.tag.slice(0, 7);
  // A commit main no longer has (history rewritten) says nothing about what is live.
  const known = live.tag !== sha && (await io.hasCommit(live.tag));
  // Deploys can finish out of order. A newer live commit wins even while unhealthy: its own job
  // rolls it back, and an older one would not mend it.
  if (known && (await io.isAncestor(sha, live.tag))) return `a newer commit (${liveShort}) is already live`;
  if (!live.ok) return undefined;
  if (live.tag === sha) return "this commit is already live";
  if (known && !(await io.workerChanged(live.tag, sha))) {
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
  // wrangler can fail after the version went live (its cron and workers.dev route come after), so
  // /health says what happened either way.
  const deployed = await io.wrangler(["deploy", "--tag", sha, "--message", message]);
  const { found, last } = await waitFor(io, timing, (h) => h.ok && h.tag === sha);
  if (found && deployed) {
    io.summary(`Deployed ${short} as version ${found.version}.`);
    return "deployed";
  }
  if (found) {
    io.summary(
      `${short} serves healthy as version ${found.version}, but wrangler deploy failed after it went ` +
        "live, so its cron or workers.dev route may be stale. Rerun this job.",
    );
    return "failed";
  }
  if (!deployed && last?.tag !== sha) {
    // Another version answers, so this one never went out; a rollback would only undo that one.
    if (last) {
      io.summary(`Not deployed: wrangler deploy failed for ${short}. ${describe(last)}.`);
      return "failed";
    }
    // No answer, and no version known to go back to: a rollback could go one too far.
    if (!before) {
      io.summary(
        `wrangler deploy failed for ${short}, and /health never answered. ` +
          "See what serves: npx wrangler deployments list",
      );
      return "failed";
    }
    // No answer: it may have gone out broken. Going back to the version that served before is
    // harmless if it never left.
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
  const { found: back } = await waitFor(io, timing, (h) => (target ? h.version === target : h.tag !== sha));
  if (!back) {
    io.summary(`${failed}. Rolled back${target ? ` to version ${target}` : ""}; /health has not confirmed it.`);
  } else {
    const health = back.ok ? "healthy" : "unhealthy too";
    io.summary(`${failed}. Rolled back to version ${back.version}, ${health}.`);
  }
  return "rolled back";
}

// Polls /health until `good` holds or the time is up, and says what it saw last.
async function waitFor(
  io: DeployIO,
  timing: Timing,
  good: (health: Health) => boolean,
): Promise<{ found?: Health; last?: Health }> {
  const deadline = io.now() + timing.timeoutMs;
  for (;;) {
    const last = await io.health();
    if (last && good(last)) return { found: last, last };
    if (io.now() >= deadline) {
      io.log(`Gave up waiting. ${describe(last)}.`);
      return { last };
    }
    await io.sleep(timing.pollMs);
  }
}

function describe(health: Health | undefined): string {
  if (!health) return "Live: /health does not answer as Base to Base";
  const commit = health.tag ? `commit ${health.tag.slice(0, 7)}` : "deployed by hand";
  return `Live: version ${health.version}, ${commit}, ${health.ok ? "healthy" : "unhealthy"}`;
}
