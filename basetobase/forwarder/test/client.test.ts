import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBrief, AgentEvent } from "../../shared/src/types.ts";
import { createDispatchClient, DispatchError, githubOidcToken } from "../src/client.ts";

const NONCE = "nonce-secret-0123";
const events: AgentEvent[] = [{ seq: 0, ts: 5, kind: "say", text: "hello" }];
const brief: AgentBrief = {
  role: "mainline",
  name: "Mainline",
  model: "sonnet",
  prefix: "FUN",
  goal: "g",
  prNumber: 1,
  baseSha: "b",
  headSha: "h",
};

interface Seen {
  method: string;
  url: URL;
  authorization: string | null;
  contentType: string | null;
  body: string;
}

function server(...responses: (Response | Error)[]) {
  const seen: Seen[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      authorization: headers.get("Authorization"),
      contentType: headers.get("Content-Type"),
      body:
        init?.body === undefined ? "" : Buffer.from(init.body as Uint8Array | string).toString(),
    });
    const next =
      responses[Math.min(seen.length, responses.length) - 1] ?? new Response(null, { status: 204 });
    if (next instanceof Error) throw next;
    return next.clone();
  });
  return { seen, fetch: fetch as unknown as typeof globalThis.fetch };
}

function clientOver(...responses: (Response | Error)[]) {
  const { seen, fetch } = server(...responses);
  const token = vi.fn(async (fresh?: boolean) => (fresh ? "token-fresh" : "token-1"));
  const client = createDispatchClient({
    baseUrl: "https://dispatch.test",
    runId: "run-1",
    agentId: "mainline-sweep-0",
    nonce: NONCE,
    token,
    fetch,
  });
  return { client, seen, token };
}

const status = (code: number, body = "") => new Response(body || null, { status: code });

describe("createDispatchClient", () => {
  it("fetches the brief with the agent identity in the query", async () => {
    const { client, seen } = clientOver(Response.json(brief));
    expect(await client.brief()).toEqual(brief);
    expect(seen[0]).toMatchObject({ method: "GET", authorization: "Bearer token-1" });
    expect(seen[0]?.url.href).toBe(
      `https://dispatch.test/agent/brief?run_id=run-1&agent_id=mainline-sweep-0&nonce=${NONCE}`,
    );
  });

  it("posts events as JSON with the identity in the body", async () => {
    const { client, seen } = clientOver();
    await client.events(events);
    expect(seen[0]).toMatchObject({
      method: "POST",
      contentType: "application/json",
      authorization: "Bearer token-1",
    });
    expect(seen[0]?.url.href).toBe("https://dispatch.test/agent/events");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      run_id: "run-1",
      agent_id: "mainline-sweep-0",
      nonce: NONCE,
      events,
    });
  });

  it("posts a verdict and a failure", async () => {
    const { client, seen } = clientOver();
    await client.verdict({ status: "clear" });
    await client.failure("claude exited 3");
    expect(seen.map((s) => s.url.pathname)).toEqual(["/agent/verdict", "/agent/failure"]);
    expect(JSON.parse(seen[0]?.body ?? "")).toMatchObject({
      verdict: { status: "clear" },
      nonce: NONCE,
    });
    expect(JSON.parse(seen[1]?.body ?? "")).toMatchObject({
      reason: "claude exited 3",
      nonce: NONCE,
    });
  });

  describe("transcript", () => {
    let dir: string;
    beforeEach(async () => void (dir = await mkdtemp(join(tmpdir(), "b2b-client-"))));
    afterEach(() => rm(dir, { recursive: true, force: true }));

    it("puts the file as the raw body with the identity in the query", async () => {
      const path = join(dir, "transcript.jsonl");
      await writeFile(path, '{"a":1}\n{"b":2}\n');
      const { client, seen } = clientOver();
      await client.transcript(path);
      expect(seen[0]).toMatchObject({ method: "PUT", body: '{"a":1}\n{"b":2}\n' });
      expect(seen[0]?.url.href).toBe(
        `https://dispatch.test/agent/transcript?run_id=run-1&agent_id=mainline-sweep-0&nonce=${NONCE}`,
      );
    });
  });

  it("retries once with a fresh token after a 401", async () => {
    const { client, seen, token } = clientOver(status(401), status(204));
    await client.events(events);
    expect(token.mock.calls).toEqual([[false], [true]]);
    expect(seen.map((s) => s.authorization)).toEqual(["Bearer token-1", "Bearer token-fresh"]);
  });

  it("fails after a second 401 without trying a third time", async () => {
    const { client, seen } = clientOver(status(401), status(401));
    await expect(client.events(events)).rejects.toMatchObject({ status: 401, permanent: true });
    expect(seen).toHaveLength(2);
  });

  it.each([400, 401, 403, 404, 413, 422])("%d is permanent", async (code) => {
    const { client } = clientOver(status(code));
    await expect(client.events(events)).rejects.toMatchObject({ status: code, permanent: true });
  });

  it.each([408, 429, 500, 502, 503])("%d can be retried", async (code) => {
    const { client } = clientOver(status(code));
    const error = await client.events(events).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DispatchError);
    expect(error).toMatchObject({ status: code, permanent: false });
  });

  it("names the endpoint and Dispatch's reason in the error", async () => {
    const { client } = clientOver(
      Response.json({ error: "hazards must be an array" }, { status: 422 }),
    );
    const error = await client.verdict({}).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'POST /agent/verdict → 422: {"error":"hazards must be an array"}',
    );
  });

  it("reads the agent's status in Dispatch from a 410", async () => {
    const gone = Response.json({ error: "no longer wanted", agent: "hazards" }, { status: 410 });
    const error = await clientOver(gone).client.brief().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 410, permanent: true, agent: "hazards" });
    expect((error as Error).message).toBe(
      'GET /agent/brief → 410: {"error":"no longer wanted","agent":"hazards"}',
    );
  });

  it("reads the agent's status from a 410 longer than the error message keeps", async () => {
    const gone = Response.json(
      { error: "no longer wanted", detail: "x".repeat(300), agent: "clear" },
      { status: 410 },
    );
    const error = await clientOver(gone).client.verdict({}).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 410, agent: "clear" });
  });

  it.each([
    ["a 410 without one", Response.json({ error: "no longer wanted" }, { status: 410 })],
    ["a 410 that is not JSON", status(410, "gone")],
    ["a 410 whose JSON is not an object", status(410, "null")],
    ["another refusal", Response.json({ error: "forbidden", agent: "clear" }, { status: 403 })],
  ])("leaves the agent's status unknown for %s", async (_name, answer) => {
    const error = await clientOver(answer).client.events(events).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DispatchError);
    expect((error as DispatchError).agent).toBeUndefined();
  });

  it("does not retry a network error as permanent", async () => {
    const { client } = clientOver(
      new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1") }),
    );
    const error = await client.events(events).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(DispatchError);
    expect(error).not.toHaveProperty("permanent");
    expect((error as Error).message).toBe(
      "POST /agent/events failed: fetch failed: connect ECONNREFUSED 127.0.0.1:1",
    );
  });

  it("keeps the nonce and the token out of every error", async () => {
    const failures = [
      clientOver(status(403, "forbidden")).client.brief(),
      clientOver(status(500)).client.events(events),
      clientOver(new TypeError("fetch failed")).client.failure("x"),
      clientOver(status(401), status(401)).client.verdict({}),
    ];
    const messages = (await Promise.allSettled(failures)).map((r) =>
      r.status === "rejected" ? String(r.reason) : "",
    );
    expect(messages.every((m) => m.includes("/agent/"))).toBe(true);
    for (const message of messages) {
      expect(message).not.toContain(NONCE);
      expect(message).not.toContain("token-");
    }
  });
});

