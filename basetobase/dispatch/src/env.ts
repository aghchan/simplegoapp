// Worker secrets. Set each with `wrangler secret put <NAME>`; never commit them. `wrangler types`
// cannot see secrets, so they are declared here and merged onto the generated environment type.
//
//   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (PKCS#8 PEM)  the GitHub App that dispatches agent runs
//   GITHUB_WEBHOOK_SECRET                               verifies webhook deliveries
//   GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET  the OAuth app behind owner sign-in
//   SESSION_SECRET                                      signs the dashboard session cookie
declare global {
  namespace Cloudflare {
    interface Env {
      GITHUB_APP_ID: string;
      GITHUB_APP_PRIVATE_KEY: string;
      GITHUB_WEBHOOK_SECRET: string;
      GITHUB_OAUTH_CLIENT_ID: string;
      GITHUB_OAUTH_CLIENT_SECRET: string;
      SESSION_SECRET: string;
      // Tests only: dispatch/vitest.config.ts reads the migrations and binds them for setup.
      TEST_MIGRATIONS: { name: string; queries: string[] }[];
    }
  }
  // wrangler types declares Env beside Cloudflare.Env, not as an alias, so it needs them too.
  interface Env extends Cloudflare.Env {}
}

export {};
