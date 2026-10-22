import { repoInstallationId, type OpenPull } from "../github/client.ts";
import type { PullRequestRef } from "../github/webhook.ts";
import { CHECK_NAME } from "../run/machine.ts";
import { hasRunOnHead, openRunPrs } from "../runs/index.ts";
import {
  explain,
  githubApp,
  githubClient,
  reconcilePr,
  startPr,
  type Reconciled,
} from "./pr.ts";

// A tick looks at no more PRs than this.
export const PRS_PER_TICK = 50;

// The safety net under the webhook, which GitHub never redelivers when it fails: a tick reconciles
// every PR with an open run, then gives the start path to each owner PR whose head has neither a
// run nor a check. One PR's failure is logged and the tick goes on.
export async function reconcileRepo(env: Env): Promise<void> {
  const installationId = await repoInstallationId(githubApp(env), env.REPO);
  const github = githubClient(env, installationId);
  let budget = PRS_PER_TICK;

  for (const { repo, prNumber } of (await openRunPrs(env.DB)).slice(0, budget)) {
    budget--;
    await logged(repo, prNumber, async () =>
      changes(await reconcilePr(env, github, repo, prNumber)),
    );
  }

  for (const pull of await github.listOpenPulls(env.REPO)) {
    if (budget <= 0) break;
    if (!patrolled(env, pull)) continue;
    budget--;
    await logged(env.REPO, pull.number, async () => {
      if (await hasRunOnHead(env.DB, env.REPO, pull.number, pull.headSha)) return undefined;
      if (await github.hasCheckRun(env.REPO, pull.headSha, CHECK_NAME)) return undefined;
      const started = await startPr(env, github, refOf(env, pull, installationId));
      const head = pull.headSha.slice(0, 7);
      return "runId" in started
        ? `started ${started.runId} on ${head}`
        : `ignored ${head}: ${started.ignored}`;
    });
  }
}

// Whom the webhook would start a run for: the owner's own PRs, ready, into the default branch.
function patrolled(env: Env, pull: OpenPull): boolean {
  return (
    pull.author === env.OWNER_LOGIN &&
    pull.headRepo === env.REPO &&
    !pull.draft &&
    pull.baseRef === pull.defaultBranch
  );
}

function refOf(env: Env, pull: OpenPull, installationId: number): PullRequestRef {
  return {
    repo: env.REPO,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    url: pull.url,
    branch: pull.branch,
    headSha: pull.headSha,
    baseSha: pull.baseSha,
    baseRef: pull.baseRef,
    draft: pull.draft,
    defaultBranch: pull.defaultBranch,
    author: pull.author,
    installationId,
  };
}

// Undefined when the reconcile changed nothing.
function changes({ landed, stopped, retitled }: Reconciled): string | undefined {
  const parts = [
    landed.length > 0 ? `landed ${landed.join(", ")}` : "",
    stopped.length > 0 ? `stopped ${stopped.join(", ")}` : "",
    retitled.length > 0 ? `retitled ${retitled.join(", ")}` : "",
  ].filter((part) => part !== "");
  return parts.length > 0 ? parts.join("; ") : undefined;
}

// Logs what the work did, if anything, and any failure in its place.
async function logged(
  repo: string,
  prNumber: number,
  work: () => Promise<string | undefined>,
): Promise<void> {
  try {
    const done = await work();
    if (done !== undefined) console.log(`reconcile: ${repo}#${prNumber}: ${done}`);
  } catch (error) {
    console.error(`reconcile: ${repo}#${prNumber}: ${explain(error)}`);
  }
}
