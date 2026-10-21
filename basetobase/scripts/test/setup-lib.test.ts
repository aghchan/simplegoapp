import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appManifest,
  d1Id,
  KV_BINDING,
  kvId,
  manifestPage,
  publicUrlOf,
  withDatabaseId,
  withKvId,
  withPublicUrl,
  workerSecrets,
  workersDevUrl,
  type AppConversion,
} from "../src/setup-lib.ts";

const WRANGLER = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
const URL_ = "https://basetobase.owner.workers.dev";

function pkcs1(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

function app(over: Partial<AppConversion> = {}): AppConversion {
  return {
    id: 123,
    html_url: "https://github.com/apps/base-to-base-aghchan",
    client_id: "Iv1.abc",
    client_secret: "cs",
    webhook_secret: "whs",
    pem: pkcs1(),
    ...over,
  };
}

describe("appManifest", () => {
  it("points GitHub at Dispatch and asks only for what Dispatch uses", () => {
    const m = appManifest(URL_, "http://127.0.0.1:5000/callback");
    expect(m.hook_attributes).toEqual({ url: `${URL_}/github/webhook`, active: true });
    expect(m.callback_urls).toEqual([`${URL_}/auth/callback`]);
    expect(m.redirect_url).toBe("http://127.0.0.1:5000/callback");
    expect(m.default_permissions).toEqual({
      actions: "write",
      contents: "read",
      pull_requests: "read",
      metadata: "read",
    });
    expect(m.default_events).toEqual(["pull_request"]);
    expect(m.public).toBe(false);
  });
});

describe("manifestPage", () => {
  it("posts the manifest to GitHub with the state, escaped", () => {
    const html = manifestPage({ name: `a"<b>&` }, "s1");
    expect(html).toContain('action="https://github.com/settings/apps/new?state=s1"');
    const value = /name="manifest" value="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(value).not.toMatch(/[<>]/);
    const decoded = value
      .replaceAll("&quot;", '"')
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
    expect(JSON.parse(decoded)).toEqual({ name: `a"<b>&` });
  });
});

describe("wrangler.jsonc edits", () => {
  it("sets the D1 id, the KV id and PUBLIC_URL, keeping comments", () => {
    const patched = withPublicUrl(withKvId(withDatabaseId(WRANGLER, "db-1"), KV_BINDING, "kv-1"), URL_);
    expect(patched).toContain('"database_id": "db-1"');
    expect(patched).toMatch(new RegExp(`"binding": "${KV_BINDING}"[^}]*"id": "kv-1"`, "s"));
    expect(publicUrlOf(patched)).toBe(URL_);
    expect(patched).not.toContain("local-placeholder");
    expect(patched.match(/\/\/ /g)?.length).toBe(WRANGLER.match(/\/\/ /g)?.length);
  });

  it("sets only the database id", () => {
    const patched = withDatabaseId(WRANGLER, "db-1");
    expect(patched.match(/local-placeholder/g)?.length).toBe(1);
  });

  it("fails loudly when a key is missing", () => {
    expect(() => withKvId(WRANGLER, "NOPE", "x")).toThrow("wrangler.jsonc has no NOPE KV id to set");
    expect(() => withPublicUrl("{}", URL_)).toThrow("PUBLIC_URL");
  });
});

describe("wrangler output", () => {
  it("finds the workers.dev URL in deploy output", () => {
    const out = "Uploaded basetobase (3.1 sec)\nDeployed basetobase triggers (0.4 sec)\n  https://basetobase.owner.workers.dev\nCurrent Version ID: x";
    expect(workersDevUrl(out)).toBe(URL_);
    expect(workersDevUrl("no url here")).toBeUndefined();
  });

  it("finds the D1 and KV ids by name, past a banner", () => {
    expect(d1Id('⛅️ wrangler\n[{"uuid":"u1","name":"other"},{"uuid":"u2","name":"basetobase"}]', "basetobase")).toBe("u2");
    expect(kvId('[{"id":"k1","title":"basetobase-transcripts"}]', "basetobase-transcripts")).toBe("k1");
    expect(kvId("[]", "basetobase-transcripts")).toBeUndefined();
  });
});

describe("workerSecrets", () => {
  it("maps the App to the six Worker secrets with a PKCS#8 key", () => {
    const secrets = Object.fromEntries(workerSecrets(app(), "sess"));
    expect(Object.keys(secrets)).toEqual([
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_OAUTH_CLIENT_ID",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "SESSION_SECRET",
    ]);
    expect(secrets.GITHUB_APP_ID).toBe("123");
    expect(secrets.GITHUB_APP_PRIVATE_KEY).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(secrets.SESSION_SECRET).toBe("sess");
  });

  it("makes a 64-hex session secret by default", () => {
    expect(Object.fromEntries(workerSecrets(app())).SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses an App without a webhook secret", () => {
    expect(() => workerSecrets(app({ webhook_secret: null }))).toThrow("no webhook secret");
  });
});
