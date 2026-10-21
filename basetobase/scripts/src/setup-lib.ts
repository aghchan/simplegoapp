import { createPrivateKey, randomBytes } from "node:crypto";

export const REPO = "aghchan/simplegoapp";
export const APP_NAME = "Base to Base (aghchan)";
export const D1_NAME = "basetobase";
export const KV_TITLE = "basetobase-transcripts";
export const KV_BINDING = "TRANSCRIPTS";

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
      contents: "read",
      pull_requests: "read",
      metadata: "read",
    },
    default_events: ["pull_request"],
  };
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
