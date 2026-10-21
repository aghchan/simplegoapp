// The local stack's identity and test secrets, shared by the harness and the tests.
export const OWNER = "e2e-owner";
export const REPO = "e2e-owner/simplegoapp";
export const INSTALLATION_ID = 7;
export const SESSION_SECRET = "e2e-session-secret";
export const WEBHOOK_SECRET = "e2e-webhook-secret";

// Set by global-setup.ts once `wrangler dev` answers.
export const BASE_URL_ENV = "E2E_BASE_URL";
