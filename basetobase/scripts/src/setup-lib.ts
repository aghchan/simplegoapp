import { createPrivateKey, randomBytes } from "node:crypto";

export const REPO = "aghchan/simplegoapp";
export const APP_NAME = "Base to Base (aghchan)";
export const D1_NAME = "basetobase";
export const KV_TITLE = "basetobase-transcripts";
export const KV_BINDING = "TRANSCRIPTS";
// The check run Dispatch posts on every PR head (CHECK_NAME in dispatch/src/run/machine.ts).
export const CHECK_NAME = "Base to Base";

// What GitHub's manifest conversion returns (POST /app-manifests/{code}/conversions), as used here.
export interface AppConversion {
  id: number;
  html_url: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string | null;
  pem: string;
}

export function appManifest(publicUrl: string, redirectUrl: string) {
  return {
    name: APP_NAME,
    url: publicUrl,
    hook_attributes: { url: `${publicUrl}/github/webhook`, active: true },
    redirect_url: redirectUrl,
    // The App's own user authorization signs the owner in to the dashboard: no separate OAuth App.
    callback_urls: [`${publicUrl}/auth/callback`],
    public: false,
    default_permissions: {
      actions: "write",
      checks: "write",
      contents: "read",
      pull_requests: "read",
      metadata: "read",
    },
    default_events: ["pull_request"],
  };
}

// The body for PUT /repos/{repo}/branches/main/protection: nothing merges into main, admins
// included, until the Base to Base check passes. GitHub needs all four keys, null or not. The
// check is pinned to the App: without app_id, any workflow allowed to write checks could pass it.
export function branchProtection(appId: number) {
  return {
    required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: appId }] },
    enforce_admins: true,
    required_pull_request_reviews: null,
    restrictions: null,
  };
}

// The App ID as the owner typed it, or undefined for anything but a positive whole number.
export function appIdFrom(input: string): number | undefined {
  const typed = input.trim();
  if (!/^\d+$/.test(typed)) return undefined;
  const id = Number(typed);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

// A page that posts the manifest to GitHub, which then shows the owner a prefilled "Create" form.
export function manifestPage(manifest: object, state: string): string {
  const action = `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
  return `<!doctype html><meta charset="utf-8"><title>Base to Base setup</title>
<form id="f" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button>Create the GitHub App</button></form>
<script>document.getElementById("f").submit()</script>`;
}

export function withDatabaseId(config: string, id: string): string {
  return replaceOnce(config, /("database_id":\s*)"[^"]*"/, id, "database_id");
}

export function withKvId(config: string, binding: string, id: string): string {
  const pattern = new RegExp(`("binding":\\s*"${binding}"[^}]*?"id":\\s*)"[^"]*"`, "s");
  return replaceOnce(config, pattern, id, `${binding} KV id`);
}

export function withPublicUrl(config: string, url: string): string {
  return replaceOnce(config, /("PUBLIC_URL":\s*)"[^"]*"/, url, "PUBLIC_URL");
}

export function publicUrlOf(config: string): string | undefined {
  return /"PUBLIC_URL":\s*"([^"]*)"/.exec(config)?.[1];
}

export function workersDevUrl(deployOutput: string): string | undefined {
  return /https:\/\/basetobase\.[a-z0-9-]+\.workers\.dev/.exec(deployOutput)?.[0];
}

export function d1Id(listJson: string, name: string): string | undefined {
  const rows = parseRows(listJson);
  return rows.find((row) => row.name === name)?.uuid;
}

export function kvId(listJson: string, title: string): string | undefined {
  const rows = parseRows(listJson);
  return rows.find((row) => row.title === title)?.id;
}

// Typed or pasted input with any whitespace removed: a token has none, a wrapped paste adds some.
export function tokenFrom(input: string): string {
  return input.replace(/\s+/g, "");
}

// The shape `claude setup-token` prints. A cut-off paste fails here instead of as a 401 on a runner.
export function looksLikeClaudeToken(token: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{40,}$/.test(token);
}

