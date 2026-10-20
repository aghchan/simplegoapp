import { importPKCS8, SignJWT } from "jose";
import type { ChangedFile } from "../../../shared/src/triage.ts";

export interface GitHubClient {
  listPullFiles(repo: string, prNumber: number): Promise<ChangedFile[]>;
  dispatchWorkflow(
    repo: string,
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<void>;
}

const DEFAULT_API_BASE = "https://api.github.com";
const FILES_PER_PAGE = 100;
const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Error messages carry the status and endpoint path only: tokens, keys and response bodies never
// reach them, because these messages end up in logs and on the dashboard.
export function createGitHubClient(opts: {
  appId: string;
  privateKeyPem: string;
  installationId: number;
  fetch: typeof fetch;
  apiBase?: string;
}): GitHubClient {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  // Called unbound: Workers' global fetch throws "Illegal invocation" as an object's method.
  const send = opts.fetch;
  let cachedToken: { value: string; refreshAt: number } | undefined;

  async function call(
    method: string,
    path: string,
    bearer: string,
    init: { query?: string; json?: unknown } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "basetobase",
      Authorization: `Bearer ${bearer}`,
    };
    if (init.json !== undefined) headers["Content-Type"] = "application/json";
    const query = init.query === undefined ? "" : `?${init.query}`;
    const response = await send(`${apiBase}${path}${query}`, {
      method,
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub ${method} ${path} failed with status ${response.status}`);
    }
    return response;
  }

  async function appJwt(): Promise<string> {
    const key = await importPKCS8(opts.privateKeyPem, "RS256");
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT()
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(opts.appId)
      .setIssuedAt(now - JWT_BACKDATE_SECONDS)
      .setExpirationTime(now + JWT_LIFETIME_SECONDS)
      .sign(key);
  }

  async function installationToken(): Promise<string> {
    if (cachedToken !== undefined && Date.now() < cachedToken.refreshAt) return cachedToken.value;
    const path = `/app/installations/${opts.installationId}/access_tokens`;
    const response = await call("POST", path, await appJwt());
    const body = asRecord(await response.json().catch(() => undefined));
    const { token, expires_at: expiresAt } = body;
    const refreshAt =
      typeof expiresAt === "string" ? Date.parse(expiresAt) - TOKEN_REFRESH_MARGIN_MS : NaN;
    if (typeof token !== "string" || Number.isNaN(refreshAt)) {
      throw unexpectedResponse("POST", path);
    }
    cachedToken = { value: token, refreshAt };
    return token;
  }

  return {
    async listPullFiles(repo, prNumber) {
      const token = await installationToken();
      const path = `/repos/${repo}/pulls/${prNumber}/files`;
      const files: ChangedFile[] = [];
      for (let page = 1; ; page++) {
        const query = `per_page=${FILES_PER_PAGE}&page=${page}`;
        const response = await call("GET", path, token, { query });
        const entries = await response.json().catch(() => undefined);
        if (!Array.isArray(entries)) throw unexpectedResponse("GET", path);
        for (const entry of entries) {
          const file = toChangedFile(entry);
          if (file === undefined) throw unexpectedResponse("GET", path);
          files.push(file);
        }
        if (entries.length < FILES_PER_PAGE) return files;
      }
    },

    async dispatchWorkflow(repo, workflow, ref, inputs) {
      const path = `/repos/${repo}/actions/workflows/${workflow}/dispatches`;
      await call("POST", path, await installationToken(), { json: { ref, inputs } });
    },
  };
}

function unexpectedResponse(method: string, path: string): Error {
  return new Error(`GitHub ${method} ${path} returned an unexpected response`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function toChangedFile(entry: unknown): ChangedFile | undefined {
  const { filename, additions, deletions } = asRecord(entry);
  if (
    typeof filename !== "string" ||
    typeof additions !== "number" ||
    typeof deletions !== "number"
  ) {
    return undefined;
  }
  return { path: filename, additions, deletions };
}
