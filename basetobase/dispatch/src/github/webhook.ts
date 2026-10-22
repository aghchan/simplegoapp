export interface PullRequestRef {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  branch: string;
  headSha: string;
  baseSha: string;
  // The branch the PR merges into.
  baseRef: string;
  // As the event saw it. The routes act on the PR's live state instead.
  draft: boolean;
  defaultBranch: string;
  author: string;
  installationId: number;
}

// "closed" and "retitle" carry no PR state: a late delivery may describe a PR since reopened or
// renamed again, so the route reads GitHub. `retarget`: the PR's base changed, so a run on its
// head reviewed another diff.
export type Trigger =
  | { kind: "start"; pr: PullRequestRef; retarget: boolean }
  | { kind: "closed"; repo: string; prNumber: number; installationId: number }
  | { kind: "retitle"; repo: string; prNumber: number; installationId: number }
  | { kind: "ignore"; reason: string };

interface Identity {
  owner: string;
  repo: string;
}

type Fields = Record<string, unknown>;

const SIGNATURE_HEADER = /^sha256=([0-9a-fA-F]{64})$/;
// synchronize is a push to the PR: it starts a sweep on the new head.
const STARTING_ACTIONS = ["opened", "reopened", "ready_for_review", "synchronize"];

export async function verifyWebhookSignature(
  secret: string,
  body: ArrayBuffer,
  header: string | null,
): Promise<boolean> {
  const digest = header === null ? undefined : SIGNATURE_HEADER.exec(header)?.[1];
  // An empty or unset secret would let anyone compute a matching MAC.
  if (digest === undefined || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  // verify() compares in constant time; a string comparison of digests would not.
  return crypto.subtle.verify("HMAC", key, hexToBytes(digest), body);
}

export function toTrigger(event: string | null, payload: unknown, id: Identity): Trigger {
  if (event !== "pull_request") return ignore("event");
  try {
    return pullRequestTrigger(fields(payload), id);
  } catch (error) {
    if (error instanceof MalformedPayload) return ignore("payload");
    throw error;
  }
}

function pullRequestTrigger(payload: Fields, id: Identity): Trigger {
  const action = text(payload.action);
  const pull = fields(payload.pull_request);
  if (action === "closed") {
    const repo = text(fields(payload.repository).full_name);
    const prNumber = positiveInteger(pull.number);
    const installationId = positiveInteger(fields(payload.installation).id);
    if (repo !== id.repo) return ignore("repo");
    // Only the owner's PRs have runs, so a stranger's close costs no GitHub call. No fork filter:
    // deleting the head repository closes the PR too.
    if (text(fields(pull.user).login) !== id.owner) return ignore("author");
    return { kind: "closed", repo, prNumber, installationId };
  }
  const changes = fields(payload.changes);
  const retarget = action === "edited" && changes.base !== undefined;
  const retitle = action === "edited" && !retarget && changes.title !== undefined;
  if (!STARTING_ACTIONS.includes(action) && !retarget && !retitle) return ignore("action");

  const pr = pullRequestRef(payload);
  if (pr.repo !== id.repo) return ignore("repo");
  // A missing or deleted head repository cannot be shown to be ours, so it counts as a fork.
  if (fields(fields(pull.head).repo).full_name !== pr.repo) return ignore("fork");
  if (pr.author !== id.owner) return ignore("author");
  const { repo, number: prNumber, installationId } = pr;
  if (retitle) return { kind: "retitle", repo, prNumber, installationId };
  return { kind: "start", pr, retarget };
}

function pullRequestRef(payload: Fields): PullRequestRef {
  const repository = fields(payload.repository);
  const pull = fields(payload.pull_request);
  const head = fields(pull.head);
  const base = fields(pull.base);
  return {
    repo: text(repository.full_name),
    number: positiveInteger(pull.number),
    title: text(pull.title),
    // GitHub sends null for a PR without a description.
    body: pull.body === null ? "" : text(pull.body),
    url: text(pull.html_url),
    branch: text(head.ref),
    headSha: text(head.sha),
    baseSha: text(base.sha),
    baseRef: text(base.ref),
    draft: flag(pull.draft),
    defaultBranch: text(repository.default_branch),
    author: text(fields(pull.user).login),
    installationId: positiveInteger(fields(payload.installation).id),
  };
}

function ignore(reason: string): Trigger {
  return { kind: "ignore", reason };
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

// Payload reads that miss or mistype throw this; toTrigger turns it into an ignore.
class MalformedPayload extends Error {}

function fields(value: unknown): Fields {
  return typeof value === "object" && value !== null ? (value as Fields) : {};
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new MalformedPayload();
  return value;
}

function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new MalformedPayload();
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new MalformedPayload();
  }
  return value;
}
