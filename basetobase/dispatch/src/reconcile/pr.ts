import picomatch from "picomatch";
import { config } from "../../../shared/src/config.ts";
import { rateChange, triage, type ChangedFile } from "../../../shared/src/triage.ts";
import {
  createGitHubClient,
  type CheckRunCreate,
  type GitHubApp,
  type GitHubClient,
  type PullState,
} from "../github/client.ts";
import type { PullRequestRef } from "../github/webhook.ts";
import { CHECK_NAME } from "../run/machine.ts";
import {
  activeRunNames,
  findOpenRuns,
  findPrRuns,
  runStub,
  type IndexedRun,
} from "../runs/index.ts";

// What could not be done when GitHub failed: the webhook's answer, and the cron's log.
export const READ_FAILED = "could not read the pull request from GitHub";
const CHECK_FAILED = "could not post the check run to GitHub";

// Matched as triage matches its globs.
const matchesUnpatrolled = picomatch(config.unpatrolledGlobs, { dot: true, nocase: true });

// What a reconcile asked of the PR's runs, by run id.
export interface Reconciled {
  landed: string[];
  stopped: string[];
  retitled: string[];
}

export type Started =
  | { runId: string }
  | { ignored: "stale" | "draft" | "base" | "duplicate" | "unpatrolled" };

// A GitHub call failed. `what` says what could not be done; the message is the client's, which
// carries a status and path only, never a token or key.
export class GitHubFailure extends Error {
  readonly what: string;

  constructor(what: string, cause: unknown) {
    super(messageOf(cause));
    this.what = what;
  }
}

export function githubApp(env: Env): GitHubApp {
  return {
    appId: env.GITHUB_APP_ID,
    privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
    fetch: (input, init) => fetch(input, init),
    apiBase: env.GITHUB_API,
  };
}

// The factory throws on a key it cannot use, which fails the read the caller was about to make.
export function githubClient(env: Env, installationId: number): GitHubClient {
  try {
    return createGitHubClient({ ...githubApp(env), installationId });
  } catch (error) {
    throw new GitHubFailure(READ_FAILED, error);
  }
}

// Brings the PR's open runs in line with the PR as GitHub has it: `live`, or a fresh read. Safe
// to repeat, so every path ends with it and the cron runs it as a safety net.
export async function reconcilePr(
  env: Env,
  github: GitHubClient,
  repo: string,
  prNumber: number,
  live?: PullState,
): Promise<Reconciled> {
  const pull = live ?? (await fromGitHub(READ_FAILED, () => github.pullState(repo, prNumber)));
  let landed: IndexedRun | undefined;
  if (pull.state === "closed" && pull.merged) {
    // Whatever its status: a run stopped on the merged head still reviewed what merged.
    landed = newest(onHead(await findPrRuns(env.DB, repo, prNumber), pull.headSha));
    if (landed?.status === "landed") landed = undefined;
    if (landed !== undefined) await runStub(env, landed.id).land(pull.mergeSha);
  }
  const runs = await findOpenRuns(env.DB, repo, prNumber);
  // Its index row may not say landed yet.
  const open = runs.filter((run) => run.id !== landed?.id);
  // Only a ready PR into the default branch keeps a run: a check on a head vouches for every PR
  // on it.
  const patrolled = pull.state === "open" && !pull.draft && pull.baseRef === pull.defaultBranch;
  const kept = patrolled ? newest(onHead(open, pull.headSha)) : undefined;
  const stale = open.filter((run) => run !== kept);
  const retitled = pull.state === "open" ? open.filter((run) => run.prTitle !== pull.title) : [];
  await Promise.all(
    open.map(async (run) => {
      const stub = runStub(env, run.id);
      if (retitled.includes(run)) await stub.retitle(pull.title);
      if (stale.includes(run)) await stub.stop(stopReason(pull, run));
    }),
  );
  return { landed: landed ? [landed.id] : [], stopped: ids(stale), retitled: ids(retitled) };
}

