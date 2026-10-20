import { Hono, type Context } from "hono";
import { config } from "../../../shared/src/config.ts";
import { rateChange, triage, type ChangedFile } from "../../../shared/src/triage.ts";
import { createGitHubClient } from "../github/client.ts";
import { toTrigger, verifyWebhookSignature, type PullRequestRef } from "../github/webhook.ts";
import { activeRunNames, findActiveRuns, runStub } from "../runs/index.ts";
import { parseJson, readBody, reject } from "./request.ts";

type WebhookContext = Context<{ Bindings: Env }>;

const WEBHOOK_MAX_BYTES = 1024 * 1024;

export function githubRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post("/webhook", async (c) => {
    const body = await readBody(c.req.raw, WEBHOOK_MAX_BYTES);
    const signature = c.req.header("X-Hub-Signature-256") ?? null;
    if (!(await verifyWebhookSignature(c.env.GITHUB_WEBHOOK_SECRET, body, signature))) {
      reject(401, "invalid signature");
    }
    const trigger = toTrigger(c.req.header("X-GitHub-Event") ?? null, parseJson(body), {
      owner: c.env.OWNER_LOGIN,
      repo: c.env.REPO,
    });
    switch (trigger.kind) {
      case "ignore":
        return c.json({ ignored: trigger.reason });
      case "stop":
        // The payload's repo, not ours: a close in another repository finds no run.
        return c.json({ stopped: await stopRuns(c.env, trigger.repo, trigger.prNumber) });
      case "start":
        return startRun(c, trigger.pr);
    }
  });

  return routes;
}

async function stopRuns(env: Env, repo: string, prNumber: number): Promise<string[]> {
  const runs = await findActiveRuns(env.DB, repo, prNumber);
  await Promise.all(runs.map((run) => runStub(env, run.id).stop("PR closed")));
  return runs.map((run) => run.id);
}

async function startRun(c: WebhookContext, pr: PullRequestRef): Promise<Response> {
  const active = await findActiveRuns(c.env.DB, pr.repo, pr.number);
  if (active.some((run) => run.headSha === pr.headSha)) return c.json({ ignored: "duplicate" });

  let files: ChangedFile[];
  try {
    // Built here because the factory throws on a key it cannot use.
    const github = createGitHubClient({
      appId: c.env.GITHUB_APP_ID,
      privateKeyPem: c.env.GITHUB_APP_PRIVATE_KEY,
      installationId: pr.installationId,
      fetch: (input, init) => fetch(input, init),
      apiBase: c.env.GITHUB_API,
    });
    files = await github.listPullFiles(pr.repo, pr.number);
  } catch (error) {
    // The client's messages carry a status and path only, never a token or key.
    const why = error instanceof Error ? error.message : String(error);
    console.error(`webhook: reading ${pr.repo}#${pr.number} from GitHub failed: ${why}`);
    return c.json({ error: "could not read the pull request from GitHub" }, 502);
  }

  const runId = crypto.randomUUID();
  const names = await activeRunNames(c.env.DB, rateChange(files, config));
  await runStub(c.env, runId).start(pr, runId, triage(files, names, config));
  return c.json({ runId }, 202);
}
