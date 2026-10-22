import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { GITHUB_OIDC_ISSUER } from "../dispatch/src/auth/oidc.ts";
import { INSTALLATION_ID, OIDC_KEYS_PATH } from "./stack.ts";

export interface FakeGitHub {
  url: string;
  close(): Promise<void>;
}

// A check-run call Dispatch made: the create's body, or an update's id and body.
export interface CheckCall {
  method: "POST" | "PATCH";
  id: number;
  body: Record<string, unknown>;
}

// An agent job Dispatch asked for, as Actions would start it: the workflow's inputs, the Actions
// run's id, and the OIDC token the job would be issued for Dispatch.
export interface Job {
  id: number;
  inputs: Record<string, string>;
  token: string;
}

type Call = { body: unknown; query: URLSearchParams };
type Answer = { status: number; body?: unknown };
type Route = [RegExp, (match: RegExpMatchArray, call: Call) => Answer | Promise<Answer>];

const REPO_PATH = String.raw`\/repos\/([^/]+\/[^/]+)`;
const OIDC_LIFETIME_SECONDS = 3600;

// GitHub as Dispatch calls it, for any installation and repository. A pull request is whatever a
// test last posted to /__pulls/{n}, so the tests say what GitHub has now. Every PR changes one
// backend file outside unpatrolledGlobs. Test hooks start with /__.
export async function startFakeGitHub(o: { audience: string }): Promise<FakeGitHub> {
  const pulls = new Map<number, Record<string, unknown>>();
  const checks: CheckCall[] = [];
  const jobs: Job[] = [];
  const cancels: string[] = [];
  let nextCheckId = 1;
  let nextJobId = 9001;
  const oidc = await oidcIssuer(o.audience);

  const routes: Route[] = [
    [
      /^POST \/app\/installations\/\d+\/access_tokens$/,
      () => ({
        status: 201,
        body: {
          token: "e2e-installation-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      }),
    ],
    [route("GET", "/installation"), () => ({ status: 200, body: { id: INSTALLATION_ID } })],
    // The open PRs, which is all the cron asks for.
    [
      route("GET", "/pulls"),
      (_, { query }) => ({
        status: 200,
        body: [...pulls.values()].filter((pull) => pull.state === query.get("state")),
      }),
    ],
    [
      route("GET", String.raw`/pulls/\d+/files`),
      () => ({
        status: 200,
        body: [{ filename: "orders/cancel.go", additions: 120, deletions: 10 }],
      }),
    ],
    [
      route("GET", String.raw`/pulls/(\d+)`),
      (m) => {
        const pull = pulls.get(Number(m[2]));
        return pull ? { status: 200, body: pull } : notFound();
      },
    ],
    [
      route("POST", String.raw`/actions/workflows/([^/]+)/dispatches`),
      async (m, { body }) => {
        const { ref, inputs } = body as { ref: string; inputs: Record<string, string> };
        const id = nextJobId++;
        const token = await oidc.token({ repo: m[1]!, workflow: m[2]!, ref, runId: id });
        jobs.push({ id, inputs, token });
        return { status: 204 };
      },
    ],
    [
      route("POST", String.raw`/actions/runs/(\d+)/cancel`),
      (m) => {
        cancels.push(m[2]!);
        return { status: 202, body: {} };
      },
    ],
    [
      route("POST", "/check-runs"),
      (_, { body }) => {
        const call: CheckCall = { method: "POST", id: nextCheckId++, body: asRecord(body) };
        checks.push(call);
        return { status: 201, body: { id: call.id } };
      },
    ],
    [
      route("PATCH", String.raw`/check-runs/(\d+)`),
      (m, { body }) => {
        const call: CheckCall = { method: "PATCH", id: Number(m[2]), body: asRecord(body) };
        checks.push(call);
        return { status: 200, body: { id: call.id } };
      },
    ],
    // The checks Dispatch created on the commit: every check here is this App's.
    [
      route("GET", "/commits/([^/]+)/check-runs"),
      (m, { query }) => {
        const name = query.get("check_name");
        const created = checks.filter(
          (c) =>
            c.method === "POST" &&
            c.body.head_sha === m[2] &&
            (name === null || c.body.name === name),
        );
        const runs = created.map((c) => ({ id: c.id, name: c.body.name, head_sha: m[2] }));
        return { status: 200, body: { total_count: runs.length, check_runs: runs } };
      },
    ],
    // Test hooks.
    [
      /^POST \/__pulls\/(\d+)$/,
      (m, { body }) => {
        pulls.set(Number(m[1]), asRecord(body));
        return { status: 204 };
      },
    ],
    [/^GET \/__checks$/, () => ({ status: 200, body: checks })],
    [/^GET \/__jobs$/, () => ({ status: 200, body: jobs })],
    [/^GET \/__cancels$/, () => ({ status: 200, body: cancels })],
    [new RegExp(`^GET ${OIDC_KEYS_PATH}$`), () => ({ status: 200, body: oidc.keys })],
  ];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://github.test");
    const key = `${req.method} ${url.pathname}`;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const found = routes
        .map(([pattern, answer]) => [key.match(pattern), answer] as const)
        .find(([match]) => match !== null);
      let answer: Answer;
      try {
        const text = Buffer.concat(chunks).toString();
        const body: unknown = text === "" ? undefined : JSON.parse(text);
        answer = found ? await found[1](found[0]!, { body, query: url.searchParams }) : notFound();
      } catch (error) {
        // Dispatch sees a GitHub failure, and the log says why.
        console.error(`fake GitHub: ${key}: ${String(error)}`);
        answer = { status: 500, body: { message: "Server Error" } };
      }
      const { status, body: reply } = answer;
      if (reply === undefined) {
        res.writeHead(status);
        res.end();
        return;
      }
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// The repository is the match's first group.
function route(method: string, path: string): RegExp {
  return new RegExp(`^${method} ${REPO_PATH}${path}$`);
}

function notFound(): Answer {
  return { status: 404, body: { message: "Not Found" } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

// GitHub Actions' OIDC provider: a token for a workflow_dispatch run of the workflow, with the
// claims Dispatch checks, and the key set that verifies it.
async function oidcIssuer(audience: string) {
  const kid = "e2e-oidc";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const keys = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" }] };
  return {
    keys,
    token: (job: { repo: string; workflow: string; ref: string; runId: number }) =>
      new SignJWT({
        repository: job.repo,
        workflow_ref: `${job.repo}/.github/workflows/${job.workflow}@refs/heads/${job.ref}`,
        event_name: "workflow_dispatch",
        run_id: String(job.runId),
      })
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(GITHUB_OIDC_ISSUER)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(`${OIDC_LIFETIME_SECONDS}s`)
        .sign(privateKey),
  };
}
