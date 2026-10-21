import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { vi } from "vitest";
import { toTrigger, type PullRequestRef } from "../src/github/webhook.ts";

const OWNER = "aghchan";
const REPO = "aghchan/simplegoapp";

export function prPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { action = "opened", draft = false, author = OWNER, headRepo = REPO, repo = REPO } = over;
  return {
    action,
    installation: { id: 7 },
    repository: { full_name: repo, default_branch: "main" },
    pull_request: {
      number: 58,
      title: "orders: add cancel endpoint",
      body: "Let a customer cancel their own pending order.",
      html_url: `https://github.com/${String(repo)}/pull/58`,
      draft,
      user: { login: author },
      head: { ref: "claude/orders-cancel", sha: "head58", repo: { full_name: headRepo } },
      base: { ref: "main", sha: "base58", repo: { full_name: repo } },
    },
  };
}

export function prRef(over: Record<string, unknown> = {}): PullRequestRef {
  const trigger = toTrigger("pull_request", prPayload(over), { owner: OWNER, repo: REPO });
  if (trigger.kind !== "start") throw new Error(`prRef: the payload produced ${trigger.kind}`);
  return trigger.pr;
}

// A copy of the environment with some bindings replaced or, given undefined, left unset. The
// caller passes the environment in because this file also loads outside the Workers runtime.
export function envWith(base: Env, over: Partial<Record<keyof Env, unknown>>): Env {
  return { ...base, ...over } as Env;
}

export async function sign(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return `sha256=${Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function rsaKeyPair(): Promise<{ privatePem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const base64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const body = (base64.match(/.{1,64}/g) ?? []).join("\n");
  const privatePem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
  return { privatePem, publicKey: pair.publicKey };
}

// Routes are keyed "METHOD /pathname"; the query string is left for the handler to read.
// A request with no route fails the test loudly instead of answering 404.
export function fakeFetch(
  routes: Record<string, (req: Request) => Response | Promise<Response>>,
): typeof fetch & { calls: Request[] } {
  const calls: Request[] = [];
  const fake: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push(req);
    const key = `${req.method} ${new URL(req.url).pathname}`;
    const route = routes[key];
    if (!route) throw new Error(`fakeFetch: no route for ${key}`);
    return route(req.clone());
  };
  return Object.assign(fake, { calls });
}

// Replaces the global fetch with a GitHub that hands out installation tokens and accepts workflow
// dispatches and check runs (id 1), returning the inputs of each dispatch as they arrive; `routes`
// adds or overrides endpoints. The body is recorded inside the route because a Request made in a
// Durable Object can't be read from the test.
export function stubGitHub(
  routes: Record<string, (req: Request) => Response | Promise<Response>> = {},
): Record<string, string>[] {
  const dispatchInputs: Record<string, string>[] = [];
  const github = fakeFetch({
    "POST /app/installations/7/access_tokens": () =>
      Response.json(
        { token: "installation-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        { status: 201 },
      ),
    [`POST /repos/${REPO}/actions/workflows/basetobase-agent.yml/dispatches`]: async (req) => {
      dispatchInputs.push(((await req.json()) as { inputs: Record<string, string> }).inputs);
      return new Response(null, { status: 204 });
    },
    [`POST /repos/${REPO}/check-runs`]: () => Response.json({ id: 1 }, { status: 201 }),
    [`PATCH /repos/${REPO}/check-runs/1`]: () => Response.json({ id: 1 }),
    ...routes,
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(github);
  return dispatchInputs;
}

const AGENT_KEY_ID = "test-agent-key";

// The claims of a token GitHub would issue to the agent workflow; `over` replaces or, with
// undefined, drops one.
export function agentClaims(audience: string, over: Record<string, unknown> = {}) {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: audience,
    repository: REPO,
    workflow_ref: `${REPO}/.github/workflows/basetobase-agent.yml@refs/heads/main`,
    event_name: "workflow_dispatch",
    run_id: "99",
    ...over,
  };
}

// Each of these makes an otherwise valid agent token unacceptable.
export const REJECTED_CLAIMS: [string, Record<string, unknown>][] = [
  ["issuer", { iss: "https://evil.example" }],
  ["audience", { aud: "https://other.example" }],
  ["repository", { repository: "eve/simplegoapp" }],
  ["repository that merely starts with ours", { repository: `${REPO}-fork` }],
  ["workflow", { workflow_ref: `${REPO}/.github/workflows/ci.yml@refs/heads/main` }],
  [
    "workflow of another repository",
    { workflow_ref: "eve/simplegoapp/.github/workflows/basetobase-agent.yml@refs/heads/main" },
  ],
  [
    "workflow file that merely starts with ours",
    { workflow_ref: `${REPO}/.github/workflows/basetobase-agent.yml.evil@refs/heads/main` },
  ],
  ["missing workflow", { workflow_ref: undefined }],
  ["event", { event_name: "push" }],
  ["missing run id", { run_id: undefined }],
  ["empty run id", { run_id: "" }],
  ["numeric run id", { run_id: 99 }],
  ["expiry", { exp: 1 }],
];

// A signing key plus the key set that verifies it, standing in for GitHub's.
export async function agentIdentity(): Promise<{
  getKey: JWTVerifyGetKey;
  token(claims: Record<string, unknown>): Promise<string>;
}> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: AGENT_KEY_ID, alg: "RS256", use: "sig" };
  return {
    getKey: createLocalJWKSet({ keys: [jwk] }),
    token(claims) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ iat: now, exp: now + 300, ...claims })
        .setProtectedHeader({ alg: "RS256", kid: AGENT_KEY_ID })
        .sign(privateKey);
    },
  };
}
