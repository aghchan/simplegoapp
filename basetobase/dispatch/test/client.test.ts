import { jwtVerify } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createGitHubClient, repoInstallationId } from "../src/github/client.ts";
import { fakeFetch, rsaKeyPair } from "./helpers.ts";

const REPO = "aghchan/simplegoapp";
const WORKFLOW = "basetobase-agent.yml";
const APP_ID = "123";
const INSTALLATION_ID = 7;
const INSTALLATION_TOKEN = "ghs_installation_token";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const TOKEN_PATH = `/app/installations/${INSTALLATION_ID}/access_tokens`;
const FILES_PATH = `/repos/${REPO}/pulls/58/files`;
const DISPATCH_PATH = `/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;
const PKCS1_MESSAGE =
  'GITHUB_APP_PRIVATE_KEY is PKCS#1 ("BEGIN RSA PRIVATE KEY"); ' +
  "convert it with: openssl pkcs8 -topk8 -nocrypt -in app.pem -out app.pkcs8.pem";

type Routes = Parameters<typeof fakeFetch>[0];

let keys: Awaited<ReturnType<typeof rsaKeyPair>>;
beforeAll(async () => {
  keys = await rsaKeyPair();
});

function tokenRoute(expiresInMs = HOUR_MS) {
  return () =>
    Response.json(
      { token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + expiresInMs).toISOString() },
      { status: 201 },
    );
}

const noContent = () => new Response(null, { status: 204 });

const changedFiles = (count: number, offset = 0) =>
  Array.from({ length: count }, (_, index) => ({
    filename: `src/file${offset + index}.ts`,
    status: "modified",
    additions: 3,
    deletions: 1,
  }));

// Serves one page per request, as GitHub does; pages past the end are empty.
const pagedFiles = (pages: unknown[][]) => (req: Request) =>
  Response.json(pages[Number(new URL(req.url).searchParams.get("page")) - 1] ?? []);

function setup(routes: Routes = {}, opts: { apiBase?: string; privateKeyPem?: string } = {}) {
  const f = fakeFetch({ [`POST ${TOKEN_PATH}`]: tokenRoute(), ...routes });
  const client = createGitHubClient({
    appId: APP_ID,
    privateKeyPem: opts.privateKeyPem ?? keys.privatePem,
    installationId: INSTALLATION_ID,
    fetch: f,
    apiBase: opts.apiBase,
  });
  return { f, client };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error)) throw new Error("expected the call to reject with an Error");
  return error;
}

function thrownBy(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected the call to throw an Error");
}

const callsTo = (f: { calls: Request[] }, path: string) =>
  f.calls.filter((req) => new URL(req.url).pathname === path);

describe("pull request files", () => {
  it("listPullFiles follows pagination", async () => {
    const { f, client } = setup({
      [`GET ${FILES_PATH}`]: pagedFiles([changedFiles(100), changedFiles(3, 100)]),
    });
    const files = await client.listPullFiles(REPO, 58);
    expect(files).toHaveLength(103);
    expect(files[0]).toEqual({ path: "src/file0.ts", additions: 3, deletions: 1 });
    expect(files[102]).toEqual({ path: "src/file102.ts", additions: 3, deletions: 1 });
    const queries = callsTo(f, FILES_PATH).map((req) => new URL(req.url).search);
    expect(queries).toEqual(["?per_page=100&page=1", "?per_page=100&page=2"]);
  });

  it("asks for one more page after exactly 100 files", async () => {
    const { f, client } = setup({ [`GET ${FILES_PATH}`]: pagedFiles([changedFiles(100)]) });
    expect(await client.listPullFiles(REPO, 58)).toHaveLength(100);
    expect(callsTo(f, FILES_PATH)).toHaveLength(2);
  });

  it("makes a single request for a short first page", async () => {
    const { f, client } = setup({ [`GET ${FILES_PATH}`]: pagedFiles([changedFiles(2)]) });
    expect(await client.listPullFiles(REPO, 58)).toHaveLength(2);
    expect(callsTo(f, FILES_PATH)).toHaveLength(1);
  });

  it("throws with the status when a later page fails", async () => {
    const { client } = setup({
      [`GET ${FILES_PATH}`]: (req) =>
        new URL(req.url).searchParams.get("page") === "1"
          ? Response.json(changedFiles(100))
          : new Response("", { status: 502 }),
    });
    const error = await rejection(client.listPullFiles(REPO, 58));
    expect(error.message).toBe(`GitHub GET ${FILES_PATH} failed with status 502`);
  });

  it.each([
    ["an object", { files: [] }],
    ["entries without a filename", [{ additions: 1, deletions: 1 }]],
    ["entries with non-numeric counts", [{ filename: "a.ts", additions: "1", deletions: 1 }]],
  ])("throws on a response that is %s", async (_label, body) => {
    const { client } = setup({ [`GET ${FILES_PATH}`]: () => Response.json(body) });
    const error = await rejection(client.listPullFiles(REPO, 58));
    expect(error.message).toBe(`GitHub GET ${FILES_PATH} returned an unexpected response`);
  });

  it("maps a rename's previous_filename to previousPath", async () => {
    const renamed = {
      filename: "pkg/login.go",
      previous_filename: "pkg/auth/login.go",
      status: "renamed",
      additions: 0,
      deletions: 0,
    };
    const kept = { filename: "pkg/kept.go", status: "modified", additions: 2, deletions: 1 };
    const { client } = setup({ [`GET ${FILES_PATH}`]: pagedFiles([[renamed, kept]]) });
    expect(await client.listPullFiles(REPO, 58)).toStrictEqual([
      { path: "pkg/login.go", previousPath: "pkg/auth/login.go", additions: 0, deletions: 0 },
      { path: "pkg/kept.go", additions: 2, deletions: 1 },
    ]);
  });

  it.each([
    ["an empty string", ""],
    ["null", null],
    ["a number", 7],
  ])("ignores a previous_filename that is %s", async (_label, previous) => {
    const entry = { filename: "pkg/a.go", previous_filename: previous, additions: 1, deletions: 0 };
    const { client } = setup({ [`GET ${FILES_PATH}`]: pagedFiles([[entry]]) });
    expect(await client.listPullFiles(REPO, 58)).toStrictEqual([
      { path: "pkg/a.go", additions: 1, deletions: 0 },
    ]);
  });
});

describe("pull request state", () => {
  const PULL_PATH = `/repos/${REPO}/pulls/58`;
  // GET /pulls/{n} as GitHub answers it for an open PR, trimmed to what is read and a little more.
  const pull = (over: Record<string, unknown> = {}) => ({
    number: 58,
    state: "open",
    draft: false,
    merged: false,
    merge_commit_sha: "testmerge58",
    title: "orders: add cancel endpoint",
    head: { ref: "claude/orders-cancel", sha: "head59" },
    base: { ref: "main", sha: "base58", repo: { default_branch: "main" } },
    ...over,
  });
  const reading = (reply: unknown) =>
    setup({ [`GET ${PULL_PATH}`]: () => Response.json(reply) }).client.pullState(REPO, 58);

  // An open PR's merge_commit_sha is GitHub's test merge, never a merge.
  it("pullState reads the PR as GitHub has it now", async () => {
    const { f, client } = setup({ [`GET ${PULL_PATH}`]: () => Response.json(pull()) });
    expect(await client.pullState(REPO, 58)).toStrictEqual({
      state: "open",
      draft: false,
      merged: false,
      headSha: "head59",
      baseRef: "main",
      defaultBranch: "main",
      title: "orders: add cancel endpoint",
    });
    expect(callsTo(f, PULL_PATH)[0]!.headers.get("authorization")).toBe(
      `Bearer ${INSTALLATION_TOKEN}`,
    );
  });

  it("reads a merged PR's merge commit", async () =>
    expect(
      await reading(pull({ state: "closed", merged: true, merge_commit_sha: "merge58" })),
    ).toMatchObject({ state: "closed", merged: true, mergeSha: "merge58" }));

  it("reads a draft into another base", async () => {
    const base = { ref: "feat-a", repo: { default_branch: "main" } };
    expect(await reading(pull({ draft: true, base }))).toMatchObject({
      draft: true,
      baseRef: "feat-a",
      defaultBranch: "main",
    });
  });

  it.each([
    ["no head", pull({ head: undefined })],
    ["an empty head sha", pull({ head: { sha: "" } })],
    ["an unknown state", pull({ state: "merged" })],
    ["no base ref", pull({ base: { repo: { default_branch: "main" } } })],
    ["no default branch", pull({ base: { ref: "main", repo: {} } })],
    ["a non-boolean draft", pull({ draft: "false" })],
    ["no merged flag", pull({ merged: undefined })],
    ["a merge without its commit", pull({ state: "closed", merged: true, merge_commit_sha: null })],
    ["no title", pull({ title: undefined })],
    ["no body at all", "nope"],
  ])("throws on a response with %s", async (_label, reply) => {
    const error = await rejection(reading(reply));
    expect(error.message).toBe(`GitHub GET ${PULL_PATH} returned an unexpected response`);
  });

  it("throws with the status when GitHub refuses", async () => {
    const { client } = setup({ [`GET ${PULL_PATH}`]: () => new Response("nope", { status: 404 }) });
    const error = await rejection(client.pullState(REPO, 58));
    expect(error.message).toBe(`GitHub GET ${PULL_PATH} failed with status 404`);
  });
});

describe("open pull requests", () => {
  const PULLS_PATH = `/repos/${REPO}/pulls`;
  // One entry of GET /pulls, trimmed.
  const listed = (over: Record<string, unknown> = {}) => ({
    number: 58,
    state: "open",
    title: "orders: add cancel endpoint",
    body: "Let a customer cancel their own pending order.",
    html_url: `https://github.com/${REPO}/pull/58`,
    draft: false,
    user: { login: "aghchan" },
    head: { ref: "claude/orders-cancel", sha: "head58", repo: { full_name: REPO } },
    base: { ref: "main", sha: "base58", repo: { full_name: REPO, default_branch: "main" } },
    ...over,
  });
  const listing = (...entries: unknown[]) =>
    setup({ [`GET ${PULLS_PATH}`]: () => Response.json(entries) }).client.listOpenPulls(REPO);

  it("listOpenPulls reads the first 100 open PRs", async () => {
    const { f, client } = setup({ [`GET ${PULLS_PATH}`]: () => Response.json([listed()]) });
    expect(await client.listOpenPulls(REPO)).toStrictEqual([
      {
        number: 58,
        title: "orders: add cancel endpoint",
        body: "Let a customer cancel their own pending order.",
        url: `https://github.com/${REPO}/pull/58`,
        branch: "claude/orders-cancel",
        headSha: "head58",
        headRepo: REPO,
        baseSha: "base58",
        baseRef: "main",
        defaultBranch: "main",
        author: "aghchan",
        draft: false,
      },
    ]);
    const [req] = callsTo(f, PULLS_PATH);
    expect(new URL(req!.url).search).toBe("?state=open&per_page=100");
    expect(req!.headers.get("authorization")).toBe(`Bearer ${INSTALLATION_TOKEN}`);
  });

  it("gives a PR without a description an empty body", async () =>
    expect(await listing(listed({ body: null }))).toMatchObject([{ body: "" }]));

  // It cannot be shown to be ours, so the cron counts it as a fork.
  it("leaves out a head repository that is gone", async () => {
    const [open] = await listing(listed({ head: { ref: "x", sha: "head58", repo: null } }));
    expect(open).not.toHaveProperty("headRepo");
  });

  it("reads an empty list", async () => expect(await listing()).toEqual([]));

  it.each([
    ["an object", { pulls: [] }],
    ["an entry without a number", [listed({ number: undefined })]],
    ["an entry without a head sha", [listed({ head: { ref: "x", repo: null } })]],
    ["an entry without a default branch", [listed({ base: { ref: "main", sha: "b", repo: {} } })]],
    ["an entry without an author", [listed({ user: null })]],
    ["an entry with a non-boolean draft", [listed({ draft: null })]],
  ])("throws on a response that is %s", async (_label, reply) => {
    const { client } = setup({ [`GET ${PULLS_PATH}`]: () => Response.json(reply) });
    const error = await rejection(client.listOpenPulls(REPO));
    expect(error.message).toBe(`GitHub GET ${PULLS_PATH} returned an unexpected response`);
  });
});

