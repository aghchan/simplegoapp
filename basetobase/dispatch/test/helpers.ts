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
