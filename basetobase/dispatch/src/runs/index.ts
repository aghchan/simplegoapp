import type { Rating } from "../../../shared/src/config.ts";
import type { RunSnapshot, RunSummary, StepId, StepSnapshot } from "../../../shared/src/types.ts";
import type { RunDO } from "../run/do.ts";

const DEFAULT_LIST_LIMIT = 50;

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
         updated_at AS updatedAt FROM runs
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

export async function findActiveRuns(
  db: D1Database,
  repo: string,
  prNumber: number,
): Promise<{ id: string; headSha: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT id, head_sha AS headSha FROM runs
       WHERE repo = ? AND pr_number = ? AND status = 'on_the_hill'`,
    )
    .bind(repo, prNumber)
    .all<{ id: string; headSha: string }>();
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
