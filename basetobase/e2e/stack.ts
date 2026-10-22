// The local stack's identity and test secrets, shared by the harness and the tests.
export const OWNER = "e2e-owner";
export const REPO = "e2e-owner/simplegoapp";
export const INSTALLATION_ID = 7;
export const SESSION_SECRET = "e2e-session-secret";
export const WEBHOOK_SECRET = "e2e-webhook-secret";
// Where the fake GitHub serves the key set its agents' OIDC tokens are signed with.
export const OIDC_KEYS_PATH = "/__oidc/jwks";
// wrangler.jsonc triggers.crons.
export const RECONCILE_CRON = "*/5 * * * *";

// Set by global-setup.ts once `wrangler dev` answers.
export const BASE_URL_ENV = "E2E_BASE_URL";
// The fake GitHub's origin, so tests can set its PRs and read what Dispatch asked of it (/__*).
export const GITHUB_URL_ENV = "E2E_GITHUB_URL";
