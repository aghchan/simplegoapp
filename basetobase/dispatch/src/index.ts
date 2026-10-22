import { Hono } from "hono";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import { GITHUB_OIDC_ISSUER } from "./auth/oidc.ts";
import { LobbyDO } from "./lobby/do.ts";
import { reconcileRepo } from "./reconcile/cron.ts";
import { agentRoutes } from "./routes/agent.ts";
import { apiRoutes } from "./routes/api.ts";
import { authRoutes } from "./routes/auth.ts";
import { githubRoutes } from "./routes/github.ts";
import { RunDO } from "./run/do.ts";

export interface Deps {
  // Verifies the agent's OIDC token; GitHub's key set in production, a local one in tests.
  agentKey: JWTVerifyGetKey;
}

export function createApp(deps: Deps): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/github", githubRoutes());
  app.route("/agent", agentRoutes(deps.agentKey));
  app.route("/auth", authRoutes());
  app.route("/api", apiRoutes());
  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}

export default {
  fetch: createApp({
    agentKey: createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`)),
  }).fetch,
  // The reconcile cron (wrangler.jsonc triggers.crons).
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await reconcileRepo(env);
  },
};

export { LobbyDO, RunDO };
