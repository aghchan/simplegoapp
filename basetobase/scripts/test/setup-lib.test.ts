import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accountsOf,
  appIdFrom,
  appManifest,
  branchProtection,
  d1Id,
  DEPLOY_PROBES,
  deployTokenUrl,
  KV_BINDING,
  kvId,
  looksLikeClaudeToken,
  looksLikeCloudflareToken,
  manifestPage,
  productionEnvironment,
  publicUrlOf,
  tokenFrom,
  withDatabaseId,
  withKvId,
  withPublicUrl,
  workerSecrets,
  workersDevUrl,
  type AppConversion,
  tokenIsActive,
} from "../src/setup-lib.ts";

// wrangler.jsonc as committed before setup: the real file holds the owner's ids once setup has run.
const WRANGLER = `{
  "name": "basetobase",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "basetobase",
      // Replace with the id printed by \`wrangler d1 create basetobase\`.
      "database_id": "local-placeholder",
      "migrations_dir": "dispatch/migrations"
    }
  ],
  "kv_namespaces": [
    {
      "binding": "${KV_BINDING}",
      // Replace with the id printed by \`npx wrangler kv namespace create basetobase-transcripts\`.
      "id": "local-placeholder"
    }
  ],
  "vars": {
    "OWNER_LOGIN": "aghchan",
    // Replace with the deployed origin, https://basetobase.<subdomain>.workers.dev.
    "PUBLIC_URL": "http://localhost:8787"
  }
}
`;
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
      checks: "write",
      contents: "read",
      pull_requests: "read",
      metadata: "read",
    });
    expect(m.default_events).toEqual(["pull_request"]);
    expect(m.public).toBe(false);
  });
});

describe("branchProtection", () => {
  it("requires the Base to Base check from the App on main, for admins too", () =>
    expect(JSON.stringify(branchProtection(123))).toBe(
      '{"required_status_checks":{"strict":false,' +
        '"checks":[{"context":"Base to Base","app_id":123}]},' +
        '"enforce_admins":true,"required_pull_request_reviews":null,"restrictions":null}',
    ));
});

describe("appIdFrom", () => {
  it.each([
    ["123", 123],
    [" 4567 \n", 4567],
  ])("reads %j as %i", (input, id) => expect(appIdFrom(input)).toBe(id));

  it.each(["", "abc", "12a", "-5", "1.5", "1e3", "0", "9".repeat(20)])(
    "refuses %j",
    (input) => expect(appIdFrom(input)).toBeUndefined(),
  );
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

describe("Claude token input", () => {
  const token = `sk-ant-oat01-${"a1B2_c3-".repeat(12)}`;

  it("joins a token pasted across wrapped lines", () => {
    expect(tokenFrom(`${token.slice(0, 30)}\r\n${token.slice(30)}\r`)).toBe(token);
    expect(looksLikeClaudeToken(tokenFrom(`  ${token}\n`))).toBe(true);
  });

  it("refuses what is not a whole token", () => {
    expect(looksLikeClaudeToken(token.slice(0, 20))).toBe(false);
    expect(looksLikeClaudeToken("ghp_notaclaudetoken0000000000000000000000000000")).toBe(false);
    expect(looksLikeClaudeToken("")).toBe(false);
  });
});

describe("deploy token", () => {
  it("opens Cloudflare's token form with only what the deploy job needs", () => {
    const url = new URL(deployTokenUrl());
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "")).toEqual([
      { key: "workers_scripts", type: "edit" },
      { key: "d1", type: "edit" },
      { key: "account_settings", type: "read" },
    ]);
    expect(url.searchParams.get("accountId")).toBe("*");
    expect(url.searchParams.get("zoneId")).toBe("all");
    expect(url.searchParams.get("name")).toBe("Base to Base deploy");
    // Encoded as Cloudflare's own template links are: no `+` for a space.
    expect(deployTokenUrl()).toContain("name=Base%20to%20Base%20deploy");
  });

  it("takes a pasted token and refuses a cut-off or wrapped one", () => {
    expect(looksLikeCloudflareToken("Zq3_0aVx-9kLmNoPqRsTuVwXyZ0123456789abcd")).toBe(true);
    expect(looksLikeCloudflareToken("Zq3_0aVx-9kLmNoPq")).toBe(false);
    expect(looksLikeCloudflareToken("Zq3_0aVx-9kLmNoPqRsTu VwXyZ0123456789abcd")).toBe(false);
    expect(looksLikeCloudflareToken("")).toBe(false);
  });

  it("reads Cloudflare's answers", () => {
    expect(tokenIsActive({ success: true, result: { id: "t", status: "active" } })).toBe(true);
    expect(tokenIsActive({ success: true, result: { id: "t", status: "disabled" } })).toBe(false);
    expect(tokenIsActive({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }] })).toBe(false);
    expect(tokenIsActive(undefined)).toBe(false);
    expect(
      accountsOf({ success: true, result: [{ id: "a1", name: "Owner's account", type: "standard" }] }),
    ).toEqual([{ id: "a1", name: "Owner's account" }]);
    expect(accountsOf({ success: true, result: [{ name: "no id" }] })).toEqual([]);
    expect(accountsOf({ success: false, errors: [] })).toEqual([]);
  });

  it("probes the account with what each permission reads", () => {
    expect(DEPLOY_PROBES.map((probe) => [probe.path("a1"), probe.permission])).toEqual([
      ["/accounts/a1/workers/scripts", "Workers Scripts · Edit"],
      ["/accounts/a1/d1/database", "D1 · Edit"],
    ]);
  });
});

describe("productionEnvironment", () => {
  it("lets only protected branches deploy, so a pull request's workflow never reads its secrets", () => {
    expect(productionEnvironment()).toEqual({
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
    });
  });
});
