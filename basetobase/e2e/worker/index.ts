import { createRemoteJWKSet } from "jose";
import production, { createApp, LobbyDO, RunDO } from "../../dispatch/src/index.ts";
import { OIDC_KEYS_PATH } from "../stack.ts";

// The production Worker, but agents' OIDC tokens are checked against the fake GitHub's key set:
// only Actions can mint a token that GitHub's own set verifies.
let app: ReturnType<typeof createApp> | undefined;

export default {
  fetch(request, env, ctx) {
    // Built on the first request: the fake's address is in the environment.
    app ??= createApp({ agentKey: createRemoteJWKSet(new URL(OIDC_KEYS_PATH, env.GITHUB_API)) });
    return app.fetch(request, env, ctx);
  },
  scheduled: production.scheduled,
} satisfies ExportedHandler<Env>;

export { LobbyDO, RunDO };