describe("githubOidcToken", () => {
  const env = {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.test/idtoken?api-version=2.0",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-secret",
  };

  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  function issuer() {
    let issued = 0;
    const calls: { url: string; authorization: string | null }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return Response.json({ value: `jwt-${++issued}` });
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  }

  it("requests a token for the audience with the request token as bearer", async () => {
    const { calls, fetch } = issuer();
    expect(await githubOidcToken(env, "https://dispatch.test/", fetch)()).toBe("jwt-1");
    expect(calls).toEqual([
      {
        url: "https://actions.test/idtoken?api-version=2.0&audience=https%3A%2F%2Fdispatch.test%2F",
        authorization: "bearer request-secret",
      },
    ]);
  });

  it("serves the cached token for 240 s, then asks again", async () => {
    const { calls, fetch } = issuer();
    const token = githubOidcToken(env, "aud", fetch);
    expect(await token()).toBe("jwt-1");
    await vi.advanceTimersByTimeAsync(239_999);
    expect(await token()).toBe("jwt-1");
    await vi.advanceTimersByTimeAsync(1);
    expect(await token()).toBe("jwt-2");
    expect(calls).toHaveLength(2);
  });

  it("asks again when told the cached token was refused", async () => {
    const { fetch } = issuer();
    const token = githubOidcToken(env, "aud", fetch);
    expect(await token()).toBe("jwt-1");
    expect(await token(true)).toBe("jwt-2");
    expect(await token()).toBe("jwt-2");
  });

  it("shares one request between concurrent callers", async () => {
    const { calls, fetch } = issuer();
    const token = githubOidcToken(env, "aud", fetch);
    expect(await Promise.all([token(), token(), token()])).toEqual(["jwt-1", "jwt-1", "jwt-1"]);
    expect(calls).toHaveLength(1);
  });

  it("does not cache a failure", async () => {
    let first = true;
    const fetch = vi.fn(async () =>
      first
        ? ((first = false), new Response(null, { status: 500 }))
        : Response.json({ value: "jwt" }),
    ) as unknown as typeof globalThis.fetch;
    const token = githubOidcToken(env, "aud", fetch);
    await expect(token()).rejects.toThrow("OIDC token request failed: 500");
    expect(await token()).toBe("jwt");
  });

  it("explains a missing request URL without printing the request token", async () => {
    const token = githubOidcToken(
      { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-secret" },
      "aud",
      issuer().fetch,
    );
    const error = await token().catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/ACTIONS_ID_TOKEN_REQUEST_URL/);
    expect((error as Error).message).not.toContain("request-secret");
    expect(error).toMatchObject({ permanent: true });
  });

  it("says why the token request could not be made", async () => {
    const fetch = vi.fn(async () =>
      Promise.reject(
        new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND actions.test") }),
      ),
    ) as unknown as typeof globalThis.fetch;
    await expect(githubOidcToken(env, "aud", fetch)()).rejects.toThrow(
      "OIDC token request failed: fetch failed: getaddrinfo ENOTFOUND actions.test",
    );
  });

  it("rejects a response without a token", async () => {
    const fetch = vi.fn(async () => Response.json({})) as unknown as typeof globalThis.fetch;
    await expect(githubOidcToken(env, "aud", fetch)()).rejects.toThrow(
      "OIDC token response has no value",
    );
  });
});