describe("check runs on a commit", () => {
  const COMMIT_CHECKS_PATH = `/repos/${REPO}/commits/head58/check-runs`;

  // Another App's check of the same name does not vouch for the head.
  it("hasCheckRun asks for this App's check runs of that name", async () => {
    const { f, client } = setup({
      [`GET ${COMMIT_CHECKS_PATH}`]: () => Response.json({ total_count: 1, check_runs: [{}] }),
    });
    expect(await client.hasCheckRun(REPO, "head58", "Base to Base")).toBe(true);
    const [req] = callsTo(f, COMMIT_CHECKS_PATH);
    const query = new URL(req!.url).searchParams;
    expect(Object.fromEntries(query)).toEqual({ check_name: "Base to Base", app_id: APP_ID });
    expect(req!.headers.get("authorization")).toBe(`Bearer ${INSTALLATION_TOKEN}`);
  });

  it("is false when there are none", async () => {
    const { client } = setup({
      [`GET ${COMMIT_CHECKS_PATH}`]: () => Response.json({ total_count: 0, check_runs: [] }),
    });
    expect(await client.hasCheckRun(REPO, "head58", "Base to Base")).toBe(false);
  });

  it("throws on a response without a count", async () => {
    const { client } = setup({ [`GET ${COMMIT_CHECKS_PATH}`]: () => Response.json({}) });
    const error = await rejection(client.hasCheckRun(REPO, "head58", "Base to Base"));
    expect(error.message).toBe(`GitHub GET ${COMMIT_CHECKS_PATH} returned an unexpected response`);
  });
});

