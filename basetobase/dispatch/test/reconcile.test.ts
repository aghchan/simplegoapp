import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Triage } from "../../shared/src/triage.ts";
import type { PullState } from "../src/github/client.ts";
import worker from "../src/index.ts";
import { PRS_PER_TICK, reconcileRepo } from "../src/reconcile/cron.ts";
import { githubClient, reconcilePr } from "../src/reconcile/pr.ts";
import { listRuns, runStub } from "../src/runs/index.ts";
import { prRef, stubGitHub } from "./helpers.ts";

const REPO = "aghchan/simplegoapp";
const OLD_HEAD = "0ld4ead5b4a39281706f5e4d3c2b1a0987654321";
const MERGE_SHA = "4d3c2b1a0987654329f8e7d6c5b4a39281706f5e";
const PULLS_PATH = `GET /repos/${REPO}/pulls`;
const INSTALLATION_PATH = `GET /repos/${REPO}/installation`;
const pullPath = (n: number) => `GET /repos/${REPO}/pulls/${n}`;
const checksOn = (sha: string) => `GET /repos/${REPO}/commits/${sha}/check-runs`;
const docsOnly = () =>
  Response.json([{ filename: "docs/BEST_PRACTICES.md", additions: 1, deletions: 1 }]);

const triage: Triage = {
  panels: ["backend"],
  rating: "black",
  runName: "Red Dog Face",
  files: 3,
  additions: 120,
  deletions: 10,
};

let dispatches: Record<string, string>[];
let errors: ReturnType<typeof vi.spyOn>;
let logs: ReturnType<typeof vi.spyOn>;

// PR 58 as GitHub has it: open, ready, into main, on head58, unless a test says otherwise.
function openPull(over: Partial<Omit<PullState, "merged">> = {}): PullState {
  return {
    state: "open",
    draft: false,
    merged: false,
    headSha: "head58",
    baseRef: "main",
    defaultBranch: "main",
    title: "orders: add cancel endpoint",
    ...over,
  };
}

const closedPull = (): PullState => ({ ...openPull(), state: "closed" });
const mergedPull = (): PullState => ({
  ...openPull(),
  state: "closed",
  merged: true,
  mergeSha: MERGE_SHA,
});

// GET /pulls/{n} as GitHub answers it.
const pullReply = (pull: PullState) => () =>
  Response.json({
    state: pull.state,
    draft: pull.draft,
    merged: pull.merged,
    merge_commit_sha: pull.merged ? pull.mergeSha : null,
    title: pull.title,
    head: { sha: pull.headSha },
    base: { ref: pull.baseRef, repo: { default_branch: pull.defaultBranch } },
  });

// Starts a run of PR `prNumber` on `headSha` and backdates its index row to `createdAt`, which
// orders the PR's runs for a reconcile. With `swept`, the run has no patroller, so it is swept at
// once.
async function run(
  id: string,
  headSha: string,
  createdAt: number,
  opts: { swept?: boolean; title?: string; prNumber?: number } = {},
): Promise<void> {
  const pr = {
    ...prRef(),
    headSha,
    number: opts.prNumber ?? 58,
    title: opts.title ?? prRef().title,
  };
  await runStub(env, id).start(pr, id, opts.swept ? { ...triage, panels: [] } : triage);
  await env.DB.prepare("UPDATE runs SET created_at = ? WHERE id = ?").bind(createdAt, id).run();
}

const statuses = async () =>
  Object.fromEntries((await listRuns(env.DB)).map((row) => [row.id, row.status]));
const logOf = async (runId: string) =>
  (await runStub(env, runId).view())!.log.map((line) => line.text);
