import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["shared/test/**/*.test.ts", "forwarder/test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [react()],
        test: {
          name: "dashboard",
          include: ["dashboard/test/**/*.test.{ts,tsx}"],
          environment: "jsdom",
        },
      },
      "dispatch/vitest.config.ts",
    ],
  },
});