// GitHub hands out PKCS#1 keys; Dispatch imports PKCS#8.
export function toPkcs8(pem: string): string {
  return createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
}

export function workerSecrets(
  app: AppConversion,
  sessionSecret: string = randomBytes(32).toString("hex"),
): [string, string][] {
  if (!app.webhook_secret) throw new Error("GitHub returned no webhook secret");
  return [
    ["GITHUB_APP_ID", String(app.id)],
    ["GITHUB_APP_PRIVATE_KEY", toPkcs8(app.pem)],
    ["GITHUB_WEBHOOK_SECRET", app.webhook_secret],
    ["GITHUB_OAUTH_CLIENT_ID", app.client_id],
    ["GITHUB_OAUTH_CLIENT_SECRET", app.client_secret],
    ["SESSION_SECRET", sessionSecret],
  ];
}

function replaceOnce(text: string, pattern: RegExp, value: string, what: string): string {
  if (!pattern.test(text)) throw new Error(`wrangler.jsonc has no ${what} to set`);
  return text.replace(pattern, (_, head: string) => `${head}${JSON.stringify(value)}`);
}

function parseRows(listJson: string): Record<string, string>[] {
  // wrangler may print a banner before the JSON.
  const start = listJson.indexOf("[");
  const rows: unknown = JSON.parse(start === -1 ? listJson : listJson.slice(start));
  if (!Array.isArray(rows)) throw new Error("expected a JSON list from wrangler");
  return rows as Record<string, string>[];
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// The deploy job's Cloudflare token (basetobase-ci, environment production): Workers to ship the
// Worker, D1 to migrate, account settings to find the account. Nothing else.
export const DEPLOY_ENVIRONMENT = "production";
export const DEPLOY_TOKEN_NAME = "Base to Base deploy";
export const DEPLOY_TOKEN_PERMISSIONS = [
  { key: "workers_scripts", type: "edit" },
  { key: "d1", type: "edit" },
  { key: "account_settings", type: "read" },
];

// Cloudflare's form for a user token, filled in. Encoded as its own template links are.
export function deployTokenUrl(): string {
  const keys = encodeURIComponent(JSON.stringify(DEPLOY_TOKEN_PERMISSIONS));
  const name = encodeURIComponent(DEPLOY_TOKEN_NAME);
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${keys}&accountId=%2A&zoneId=all&name=${name}`;
}

// What setup reads with the pasted token, to say which permission is missing before a deploy does.
export const DEPLOY_PROBES = [
  {
    what: "Workers",
    permission: "Workers Scripts · Edit",
    path: (account: string) => `/accounts/${account}/workers/scripts`,
  },
  { what: "D1", permission: "D1 · Edit", path: (account: string) => `/accounts/${account}/d1/database` },
];

// One run of URL-safe characters. A cut-off or wrapped paste fails here, not in a deploy job.
export function looksLikeCloudflareToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{30,}$/.test(token);
}

// Cloudflare's API answers { success, result, errors }.
function resultOf(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  const { success, result } = body as { success?: unknown; result?: unknown };
  return success === true ? result : undefined;
}

// GET /user/tokens/verify
export function tokenIsActive(body: unknown): boolean {
  const result = resultOf(body);
  return typeof result === "object" && result !== null && (result as { status?: unknown }).status === "active";
}

// GET /accounts
export function accountsOf(body: unknown): { id: string; name: string }[] {
  const result = resultOf(body);
  if (!Array.isArray(result)) return [];
  return result.flatMap((account: { id?: unknown; name?: unknown }) =>
    typeof account.id === "string" && typeof account.name === "string"
      ? [{ id: account.id, name: account.name }]
      : [],
  );
}

// Only protected branches (main) may deploy, so a workflow on a pull request's branch, an agent's
// included, never reads the environment's secrets.
export function productionEnvironment() {
  return { deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } };
}