describe("the App's installation", () => {
  const INSTALLATION_PATH = `/repos/${REPO}/installation`;
  const lookUp = (routes: Routes, privateKeyPem = keys.privatePem) => {
    const f = fakeFetch(routes);
    const found = repoInstallationId({ appId: APP_ID, privateKeyPem, fetch: f }, REPO);
    return { f, found };
  };

  // No installation token exists until the installation is known.
  it("repoInstallationId reads it with the App's own JWT", async () => {
    const { f, found } = lookUp({ [`GET ${INSTALLATION_PATH}`]: () => Response.json({ id: 7 }) });
    expect(await found).toBe(INSTALLATION_ID);
    expect(f.calls).toHaveLength(1);
    const bearer = f.calls[0]!.headers.get("authorization")!.replace("Bearer ", "");
    const { payload } = await jwtVerify(bearer, keys.publicKey, { algorithms: ["RS256"] });
    expect(payload.iss).toBe(APP_ID);
  });

  it.each([
    ["no id", {}],
    ["a string id", { id: "7" }],
  ])("throws on a response with %s", async (_label, reply) => {
    const { found } = lookUp({ [`GET ${INSTALLATION_PATH}`]: () => Response.json(reply) });
    expect((await rejection(found)).message).toBe(
      `GitHub GET ${INSTALLATION_PATH} returned an unexpected response`,
    );
  });

  it("throws with the status when the App is not installed", async () => {
    const { found } = lookUp({
      [`GET ${INSTALLATION_PATH}`]: () => new Response("Not Found", { status: 404 }),
    });
    expect((await rejection(found)).message).toBe(
      `GitHub GET ${INSTALLATION_PATH} failed with status 404`,
    );
  });

  it("rejects a PKCS#1 key with the conversion command, before any request", async () => {
    const pkcs1 = "-----BEGIN RSA PRIVATE KEY-----\nQUJD\n-----END RSA PRIVATE KEY-----\n";
    const { f, found } = lookUp({}, pkcs1);
    expect((await rejection(found)).message).toBe(PKCS1_MESSAGE);
    expect(f.calls).toHaveLength(0);
  });
});

