import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// The preinstalled build that @playwright/test's pinned version drives; never `playwright install`.
const CHROMIUM = process.env.E2E_CHROMIUM ?? "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: ".",
  globalSetup: "./global-setup.ts",
  outputDir: path.join(os.tmpdir(), "basetobase-e2e-results"),
  // One stack for every test, and timing assertions that a busy machine would skew.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    browserName: "chromium",
    launchOptions: { executablePath: CHROMIUM },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "phone", use: { viewport: { width: 390, height: 844 } } },
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
  ],
});
