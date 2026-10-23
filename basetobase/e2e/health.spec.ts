import { expect, test } from "@playwright/test";
import { baseURL } from "./dashboard.ts";

// The deploy job reads GET /health through the whole stack, assets layer included: without its
// `run_worker_first` entry, the dashboard's page answers instead and every deploy rolls back.
test("GET /health reaches the Worker, not the dashboard's page", async ({ request }) => {
  const res = await request.get(`${baseURL}/health`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/json");
  expect(res.headers()["cache-control"]).toBe("no-store");
  const body = (await res.json()) as { ok: boolean; version: unknown; tag: unknown };
  expect(body.ok).toBe(true);
  expect(typeof body.version).toBe("string");
});