const reconcile = (live: PullState) => reconcilePr(env, githubClient(env, 7), REPO, 58, live);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM runs").run();
  dispatches = stubGitHub();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  logs = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reconcilePr", () => {
  describe("an open PR", () => {
    it("keeps the newest open run on its head and supersedes the rest", async () => {
      await run("old-head", OLD_HEAD, 1);
      await run("older", "head58", 2);
      await run("newest", "head58", 3);
      await run("swept-old-head", OLD_HEAD, 4, { swept: true });
      const done = await reconcile(openPull());
      expect({ ...done, stopped: done.stopped.sort() }).toEqual({
        landed: [],
        stopped: ["old-head", "older", "swept-old-head"],
        retitled: [],
      });
      expect(await statuses()).toEqual({
        "old-head": "stopped",
        older: "stopped",
        newest: "on_the_hill",
        "swept-old-head": "stopped",
      });
      expect(await logOf("old-head")).toContain("stopped · superseded by head58");
    });

    // Every reconcile, whichever saw the runs first, keeps the same one.
    it("breaks a tie in start time by run id", async () => {
      await run("a", "head58", 5);
      await run("b", "head58", 5);
      expect((await reconcile(openPull())).stopped).toEqual(["a"]);
    });

    it("keeps a swept run on its head", async () => {
      await run("swept", "head58", 1, { swept: true });
      expect(await reconcile(openPull())).toEqual({ landed: [], stopped: [], retitled: [] });
      expect(await statuses()).toEqual({ swept: "swept" });
    });

    it("keeps none for a draft", async () => {
      await run("hill", "head58", 1);
      expect((await reconcile(openPull({ draft: true }))).stopped).toEqual(["hill"]);
      expect(await logOf("hill")).toContain("stopped · PR marked draft");
    });

    it("keeps none for a PR into another branch", async () => {
      await run("hill", "head58", 1);
      expect((await reconcile(openPull({ baseRef: "feat-a" }))).stopped).toEqual(["hill"]);
      expect(await logOf("hill")).toContain("stopped · PR retargeted to feat-a");
    });

    it("retitles the open runs whose title GitHub has changed", async () => {
      await run("kept-old-title", "head58", 2);
      await run("new-title", OLD_HEAD, 1, { swept: true, title: "orders: cancel" });
      const done = await reconcile(openPull({ title: "orders: cancel" }));
      expect(done.retitled).toEqual(["kept-old-title"]);
      const titles = (await listRuns(env.DB)).map((row) => row.prTitle);
      expect(titles).toEqual(["orders: cancel", "orders: cancel"]);
    });

    it("leaves finished runs and other PRs' runs alone", async () => {
      await run("stopped", OLD_HEAD, 1);
      await runStub(env, "stopped").stop("by hand");
      await run("other-pr", OLD_HEAD, 1, { prNumber: 59 });
      expect(await reconcile(openPull())).toEqual({ landed: [], stopped: [], retitled: [] });
      expect(await statuses()).toEqual({ stopped: "stopped", "other-pr": "on_the_hill" });
    });
  });

  // GitHub reads the newest check run of a name, and a run stopped on the head may have posted
  // its cancelled check after the kept run's.
  describe("a run stopped on the kept run's head", () => {
    let checkCalls: { method: string; body: Record<string, unknown> }[];
    const record = (method: string) => async (req: Request) => {
      checkCalls.push({ method, body: await req.json() });
      return Response.json({ id: 1 }, { status: method === "POST" ? 201 : 200 });
    };

    beforeEach(() => {
      checkCalls = [];
      dispatches = stubGitHub({
        [`POST /repos/${REPO}/check-runs`]: record("POST"),
        [`PATCH /repos/${REPO}/check-runs/1`]: record("PATCH"),
      });
    });

    it("has the kept run post its check afresh, after the stop", async () => {
      await run("older", "head58", 2);
      await run("newest", "head58", 3);
      checkCalls = [];
      await reconcile(openPull());
      expect(checkCalls).toMatchObject([
        { method: "PATCH", body: { conclusion: "cancelled" } },
        { method: "POST", body: { details_url: `${env.PUBLIC_URL}/runs/newest` } },
        { method: "PATCH", body: { conclusion: "skipped" } },
      ]);
    });

    it("is not asked for when the runs it stops are on other heads", async () => {
      await run("old-head", OLD_HEAD, 1);
      await run("hill", "head58", 2);
      checkCalls = [];
      await reconcile(openPull());
      expect(checkCalls.map((call) => call.method)).toEqual(["PATCH"]);
    });
  });

  it("closed stops every open run, swept ones too", async () => {
    await run("hill", "head58", 2);
    await run("swept", OLD_HEAD, 1, { swept: true });
    const done = await reconcile(closedPull());
    expect(done.stopped.sort()).toEqual(["hill", "swept"]);
    expect(await statuses()).toEqual({ hill: "stopped", swept: "stopped" });
    expect(await logOf("swept")).toContain("stopped · PR closed");
  });

  describe("a merged PR", () => {
    // A run stopped on the merged head still reviewed what merged.
    it("lands the newest run on the merged head whatever its status", async () => {
      await run("swept-on-head", "head58", 1, { swept: true });
      await run("stopped-on-head", "head58", 2);
      await runStub(env, "stopped-on-head").stop("by hand");
      await run("old-head", OLD_HEAD, 3);
      const done = await reconcile(mergedPull());
      expect({ ...done, stopped: done.stopped.sort() }).toEqual({
        landed: ["stopped-on-head"],
        stopped: ["old-head", "swept-on-head"],
        retitled: [],
      });
      expect(await statuses()).toEqual({
        "swept-on-head": "stopped",
        "stopped-on-head": "landed",
        "old-head": "stopped",
      });
      expect(await logOf("stopped-on-head")).toContain("landed · merged as 4d3c2b1");
      expect(await logOf("old-head")).toContain("stopped · PR merged");
    });

    it("lands a run once", async () => {
      await run("hill", "head58", 1);
      expect((await reconcile(mergedPull())).landed).toEqual(["hill"]);
      expect(await reconcile(mergedPull())).toEqual({ landed: [], stopped: [], retitled: [] });
    });

    // Its retarget's delivery was lost: the merge never reached the default branch.
    it("into another branch lands nothing and stops the open runs", async () => {
      await run("hill", "head58", 2);
      await run("stopped-on-head", "head58", 1);
      await runStub(env, "stopped-on-head").stop("by hand");
      expect(await reconcile({ ...mergedPull(), baseRef: "feat-a" })).toEqual({
        landed: [],
        stopped: ["hill"],
        retitled: [],
      });
      expect(await statuses()).toEqual({ hill: "stopped", "stopped-on-head": "stopped" });
      expect(await logOf("hill")).toContain("stopped · PR merged into feat-a");
    });

    it("stops the open runs when no run was on the merged head", async () => {
      await run("old-head", OLD_HEAD, 1);
      expect(await reconcile(mergedPull())).toEqual({
        landed: [],
        stopped: ["old-head"],
        retitled: [],
      });
    });
  });

  it("reads the PR from GitHub when not handed it", async () => {
    await run("hill", "head58", 1);
    stubGitHub({ [pullPath(58)]: pullReply(closedPull()) });
    const done = await reconcilePr(env, githubClient(env, 7), REPO, 58);
    expect(done.stopped).toEqual(["hill"]);
  });
});

