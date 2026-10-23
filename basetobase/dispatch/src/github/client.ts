import { importPKCS8, SignJWT } from "jose";
import type { ChangedFile } from "../../../shared/src/triage.ts";

// A check run as Dispatch writes it. Creating one also needs the commit: CheckRunCreate.
export interface CheckRunBody {
  name: string;
  details_url?: string;
  status: "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "cancelled" | "skipped";
  output: { title: string; summary: string };
}

export type CheckRunCreate = CheckRunBody & { head_sha: string };

// A PR as GitHub has it now. Deliveries come late and out of order, so the routes act on this,
// not on the event. The merge commit is read only once merged: for an open PR GitHub's
// merge_commit_sha is a test merge.
export type PullState = {
  state: "open" | "closed";
  draft: boolean;
  headSha: string;
  baseRef: string;
  // The repository's, so a PR's base can be judged without the event that named it.
  defaultBranch: string;
  title: string;
} & ({ merged: false } | { merged: true; mergeSha: string });

// An open PR as GET /pulls lists it: enough to filter it and to start a run on it.
export interface OpenPull {
  number: number;
  title: string;
  body: string;
  url: string;
  branch: string;
  headSha: string;
  // Unset once the head repository is gone.
  headRepo?: string;
  baseSha: string;
  baseRef: string;
  defaultBranch: string;
  author: string;
  draft: boolean;
}

// The App's credentials and where to reach GitHub. A client also needs the installation.
export interface GitHubApp {
  appId: string;
  privateKeyPem: string;
  fetch: typeof fetch;
  apiBase?: string;
}

export interface GitHubClient {
  listPullFiles(repo: string, prNumber: number): Promise<ChangedFile[]>;
  pullState(repo: string, prNumber: number): Promise<PullState>;
  // The first page only: the cron's bound is lower.
  listOpenPulls(repo: string): Promise<OpenPull[]>;
  // Whether this App has a check run of that name on the commit.
  hasCheckRun(repo: string, sha: string, name: string): Promise<boolean>;
  dispatchWorkflow(
    repo: string,
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<void>;
  // The new check run's id.
  createCheckRun(repo: string, body: CheckRunCreate): Promise<number>;
  updateCheckRun(repo: string, id: number, body: CheckRunBody): Promise<void>;
  cancelWorkflowRun(repo: string, runId: string): Promise<void>;
}

const DEFAULT_API_BASE = "https://api.github.com";
const FILES_PER_PAGE = 100;
const PULLS_PER_PAGE = 100;
const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const PKCS1_HEADER = /BEGIN RSA PRIVATE KEY/;
const PKCS1_MESSAGE =
  'GITHUB_APP_PRIVATE_KEY is PKCS#1 ("BEGIN RSA PRIVATE KEY"); ' +
  "convert it with: openssl pkcs8 -topk8 -nocrypt -in app.pem -out app.pkcs8.pem";

// Error messages carry the status and endpoint path only: tokens, keys and response bodies never
// reach them, because these messages end up in logs and on the dashboard.
export function createGitHubClient(opts: GitHubApp & { installationId: number }): GitHubClient {
  const { call, appJwt } = appCalls(opts);
  let cachedToken: { value: string; refreshAt: number } | undefined;

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

    async pullState(repo, prNumber) {
      const path = `/repos/${repo}/pulls/${prNumber}`;
      const response = await call("GET", path, await installationToken());
      const pull = toPullState(await response.json().catch(() => undefined));
      if (pull === undefined) throw unexpectedResponse("GET", path);
      return pull;
    },

    async listOpenPulls(repo) {
      const path = `/repos/${repo}/pulls`;
      const query = `state=open&per_page=${PULLS_PER_PAGE}`;
      const response = await call("GET", path, await installationToken(), { query });
      const entries = await response.json().catch(() => undefined);
      if (!Array.isArray(entries)) throw unexpectedResponse("GET", path);
      const pulls: OpenPull[] = [];
      for (const entry of entries) {
        const pull = toOpenPull(entry);
        if (pull === undefined) throw unexpectedResponse("GET", path);
        pulls.push(pull);
      }
      return pulls;
    },

    async hasCheckRun(repo, sha, name) {
      const path = `/repos/${repo}/commits/${sha}/check-runs`;
      // This App's only: another App's check of the same name does not vouch for the commit.
      const query = new URLSearchParams({ check_name: name, app_id: opts.appId }).toString();
      const response = await call("GET", path, await installationToken(), { query });
      const { total_count: count } = asRecord(await response.json().catch(() => undefined));
      if (typeof count !== "number") throw unexpectedResponse("GET", path);
      return count > 0;
    },

    async dispatchWorkflow(repo, workflow, ref, inputs) {
      const path = `/repos/${repo}/actions/workflows/${workflow}/dispatches`;
      await call("POST", path, await installationToken(), { json: { ref, inputs } });
    },

    async createCheckRun(repo, body) {
      const path = `/repos/${repo}/check-runs`;
      const response = await call("POST", path, await installationToken(), { json: body });
      const { id } = asRecord(await response.json().catch(() => undefined));
      if (typeof id !== "number" || !Number.isSafeInteger(id)) {
        throw unexpectedResponse("POST", path);
      }
      return id;
    },

    async updateCheckRun(repo, id, body) {
      const path = `/repos/${repo}/check-runs/${id}`;
      const response = await call("PATCH", path, await installationToken(), { json: body });
      await response.body?.cancel();
    },

    async cancelWorkflowRun(repo, runId) {
      const path = `/repos/${repo}/actions/runs/${runId}/cancel`;
      // 409: the run has already finished, which is all a cancel asks for.
      const token = await installationToken();
      const response = await call("POST", path, token, { tolerate: 409 });
      await response.body?.cancel();
    },
  };
}