describe("workflow dispatch", () => {
  it("dispatchWorkflow posts ref and inputs", async () => {
    const { f, client } = setup({ [`POST ${DISPATCH_PATH}`]: noContent });
    await client.dispatchWorkflow(REPO, WORKFLOW, "main", { run_id: "r" });
    const req = f.calls.find((r) => r.url.endsWith(DISPATCH_PATH))!;
    expect(req.method).toBe("POST");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(await req.json()).toEqual({ ref: "main", inputs: { run_id: "r" } });
  });

  it("dispatchWorkflow throws with status on failure", async () => {
    const { client } = setup({
      [`POST ${DISPATCH_PATH}`]: () => new Response("", { status: 422 }),
    });
    const p = client.dispatchWorkflow(REPO, WORKFLOW, "main", { run_id: "r" });
    await expect(p).rejects.toThrow(/422/);
  });
});

describe("workflow run cancel", () => {
  const CANCEL_PATH = `/repos/${REPO}/actions/runs/99/cancel`;

  it("cancelWorkflowRun posts the run's cancel", async () => {
    const { f, client } = setup({
      [`POST ${CANCEL_PATH}`]: () => Response.json({}, { status: 202 }),
    });
    await client.cancelWorkflowRun(REPO, "99");
    const [req] = callsTo(f, CANCEL_PATH);
    expect(req!.method).toBe("POST");
    expect(req!.headers.get("authorization")).toBe(`Bearer ${INSTALLATION_TOKEN}`);
  });

  // GitHub answers 409 for a run that has already finished, which is all a cancel asks for.
  it("takes a 409 as done", async () => {
    const { client } = setup({
      [`POST ${CANCEL_PATH}`]: () =>
        new Response("Cannot cancel a workflow run that is completed.", { status: 409 }),
    });
    await expect(client.cancelWorkflowRun(REPO, "99")).resolves.toBeUndefined();
  });

  it("carries the status and path of any other refusal, nothing else", async () => {
    const { client } = setup({
      [`POST ${CANCEL_PATH}`]: () => new Response("leaky response body", { status: 403 }),
    });
    const error = await rejection(client.cancelWorkflowRun(REPO, "99"));
    expect(error.message).toBe(`GitHub POST ${CANCEL_PATH} failed with status 403`);
  });
});

