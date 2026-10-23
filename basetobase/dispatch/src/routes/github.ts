import { Hono, type Context } from "hono";
import type { GitHubClient } from "../github/client.ts";
import { toTrigger, verifyWebhookSignature } from "../github/webhook.ts";
import {
  closePr,
  explain,
  githubClient,
  GitHubFailure,
  retitlePr,
  startPr,
} from "../reconcile/pr.ts";
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
      case "retitle":
        return withGitHub(c, trigger, async (github) =>
          c.json({ retitled: await retitlePr(c.env, github, trigger.repo, trigger.prNumber) }),
        );
      case "closed":
        return withGitHub(c, trigger, async (github) =>
          c.json(await closePr(c.env, github, trigger.repo, trigger.prNumber)),
        );
      case "start": {
        const { pr, retarget } = trigger;
        const target = { repo: pr.repo, prNumber: pr.number, installationId: pr.installationId };
        return withGitHub(c, target, async (github) => {
          const started = await startPr(c.env, github, pr, retarget);
          return "runId" in started ? c.json(started, 202) : c.json(started);
        });
      }
    }
  });

  return routes;
}

// Acts on the PR as its installation. A GitHub failure is answered 502 for the App's delivery
// log; any other is Dispatch's own and fails as such.
async function withGitHub(
  c: WebhookContext,
  target: { repo: string; prNumber: number; installationId: number },
  act: (github: GitHubClient) => Promise<Response>,
): Promise<Response> {
  try {
    return await act(githubClient(c.env, target.installationId));
  } catch (error) {
    if (!(error instanceof GitHubFailure)) throw error;
    console.error(`webhook: ${target.repo}#${target.prNumber}: ${explain(error)}`);
    return c.json({ error: error.what, ...githubStatus(error.message) }, 502);
  }
}

// GitHub's answer, for the delivery log: 403 means a permission the App lacks. The status alone,
// never the message, which could quote more than the client's status-and-path rule allows.
function githubStatus(why: string): { github_status?: number } {
  const status = /failed with status (\d{3})\b/.exec(why)?.[1];
  return status ? { github_status: Number(status) } : {};
}
