import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createLocalJWKSet } from "jose";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/index.ts";
import { envWith } from "./helpers.ts";

const app = createApp({ agentKey: createLocalJWKSet({ keys: [] }) });

function version(tag: string): WorkerVersionMetadata {
  return { id: "5c1f2a6e-version", tag, timestamp: "2026-10-22T18:00:00Z" };
}

async function health(workerEnv: Env, method = "GET"): Promise<Response> {
  const req = new Request("https://b2b.test/health", { method });
  return app.fetch(req, workerEnv, createExecutionContext());
}

describe("GET /health", () => {
  it("names the running version and the commit it was tagged with, signed out", async () => {
    const res = await health(envWith(env, { CF_VERSION_METADATA: version("4f7e2a1c") }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, version: "5c1f2a6e-version", tag: "4f7e2a1c" });
  });

  it("has no commit for a version deployed by hand, which sets no tag", async () => {
    const res = await health(envWith(env, { CF_VERSION_METADATA: version("") }));
    expect(await res.json()).toEqual({ ok: true, version: "5c1f2a6e-version", tag: null });
  });

  it("answers 503 when the database cannot be reached", async () => {
    const broken = {
      prepare: () => ({
        first: () => Promise.reject(new Error("D1_ERROR: no such database")),
      }),
    };
    const res = await health(envWith(env, { CF_VERSION_METADATA: version("4f7e2a1c"), DB: broken }));
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: false, version: "5c1f2a6e-version", tag: "4f7e2a1c" });
  });

  it("answers only GET", async () => {
    const res = await health(envWith(env, { CF_VERSION_METADATA: version("4f7e2a1c") }), "POST");
    expect(res.status).toBe(404);
  });
});
