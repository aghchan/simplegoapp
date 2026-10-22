import type { Rating } from "../../../shared/src/config.ts";
import type {
  RunSnapshot,
  RunStatus,
  RunSummary,
  StepId,
  StepSnapshot,
} from "../../../shared/src/types.ts";
import type { RunDO } from "../run/do.ts";

const DEFAULT_LIST_LIMIT = 50;
// Open runs still speak for their PR: a later push, close or merge must reach them.
const OPEN = "status IN ('on_the_hill', 'swept')";

// A PR's run as its reconcile reads it from the index.
export interface IndexedRun {
  id: string;
  headSha: string;
  status: RunStatus;
  prTitle: string;
  createdAt: number;
}

export function runStub(env: Env, runId: string): DurableObjectStub<RunDO> {
  return env.RUNS.get(env.RUNS.idFromName(runId));
}

export async function upsertRun(db: D1Database, s: RunSnapshot): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO runs (id, repo, pr_number, pr_title, head_sha, run_name, rating,
         status, outcome, current_step, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      s.id,
      s.repo,
      s.prNumber,
      s.prTitle,
      s.headSha,
      s.runName,
      s.rating,
      s.status,
      s.outcome,
      currentStep(s.steps),
      s.createdAt,
      s.updatedAt,
    )
    .run();
}

// The run as listRuns reads it back once upsertRun has written it.
export function summaryOf(s: RunSnapshot): RunSummary {
  return {
    id: s.id,
    prNumber: s.prNumber,
    prTitle: s.prTitle,
    runName: s.runName,
    rating: s.rating,
    status: s.status,
    outcome: s.outcome,
    currentStep: currentStep(s.steps),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export async function listRuns(
  db: D1Database,
  limit: number = DEFAULT_LIST_LIMIT,
): Promise<RunSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT id, pr_number AS prNumber, pr_title AS prTitle, run_name AS runName, rating, status,
         COALESCE(outcome, 'pending') AS outcome, current_step AS currentStep,
         created_at AS createdAt, updated_at AS updatedAt FROM runs
       ORDER BY status = 'on_the_hill' DESC, updated_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<RunSummary>();
  return results;
}

export async function activeRunNames(db: D1Database, rating: Rating): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT run_name AS runName FROM runs WHERE status = 'on_the_hill' AND rating = ?")
    .bind(rating)
    .all<{ runName: string }>();
  return results.map((row) => row.runName);
}

export async function findOpenRuns(
  db: D1Database,
  repo: string,
  prNumber: number,
): Promise<IndexedRun[]> {
  return prRuns(db, repo, prNumber, true);
}

export async function findPrRuns(
  db: D1Database,
  repo: string,
  prNumber: number,
): Promise<IndexedRun[]> {
  return prRuns(db, repo, prNumber, false);
}

export async function openRunPrs(db: D1Database): Promise<{ repo: string; prNumber: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT repo, pr_number AS prNumber FROM runs WHERE ${OPEN}
       ORDER BY repo, pr_number`,
    )
    .all<{ repo: string; prNumber: number }>();
  return results;
}

// Any run, whatever became of it.
export async function hasRunOnHead(
  db: D1Database,
  repo: string,
  prNumber: number,
  headSha: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM runs WHERE repo = ? AND pr_number = ? AND head_sha = ? LIMIT 1")
    .bind(repo, prNumber, headSha)
    .first();
  return row !== null;
}

async function prRuns(
  db: D1Database,
  repo: string,
  prNumber: number,
  openOnly: boolean,
): Promise<IndexedRun[]> {
  const { results } = await db
    .prepare(
      `SELECT id, head_sha AS headSha, status, pr_title AS prTitle, created_at AS createdAt
       FROM runs WHERE repo = ? AND pr_number = ? ${openOnly ? `AND ${OPEN}` : ""}`,
    )
    .bind(repo, prNumber)
    .all<IndexedRun>();
  return results;
}

// The step in progress, or for a finished run the last one it reached.
function currentStep(steps: StepSnapshot[]): StepId {
  const active = steps.find((step) => step.status === "active");
  const reached = steps.filter((step) => step.status !== "pending");
  const step = active ?? reached.at(-1) ?? steps[0];
  if (!step) throw new Error("a run has no steps");
  return step.id;
}