describe("the reconcile cron", () => {
  // One entry of GET /pulls: the owner's PR from this repository into main, unless `over` says.
  const listed = (n: number, headSha: string, over: Record<string, unknown> = {}) => ({
    number: n,
    title: `PR ${n}`,
    body: null,
    html_url: `https://github.com/${REPO}/pull/${n}`,
    draft: false,
    user: { login: "aghchan" },
    head: { ref: `branch-${n}`, sha: headSha, repo: { full_name: REPO } },
    base: { ref: "main", sha: "base58", repo: { full_name: REPO, default_branch: "main" } },
    ...over,
  });
  let checkLookups: string[];

  // GitHub for a tick: the App installed as 7, the open PRs listed, PR 58 as `pull`, and no
  // check yet on any head in `unchecked`.
  function gitHub(
    opts: { pulls?: unknown[]; pull?: PullState; unchecked?: string[]; checked?: string[] },
    routes: Parameters<typeof stubGitHub>[0] = {},
  ): void {
    const lookup = (total: number) => (req: Request) => {
      checkLookups.push(new URL(req.url).pathname);
      return Response.json({ total_count: total, check_runs: [] });
    };
    dispatches = stubGitHub({
      [INSTALLATION_PATH]: () => Response.json({ id: 7 }),
      [PULLS_PATH]: () => Response.json(opts.pulls ?? []),
      [pullPath(58)]: pullReply(opts.pull ?? openPull()),
      [`${pullPath(58)}/files`]: docsOnly,
      ...Object.fromEntries((opts.unchecked ?? []).map((sha) => [checksOn(sha), lookup(0)])),
      ...Object.fromEntries((opts.checked ?? []).map((sha) => [checksOn(sha), lookup(1)])),
      ...routes,
    });
  }

  beforeEach(() => {
    checkLookups = [];
  });

  it("stops the run of a PR that closed while the webhook was down", async () => {
    await run("hill", "head58", 1);
    gitHub({ pull: closedPull() });
    await reconcileRepo(env);
    expect(await statuses()).toEqual({ hill: "stopped" });
    expect(logs).toHaveBeenCalledWith(`reconcile: ${REPO}#58: stopped hill`);
  });

  it("lands the run of a PR merged while the webhook was down", async () => {
    await run("swept", "head58", 1, { swept: true });
    gitHub({ pull: mergedPull() });
    await reconcileRepo(env);
    expect(await statuses()).toEqual({ swept: "landed" });
    expect(logs).toHaveBeenCalledWith(`reconcile: ${REPO}#58: landed swept`);
  });

  it("starts a run for an owner PR whose head has neither a run nor a check", async () => {
    gitHub({ pulls: [listed(58, "head58")], unchecked: ["head58"] });
    await reconcileRepo(env);
    const [started] = await listRuns(env.DB);
    expect(started).toMatchObject({ prNumber: 58, status: "on_the_hill" });
    expect(dispatches).toMatchObject([{ sha: "head58" }]);
    expect(logs).toHaveBeenCalledWith(`reconcile: ${REPO}#58: started ${started!.id} on head58`);
  });

  // The push's delivery failed: the old head's run is superseded, and the new head gets its run.
  it("recovers a push the webhook lost", async () => {
    await run("old-head", OLD_HEAD, 1);
    gitHub({ pulls: [listed(58, "head58")], unchecked: ["head58"] });
    await reconcileRepo(env);
    const [fresh] = (await listRuns(env.DB)).filter((row) => row.id !== "old-head");
    expect(fresh).toMatchObject({ prNumber: 58, status: "on_the_hill" });
    expect(await statuses()).toMatchObject({ "old-head": "stopped" });
    expect(await logOf("old-head")).toContain("stopped · superseded by head58");
    expect(dispatches.map((inputs) => inputs.sha)).toEqual(["head58"]);
  });

  it("leaves a head that has an open run without asking GitHub", async () => {
    await run("hill", "head58", 1);
    gitHub({ pulls: [listed(58, "head58")] });
    await reconcileRepo(env);
    expect(checkLookups).toEqual([]);
    expect(await statuses()).toEqual({ hill: "on_the_hill" });
    expect(errors).not.toHaveBeenCalled();
  });

  // The ready, reopened or retarget delivery that would have restarted it was lost. The head's
  // check is the stopped run's, so it is not asked for.
  it("restarts a head whose runs have all stopped", async () => {
    await run("stopped", "head58", 1);
    await runStub(env, "stopped").stop("PR marked draft");
    gitHub({ pulls: [listed(58, "head58")], checked: ["head58"] });
    await reconcileRepo(env);
    expect(checkLookups).toEqual([]);
    const [fresh] = (await listRuns(env.DB)).filter((row) => row.id !== "stopped");
    expect(fresh).toMatchObject({ prNumber: 58, status: "on_the_hill" });
    expect(dispatches.map((inputs) => inputs.sha)).toEqual(["head58"]);
    expect(logs).toHaveBeenCalledWith(`reconcile: ${REPO}#58: started ${fresh!.id} on head58`);
  });

  it("restarts a stopped head once", async () => {
    await run("stopped", "head58", 1);
    await runStub(env, "stopped").stop("PR closed");
    gitHub({ pulls: [listed(58, "head58")] });
    await reconcileRepo(env);
    await reconcileRepo(env);
    expect(Object.values(await statuses()).sort()).toEqual(["on_the_hill", "stopped"]);
    expect(dispatches).toHaveLength(1);
  });

  // The trail-names refresh workflow's PR, whose webhook was lost: it gets its neutral check.
  it("gives the start path to the refresh workflow's PR", async () => {
    const names = () =>
      Response.json([
        { filename: "basetobase/config/trail-names.json", additions: 9, deletions: 3 },
      ]);
    const bot = { user: { login: "github-actions[bot]" } };
    gitHub(
      { pulls: [listed(58, "head58", bot)], unchecked: ["head58"] },
      { [`${pullPath(58)}/files`]: names },
    );
    await reconcileRepo(env);
    expect(await listRuns(env.DB)).toEqual([]);
    expect(logs).toHaveBeenCalledWith(`reconcile: ${REPO}#58: ignored head58: unpatrolled`);
  });

  // An unpatrolled PR's neutral check, say.
  it("leaves a head that has this App's check", async () => {
    gitHub({ pulls: [listed(58, "head58")], checked: ["head58"] });
    await reconcileRepo(env);
    expect(checkLookups).toEqual([`/repos/${REPO}/commits/head58/check-runs`]);
    expect(await listRuns(env.DB)).toEqual([]);
    expect(logs).not.toHaveBeenCalled();
  });

  it.each([
    ["a draft", { draft: true }],
    ["a fork", { head: { ref: "x", sha: "head58", repo: { full_name: "eve/simplegoapp" } } }],
    ["a PR whose head repository is gone", { head: { ref: "x", sha: "head58", repo: null } }],
    ["another author's PR", { user: { login: "eve" } }],
    [
      "a PR into another branch",
      { base: { ref: "feat-a", sha: "b", repo: { full_name: REPO, default_branch: "main" } } },
    ],
  ])("passes over %s, as the webhook would", async (_label, over) => {
    gitHub({ pulls: [listed(58, "head58", over)] });
    await reconcileRepo(env);
    expect(checkLookups).toEqual([]);
    expect(await listRuns(env.DB)).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("goes on past a PR it cannot reconcile", async () => {
    await run("unreadable", "head58", 1);
    await run("closed", OLD_HEAD, 1, { prNumber: 59 });
    gitHub(
      {},
      {
        [pullPath(58)]: () => new Response("secret body", { status: 500 }),
        [pullPath(59)]: pullReply(closedPull()),
      },
    );
    await reconcileRepo(env);
    expect(await statuses()).toEqual({ unreadable: "on_the_hill", closed: "stopped" });
    expect(errors).toHaveBeenCalledWith(
      `reconcile: ${REPO}#58: could not read the pull request from GitHub: ` +
        `GitHub GET /repos/${REPO}/pulls/58 failed with status 500`,
    );
  });

  it("goes on past a PR it cannot start", async () => {
    gitHub(
      { pulls: [listed(58, "head58"), listed(59, "head59")], unchecked: ["head58"] },
      { [checksOn("head59")]: () => new Response("", { status: 502 }) },
    );
    await reconcileRepo(env);
    expect(await listRuns(env.DB)).toMatchObject([{ prNumber: 58 }]);
    expect(errors).toHaveBeenCalledOnce();
    expect(String(errors.mock.calls[0]![0])).toContain(`#59: GitHub GET`);
  });

  it(`looks at no more than ${PRS_PER_TICK} PRs a tick`, async () => {
    // One PR with an open run, reconciled first, and plenty of unstarted ones after it.
    await run("hill", "head58", 1);
    const pulls = Array.from({ length: 60 }, (_, i) => listed(100 + i, `head${100 + i}`));
    gitHub({ pulls, checked: pulls.map((pull) => pull.head.sha) });
    await reconcileRepo(env);
    expect(checkLookups).toHaveLength(PRS_PER_TICK - 1);
    expect(checkLookups[0]).toBe(`/repos/${REPO}/commits/head100/check-runs`);
  });

  it("fails the tick when the App's installation cannot be read", async () => {
    gitHub({}, { [INSTALLATION_PATH]: () => new Response("Not Found", { status: 404 }) });
    await expect(reconcileRepo(env)).rejects.toThrow(
      `GitHub GET /repos/${REPO}/installation failed with status 404`,
    );
  });

  it("fails the tick when the open PRs cannot be listed, after the reconciles", async () => {
    await run("hill", "head58", 1);
    gitHub({ pull: closedPull() }, { [PULLS_PATH]: () => new Response("", { status: 500 }) });
    await expect(reconcileRepo(env)).rejects.toThrow("failed with status 500");
    expect(await statuses()).toEqual({ hill: "stopped" });
  });

  it("is the Worker's scheduled handler", async () => {
    gitHub({ pulls: [listed(58, "head58")], unchecked: ["head58"] });
    const controller = createScheduledController({ cron: "*/5 * * * *" });
    await worker.scheduled(controller, env);
    expect(await listRuns(env.DB)).toMatchObject([{ prNumber: 58, status: "on_the_hill" }]);
  });
});