// The start path for an event's PR head, for the webhook and the cron alike. Old runs are stopped
// only once the check or the run that replaces them stands, so a failure leaves them as they were.
export async function startPr(
  env: Env,
  github: GitHubClient,
  pr: PullRequestRef,
  retarget = false,
): Promise<Started> {
  // Deliveries come late and out of order: the PR may have closed or moved on since.
  const live = await fromGitHub(READ_FAILED, () => github.pullState(pr.repo, pr.number));
  if (live.state !== "open" || live.headSha !== pr.headSha) return { ignored: "stale" };
  // Not patrolled, but the PR has left its old head's runs all the same.
  const passOver = async (reason: "draft" | "base" | "unpatrolled"): Promise<Started> => {
    await reconcilePr(env, github, pr.repo, pr.number, live);
    return { ignored: reason };
  };
  if (live.draft) return passOver("draft");
  // Only PRs into the default branch: a check on a head vouches for every PR on it.
  if (live.baseRef !== live.defaultBranch) return passOver("base");
  // A retarget changed the diff, so a run on this head reviewed another one.
  if (!retarget) {
    const open = await findOpenRuns(env.DB, pr.repo, pr.number);
    if (open.some((run) => run.headSha === pr.headSha)) return { ignored: "duplicate" };
  }
  const files = await fromGitHub(READ_FAILED, () => github.listPullFiles(pr.repo, pr.number));
  if (files.some(isUnpatrolled)) {
    // Neutral passes the required check, so an unpatrolled PR can still merge. Posted before any
    // run is stopped, so a failure leaves the PR as it was.
    const check = unpatrolledCheck(pr.headSha);
    await fromGitHub(CHECK_FAILED, () => github.createCheckRun(pr.repo, check));
    return passOver("unpatrolled");
  }

  const runId = crypto.randomUUID();
  // The names only keep runs of one rating apart, so a failed read costs nothing that matters.
  const names = await activeRunNames(env.DB, rateChange(files, config)).catch((error) => {
    console.error(`run names for ${pr.repo}#${pr.number}: ${messageOf(error)}`);
    return [];
  });
  await runStub(env, runId).start(pr, runId, triage(files, names, config));
  // The old runs go only now that the new one stands. A fresh read: of two racing starts, the one
  // that reconciles last sees both, and either way the newest run on the PR's head is kept.
  try {
    await reconcilePr(env, github, pr.repo, pr.number);
  } catch (error) {
    // The run has started; the cron stops what this left.
    console.error(`reconciling ${pr.repo}#${pr.number} after run ${runId}: ${explain(error)}`);
  }
  return { runId };
}

// The closed path. A late delivery may describe a PR since reopened, so GitHub says what to do.
export async function closePr(
  env: Env,
  github: GitHubClient,
  repo: string,
  prNumber: number,
): Promise<Reconciled | { ignored: "stale" }> {
  const live = await fromGitHub(READ_FAILED, () => github.pullState(repo, prNumber));
  if (live.state === "open") return { ignored: "stale" };
  return reconcilePr(env, github, repo, prNumber, live);
}

// Every run of the PR, finished ones too: the runs list files them under its title.
export async function retitlePr(
  env: Env,
  repo: string,
  prNumber: number,
  title: string,
): Promise<string[]> {
  const runs = await findPrRuns(env.DB, repo, prNumber);
  await Promise.all(runs.map((run) => runStub(env, run.id).retitle(title)));
  return ids(runs);
}

// A failure as a log line: what could not be done, and why.
export function explain(error: unknown): string {
  return error instanceof GitHubFailure ? `${error.what}: ${error.message}` : messageOf(error);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fromGitHub<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new GitHubFailure(what, error);
  }
}

// The latest start wins, so every reconcile, whichever saw the runs first, keeps the same one.
function newest(runs: IndexedRun[]): IndexedRun | undefined {
  let best: IndexedRun | undefined;
  for (const run of runs) {
    const later =
      best === undefined ||
      run.createdAt > best.createdAt ||
      (run.createdAt === best.createdAt && run.id > best.id);
    if (later) best = run;
  }
  return best;
}

function onHead(runs: IndexedRun[], headSha: string): IndexedRun[] {
  return runs.filter((run) => run.headSha === headSha);
}

function ids(runs: IndexedRun[]): string[] {
  return runs.map((run) => run.id);
}

function stopReason(pull: PullState, run: IndexedRun): string {
  if (pull.state === "closed") return pull.merged ? "PR merged" : "PR closed";
  if (run.headSha === pull.headSha && pull.draft) return "PR marked draft";
  if (run.headSha === pull.headSha && pull.baseRef !== pull.defaultBranch) {
    return `PR retargeted to ${pull.baseRef}`;
  }
  // Until the huddle (M3), a push means a fresh sweep.
  return `superseded by ${pull.headSha.slice(0, 7)}`;
}

// Base to Base's own files go unpatrolled until it can deploy itself (spec §8). A rename counts
// from either side, so moving a file out of them does not slip past.
function isUnpatrolled(file: ChangedFile): boolean {
  return (
    matchesUnpatrolled(file.path) ||
    (file.previousPath !== undefined && matchesUnpatrolled(file.previousPath))
  );
}

function unpatrolledCheck(headSha: string): CheckRunCreate {
  const globs = config.unpatrolledGlobs.map((glob) => `\`${glob}\``).join(", ");
  return {
    name: CHECK_NAME,
    head_sha: headSha,
    status: "completed",
    conclusion: "neutral",
    output: {
      title: "Not patrolled until M5",
      summary:
        `This PR touches Base to Base's own files (${globs}), ` +
        "which it does not patrol until it can deploy itself (M5).",
    },
  };
}