// The App's installation on the repository, for the cron, which has no event to name it. Read
// with the App's own JWT: there is no installation token without it.
export async function repoInstallationId(app: GitHubApp, repo: string): Promise<number> {
  const { call, appJwt } = appCalls(app);
  const path = `/repos/${repo}/installation`;
  const response = await call("GET", path, await appJwt());
  const { id } = asRecord(await response.json().catch(() => undefined));
  if (typeof id !== "number" || !Number.isSafeInteger(id)) throw unexpectedResponse("GET", path);
  return id;
}

// The requests every call makes, as the App.
function appCalls(opts: GitHubApp) {
  // GitHub issues App keys as PKCS#1, which importPKCS8 rejects without saying how to convert.
  if (PKCS1_HEADER.test(opts.privateKeyPem)) throw new Error(PKCS1_MESSAGE);
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  // Called unbound: Workers' global fetch throws "Illegal invocation" as an object's method.
  const send = opts.fetch;

  async function call(
    method: string,
    path: string,
    bearer: string,
    // `tolerate`: a refusal the caller takes as done.
    init: { query?: string; json?: unknown; tolerate?: number } = {},
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
    if (!response.ok && response.status !== init.tolerate) {
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

  return { call, appJwt };
}

function unexpectedResponse(method: string, path: string): Error {
  return new Error(`GitHub ${method} ${path} returned an unexpected response`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function toChangedFile(entry: unknown): ChangedFile | undefined {
  const { filename, previous_filename: previousFilename, additions, deletions } = asRecord(entry);
  if (
    typeof filename !== "string" ||
    typeof additions !== "number" ||
    typeof deletions !== "number"
  ) {
    return undefined;
  }
  const file: ChangedFile = { path: filename, additions, deletions };
  // For a rename, filename is the new path and previous_filename the old one.
  if (typeof previousFilename === "string" && previousFilename !== "") {
    file.previousPath = previousFilename;
  }
  return file;
}

function toPullState(value: unknown): PullState | undefined {
  const { state, draft, merged, merge_commit_sha: mergeSha, title, head, base } = asRecord(value);
  const { sha: headSha } = asRecord(head);
  const { ref: baseRef, repo } = asRecord(base);
  const { default_branch: defaultBranch } = asRecord(repo);
  if (
    (state !== "open" && state !== "closed") ||
    typeof draft !== "boolean" ||
    typeof title !== "string" ||
    !isName(headSha) ||
    !isName(baseRef) ||
    !isName(defaultBranch)
  ) {
    return undefined;
  }
  const pull: Omit<PullState, "merged"> = { state, draft, headSha, baseRef, defaultBranch, title };
  if (merged === false) return { ...pull, merged };
  if (merged === true && isName(mergeSha)) return { ...pull, merged, mergeSha };
  return undefined;
}

function toOpenPull(entry: unknown): OpenPull | undefined {
  const { number, title, body, html_url: url, draft, user, head, base } = asRecord(entry);
  const { ref: branch, sha: headSha, repo: headRepo } = asRecord(head);
  const { ref: baseRef, sha: baseSha, repo: baseRepo } = asRecord(base);
  const { default_branch: defaultBranch } = asRecord(baseRepo);
  const { login: author } = asRecord(user);
  // GitHub sends null for a PR without a description.
  const description = body === null ? "" : body;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    typeof title !== "string" ||
    typeof description !== "string" ||
    typeof url !== "string" ||
    typeof draft !== "boolean" ||
    !isName(branch) ||
    !isName(headSha) ||
    !isName(baseRef) ||
    !isName(baseSha) ||
    !isName(defaultBranch) ||
    !isName(author)
  ) {
    return undefined;
  }
  const pull: OpenPull = {
    number,
    title,
    body: description,
    url,
    branch,
    headSha,
    baseSha,
    baseRef,
    defaultBranch,
    author,
    draft,
  };
  // A deleted head repository comes back as null.
  const { full_name: headRepoName } = asRecord(headRepo);
  if (isName(headRepoName)) pull.headRepo = headRepoName;
  return pull;
}

// A sha, ref or login: a string GitHub never leaves empty.
function isName(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}