describe("check runs", () => {
  const CHECKS_PATH = `/repos/${REPO}/check-runs`;
  const body = {
    name: "Base to Base",
    details_url: "https://b2b.example/runs/r1",
    status: "in_progress" as const,
    output: { title: "Red Dog Face · patrol sweep", summary: "0 of 1 patroller in" },
  };

  it("createCheckRun posts the body and returns the new id", async () => {
    const { f, client } = setup({
      [`POST ${CHECKS_PATH}`]: () => Response.json({ id: 501 }, { status: 201 }),
    });
    expect(await client.createCheckRun(REPO, { ...body, head_sha: "head58" })).toBe(501);
    const [req] = callsTo(f, CHECKS_PATH);
    expect(req!.headers.get("authorization")).toBe(`Bearer ${INSTALLATION_TOKEN}`);
    expect(req!.headers.get("content-type")).toBe("application/json");
    expect(await req!.json()).toEqual({ ...body, head_sha: "head58" });
  });

  it.each([
    ["no id", {}],
    ["a string id", { id: "501" }],
    ["a fractional id", { id: 1.5 }],
  ])("createCheckRun throws on a response with %s", async (_label, reply) => {
    const { client } = setup({
      [`POST ${CHECKS_PATH}`]: () => Response.json(reply, { status: 201 }),
    });
    const error = await rejection(client.createCheckRun(REPO, { ...body, head_sha: "head58" }));
    expect(error.message).toBe(`GitHub POST ${CHECKS_PATH} returned an unexpected response`);
  });

  it("updateCheckRun patches the check run by id", async () => {
    const done = { ...body, status: "completed" as const, conclusion: "success" as const };
    const { f, client } = setup({
      [`PATCH ${CHECKS_PATH}/501`]: () => Response.json({ id: 501, status: "completed" }),
    });
    await client.updateCheckRun(REPO, 501, done);
    const [req] = callsTo(f, `${CHECKS_PATH}/501`);
    expect(req!.method).toBe("PATCH");
    expect(req!.headers.get("authorization")).toBe(`Bearer ${INSTALLATION_TOKEN}`);
    expect(await req!.json()).toEqual(done);
  });

  it.each<[string, (client: ReturnType<typeof setup>["client"]) => Promise<unknown>, string]>([
    ["a create", (client) => client.createCheckRun(REPO, { ...body, head_sha: "h" }), "POST"],
    ["an update", (client) => client.updateCheckRun(REPO, 501, body), "PATCH"],
  ])("carries the status and path of %s GitHub refused, nothing else", async (_l, send, method) => {
    const path = method === "POST" ? CHECKS_PATH : `${CHECKS_PATH}/501`;
    const { client } = setup({
      [`${method} ${path}`]: () => new Response("leaky response body", { status: 403 }),
    });
    const error = await rejection(send(client));
    expect(error.message).toBe(`GitHub ${method} ${path} failed with status 403`);
  });
});

