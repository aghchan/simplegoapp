import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest(({ inject }) => ({
        wrangler: { configPath: "../wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            GITHUB_APP_ID: "12345",
            GITHUB_APP_PRIVATE_KEY: inject<string>("githubAppPrivateKey"),
            GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
            GITHUB_OAUTH_CLIENT_ID: "test-oauth-client",
            GITHUB_OAUTH_CLIENT_SECRET: "test-oauth-secret",
            SESSION_SECRET: "test-session-secret",
          },
        },
      })),
    ],
    test: {
      name: "dispatch",
      globalSetup: ["./test/global-setup.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
