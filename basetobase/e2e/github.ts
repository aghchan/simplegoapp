import { createHash, createHmac } from "node:crypto";
import { expect } from "@playwright/test";
import type { RoleId } from "../shared/src/config.ts";
import type { AgentBrief } from "../shared/src/types.ts";
import type { CheckCall, Job } from "./fake-github.ts";
import {
  BASE_URL_ENV,
  GITHUB_URL_ENV,
  INSTALLATION_ID,
  OWNER,
  RECONCILE_CRON,
  REPO,
  WEBHOOK_SECRET,
} from "./stack.ts";

// GitHub's side, as the tests play it: what the fake GitHub holds for a PR, the deliveries that
// announce a change to it, and the agent jobs Dispatch dispatched.

const baseURL = process.env[BASE_URL_ENV];
const githubURL = process.env[GITHUB_URL_ENV];

// A pull request as GitHub's API has it: GET /pulls/{n} answers with it and an event carries it.
export interface Pull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  merge_commit_sha: string | null;
  user: { login: string };
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; sha: string; repo: { full_name: string; default_branch: string } };
}

// 40 hex characters, as GitHub's are; the name tells a test's commits apart.
export function sha(name: string): string {
  return createHash("sha1").update(name).digest("hex");
}

// The owner's ready PR from a branch of the repository into main: one Dispatch patrols. Its
// description is `body`, if given: a run's goal, `For: #<n>` lines among it.
export function pullRequest(n: number, title: string, body?: string): Pull {
  return {
    number: n,
    title,
    body: body ?? null,
    html_url: `https://github.com/${REPO}/pull/${n}`,
    state: "open",
    draft: false,
    merged: false,
    merge_commit_sha: null,
    user: { login: OWNER },
    head: { ref: `e2e/${n}`, sha: sha(`head ${n}`), repo: { full_name: REPO } },
    base: { ref: "main", sha: sha("main"), repo: { full_name: REPO, default_branch: "main" } },
  };
}

// GitHub has the PR as given from now on. Dispatch reads it there rather than trust an event.
export async function onGitHub(pull: Pull): Promise<void> {
  const res = await fetch(`${githubURL}/__pulls/${pull.number}`, {
    method: "POST",
    body: JSON.stringify(pull),
  });
  expect(res.status).toBe(204);
}

// The PR opens on GitHub: the run Dispatch started for it.
export async function open(pull: Pull): Promise<string> {
  await onGitHub(pull);
  return started(await deliver("opened", pull));
}

// A push moves the PR's head: the run Dispatch started on the new head.
export async function push(pull: Pull, head: string): Promise<string> {
  pull.head.sha = head;
  await onGitHub(pull);
  return started(await deliver("synchronize", pull));
}

// The PR closes on GitHub, merged as `mergeSha` if given: Dispatch's answer to the delivery.
export async function close(pull: Pull, mergeSha?: string): Promise<Record<string, unknown>> {
  Object.assign(pull, {
    state: "closed",
    merged: mergeSha !== undefined,
    merge_commit_sha: mergeSha ?? null,
  });
  await onGitHub(pull);
  return deliver("closed", pull);
}