describe("authentication", () => {
  it("reuses the installation token", async () => {
    const { f, client } = setup({
      [`GET ${FILES_PATH}`]: pagedFiles([[]]),
      [`POST ${DISPATCH_PATH}`]: noContent,
    });
    await client.listPullFiles(REPO, 58);
    await client.dispatchWorkflow(REPO, WORKFLOW, "main", {});
    expect(f.calls.filter((r) => r.url.includes("/access_tokens"))).toHaveLength(1);
  });

  it.each([
    { expiresIn: "an hour", ttl: HOUR_MS, tokenRequests: 1 },
    { expiresIn: "six minutes", ttl: 6 * MINUTE_MS, tokenRequests: 1 },
    { expiresIn: "four minutes", ttl: 4 * MINUTE_MS, tokenRequests: 2 },
  ])(
    "makes $tokenRequests token request(s) for two calls when the token expires in $expiresIn",
    async ({ ttl, tokenRequests }) => {
      const { f, client } = setup({
        [`POST ${TOKEN_PATH}`]: tokenRoute(ttl),
        [`GET ${FILES_PATH}`]: pagedFiles([[]]),
      });
      await client.listPullFiles(REPO, 58);
      await client.listPullFiles(REPO, 58);
      expect(callsTo(f, TOKEN_PATH)).toHaveLength(tokenRequests);
    },
  );

  it("signs the app JWT with iss = appId", async () => {
    const { f, client } = setup({ [`GET ${FILES_PATH}`]: pagedFiles([[]]) });
    const before = Math.floor(Date.now() / 1000);
    await client.listPullFiles(REPO, 58);
    const after = Math.floor(Date.now() / 1000);

    const bearer = callsTo(f, TOKEN_PATH)[0]!.headers.get("authorization")!.replace("Bearer ", "");
    const { payload, protectedHeader } = await jwtVerify(bearer, keys.publicKey, {
      algorithms: ["RS256"],
    });
    expect(payload.iss).toBe("123");
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.iat).toBeGreaterThanOrEqual(before - 60);
    expect(payload.iat).toBeLessThanOrEqual(after - 60);
    expect(payload.exp).toBe(payload.iat! + 600);
  });

  it("authenticates API calls with the installation token", async () => {
    const { f, client } = setup({ [`GET ${FILES_PATH}`]: pagedFiles([[]]) });
    await client.listPullFiles(REPO, 58);
    expect(callsTo(f, FILES_PATH)[0]!.headers.get("authorization")).toBe(
      `Bearer ${INSTALLATION_TOKEN}`,
    );
  });

});

describe("requests", () => {
  it("sends the GitHub API headers on every request", async () => {
    const { f, client } = setup({
      [`GET ${FILES_PATH}`]: pagedFiles([[]]),
      [`POST ${DISPATCH_PATH}`]: noContent,
    });
    await client.listPullFiles(REPO, 58);
    await client.dispatchWorkflow(REPO, WORKFLOW, "main", {});
    expect(f.calls).toHaveLength(3);
    for (const req of f.calls) {
      expect(req.headers.get("accept")).toBe("application/vnd.github+json");
      expect(req.headers.get("x-github-api-version")).toBe("2022-11-28");
      expect(req.headers.get("user-agent")).toBe("basetobase");
    }
  });

  it("calls the supplied fetch unbound", async () => {
    const f = fakeFetch({
      [`POST ${TOKEN_PATH}`]: tokenRoute(),
      [`GET ${FILES_PATH}`]: pagedFiles([[]]),
    });
    // Workers' global fetch throws this when it is called as a method of another object.
    const strictFetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return f(...args);
    };
    const client = createGitHubClient({
      appId: APP_ID,
      privateKeyPem: keys.privatePem,
      installationId: INSTALLATION_ID,
      fetch: strictFetch,
    });
    expect(await client.listPullFiles(REPO, 58)).toEqual([]);
  });

  it("targets api.github.com by default", async () => {
    const { f, client } = setup({ [`GET ${FILES_PATH}`]: pagedFiles([[]]) });
    await client.listPullFiles(REPO, 58);
    expect(f.calls.map((req) => req.url.startsWith("https://api.github.com/"))).toEqual([
      true,
      true,
    ]);
  });

  it("targets the configured base, path prefix included", async () => {
    const apiBase = "https://github.example.test/api/v3";
    const { f, client } = setup(
      {
        [`POST /api/v3${TOKEN_PATH}`]: tokenRoute(),
        [`GET /api/v3${FILES_PATH}`]: pagedFiles([[]]),
      },
      { apiBase },
    );
    await client.listPullFiles(REPO, 58);
    expect(f.calls.map((req) => req.url.startsWith(`${apiBase}/`))).toEqual([true, true]);
  });
});

describe("failures", () => {
  it("carries the status and path of a failed dispatch, nothing else", async () => {
    const { client } = setup({
      [`POST ${DISPATCH_PATH}`]: () => new Response("leaky response body", { status: 422 }),
    });
    const error = await rejection(client.dispatchWorkflow(REPO, WORKFLOW, "main", {}));
    expect(error.message).toBe(`GitHub POST ${DISPATCH_PATH} failed with status 422`);
  });

  it("stops at a failed token request without revealing the credentials", async () => {
    const { f, client } = setup({
      [`POST ${TOKEN_PATH}`]: () => new Response("Bad credentials", { status: 401 }),
      [`GET ${FILES_PATH}`]: pagedFiles([[]]),
    });
    const error = await rejection(client.listPullFiles(REPO, 58));
    expect(error.message).toBe(`GitHub POST ${TOKEN_PATH} failed with status 401`);
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    ["without a token", { expires_at: new Date(Date.now() + HOUR_MS).toISOString() }],
    ["without an expiry", { token: INSTALLATION_TOKEN }],
    ["with an unreadable expiry", { token: INSTALLATION_TOKEN, expires_at: "soon" }],
  ])("throws on a token response %s", async (_label, body) => {
    const { client } = setup({ [`POST ${TOKEN_PATH}`]: () => Response.json(body) });
    const error = await rejection(client.listPullFiles(REPO, 58));
    expect(error.message).toBe(`GitHub POST ${TOKEN_PATH} returned an unexpected response`);
  });

  it("does not echo a malformed private key", async () => {
    const privateKeyPem =
      "-----BEGIN PRIVATE KEY-----\nTOPSECRETKEYMATERIAL\n-----END PRIVATE KEY-----";
    const { client } = setup({}, { privateKeyPem });
    const error = await rejection(client.listPullFiles(REPO, 58));
    expect(error.message).not.toContain("TOPSECRETKEYMATERIAL");
  });

  it("rejects a PKCS#1 key with the conversion command, never echoing the key", () => {
    const body = "TOPSECRETKEYMATERIAL";
    const privateKeyPem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      body,
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const error = thrownBy(() => setup({}, { privateKeyPem }));
    expect(error.message).toBe(PKCS1_MESSAGE);
    expect(error.message).not.toContain(body);
  });

  it("reports an unset private key on the first call, before any request", async () => {
    const f = fakeFetch({});
    const client = createGitHubClient({
      appId: APP_ID,
      privateKeyPem: undefined as unknown as string,
      installationId: INSTALLATION_ID,
      fetch: f,
    });
    const error = await rejection(client.listPullFiles(REPO, 58));
    expect(error.message).not.toBe(PKCS1_MESSAGE);
    expect(f.calls).toHaveLength(0);
  });
});