// A pull_request event for the PR as it stands, signed as GitHub signs it.
async function deliver(action: string, pull: Pull): Promise<Record<string, unknown>> {
  const body = JSON.stringify({
    action,
    installation: { id: INSTALLATION_ID },
    repository: { full_name: REPO, default_branch: "main" },
    pull_request: pull,
  });
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  const res = await fetch(`${baseURL}/github/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "pull_request",
      "X-Hub-Signature-256": `sha256=${signature}`,
    },
    body,
  });
  return (await res.json()) as Record<string, unknown>;
}

function started(answer: Record<string, unknown>): string {
  expect(answer).toEqual({ runId: expect.any(String) });
  return answer.runId as string;
}

// The cron's tick, as its trigger runs it, once the tick has finished. Miniflare's own route:
// `--test-scheduled`'s /__scheduled never reaches the Worker, as wrangler.jsonc's run_worker_first
// sends every other path to the dashboard.
export async function reconcileTick(): Promise<void> {
  const cron = encodeURIComponent(RECONCILE_CRON);
  const res = await fetch(`${baseURL}/cdn-cgi/local/scheduled?cron=${cron}`);
  // "exception" when the handler threw.
  expect(await res.text()).toBe("ok");
}

// The Base to Base check run Dispatch posted on this commit: its create and updates, oldest first.
export async function checksOn(headSha: string): Promise<CheckCall[]> {
  const calls = await hook<CheckCall[]>("checks");
  const created = calls.find((c) => c.method === "POST" && c.body.head_sha === headSha);
  return created ? calls.filter((c) => c.id === created.id) : [];
}

// The newest Base to Base check run on this commit, as its last create or update left it: GitHub
// reads only the newest of a name.
export async function newestCheckOn(headSha: string): Promise<CheckCall["body"] | undefined> {
  const calls = await hook<CheckCall[]>("checks");
  const created = calls.findLast((c) => c.method === "POST" && c.body.head_sha === headSha);
  return created && calls.findLast((c) => c.id === created.id)?.body;
}

// The run's agent jobs, as the fake's Actions queued them.
export async function jobsOf(runId: string): Promise<Job[]> {
  return (await hook<Job[]>("jobs")).filter((job) => job.inputs.run_id === runId);
}

// The run's sweep job for this patroller, the newest if it ran again: a run starts one job for each
// patroller enabled, so a test says whose it means.
export async function jobOf(runId: string, role: RoleId): Promise<Job> {
  const job = (await jobsOf(runId)).findLast((j) => j.inputs.agent_id === `${role}-sweep-0`);
  expect(job, `a job of ${role} for run ${runId}`).toBeDefined();
  return job!;
}

// The Actions runs Dispatch cancelled.
export async function cancelled(): Promise<string[]> {
  return hook<string[]>("cancels");
}

// What the forwarder does first: the job has started on GitHub.
export async function brief(job: Job): Promise<AgentBrief> {
  const { run_id, agent_id, nonce } = job.inputs;
  const query = new URLSearchParams({ run_id: run_id!, agent_id: agent_id!, nonce: nonce! });
  const res = await fetch(`${baseURL}/agent/brief?${query}`, {
    headers: { Authorization: `Bearer ${job.token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as AgentBrief;
}

// The job's patrol, from its brief to its verdict: these hazards, or clear without any.
export async function patrol(job: Job, hazards: string[] = []): Promise<void> {
  const { role, prefix, headSha } = await brief(job);
  const verdict = {
    role,
    headSha,
    status: hazards.length > 0 ? "hazards" : "clear",
    hazards: hazards.map((title, i) => ({ id: `${prefix}-${i + 1}`, title, detail: title })),
    summary: hazards.length > 0 ? "Hazards to answer." : "Behaves as asked.",
  };
  const { run_id, agent_id, nonce } = job.inputs;
  const res = await fetch(`${baseURL}/agent/verdict`, {
    method: "POST",
    headers: { Authorization: `Bearer ${job.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ run_id, agent_id, nonce, verdict }),
  });
  expect(res.status).toBe(204);
}

// The job's last step, for a job that died before its agent reported.
export async function failJob(job: Job, reason: string): Promise<void> {
  const { run_id, agent_id, nonce } = job.inputs;
  const res = await fetch(`${baseURL}/agent/failure`, {
    method: "POST",
    headers: { Authorization: `Bearer ${job.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ run_id, agent_id, nonce, reason }),
  });
  expect(res.status).toBe(204);
}

async function hook<T>(name: string): Promise<T> {
  return (await (await fetch(`${githubURL}/__${name}`)).json()) as T;
}
