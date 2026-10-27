import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Rating } from "../../shared/src/config.ts";
import type {
  ReviewOutcome,
  RunSnapshot,
  RunStatus,
  StepSnapshot,
} from "../../shared/src/types.ts";
import {
  findOpenRuns,
  findPrRuns,
  listOwedDesigns,
  listRuns,
  openRunPrs,
  runNamesFor,
  runsOnHead,
  summaryOf,
  upsertRun,
} from "../src/runs/index.ts";

function snapshot(over: Partial<RunSnapshot> & { id: string }): RunSnapshot {
  return {
    repo: "aghchan/simplegoapp",
    prNumber: 58,
    prTitle: "orders: add cancel endpoint",
    prUrl: "https://github.com/aghchan/simplegoapp/pull/58",
    branch: "claude/orders-cancel",
    headSha: "head58",
    panels: ["backend"],
    rating: "black",
    runName: "Red Dog Face",
    goal: "Cancel orders.",
    status: "on_the_hill",
    outcome: "pending",
    steps: steps("sweep", "active"),
    agents: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

function steps(current: StepSnapshot["id"], status: StepSnapshot["status"]): StepSnapshot[] {
  return [
    { id: "lift_line", status: "done", notes: [] },
    { id: "trail_map", status: "done", notes: [] },
    { id: "sweep", status: current === "sweep" ? status : "done", notes: [] },
    { id: "huddle", status: "pending", notes: [] },
  ];
}

async function indexRun(
  id: string,
  status: RunStatus,
  updatedAt: number,
  over: Partial<RunSnapshot> = {},
): Promise<void> {
  await upsertRun(env.DB, snapshot({ id, status, updatedAt, ...over }));
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM runs").run();
});

describe("run index", () => {
  it("lists a run as a summary", async () => {
    await indexRun("a", "on_the_hill", 5);
    expect(await listRuns(env.DB)).toEqual([
      {
        id: "a",
        prNumber: 58,
        prTitle: "orders: add cancel endpoint",
        runName: "Red Dog Face",
        rating: "black",
        status: "on_the_hill",
        outcome: "pending",
        currentStep: "sweep",
        createdAt: 1000,
        updatedAt: 5,
      },
    ]);
  });

  it.each<[string, Partial<RunSnapshot>]>([
    ["on the hill", {}],
    ["stopped", { status: "stopped", steps: steps("sweep", "stopped") }],
    ["swept", { status: "swept", steps: steps("sweep", "done") }],
  ])("summarizes a run %s as the list reads it back", async (_name, over) => {
    const run = snapshot({ id: "a", ...over });
    await upsertRun(env.DB, run);
    expect(await listRuns(env.DB)).toEqual([summaryOf(run)]);
  });

  it.each<ReviewOutcome>(["clear", "hazards", "failed", "none"])(
    "reads back a %s outcome as it was written",
    async (outcome) => {
      const run = snapshot({ id: "a", status: "swept", steps: steps("sweep", "done"), outcome });
      await upsertRun(env.DB, run);
      expect(await listRuns(env.DB)).toEqual([summaryOf(run)]);
      expect(summaryOf(run).outcome).toBe(outcome);
    },
  );

  it("reads a row indexed before outcomes were recorded as pending, never as a pass", async () => {
    await env.DB.prepare(
      `INSERT INTO runs (id, repo, pr_number, pr_title, head_sha, run_name, rating, status,
         current_step, created_at, updated_at)
       VALUES ('old', 'aghchan/simplegoapp', 58, 't', 'h', 'Red Dog Face', 'black', 'swept',
         'sweep', 1, 1)`,
    ).run();
    expect(await listRuns(env.DB)).toMatchObject([{ id: "old", outcome: "pending" }]);
  });

  it("updates a run in place", async () => {
    await indexRun("a", "on_the_hill", 5);
    await indexRun("a", "swept", 9, { steps: steps("sweep", "done"), outcome: "hazards" });
    expect(await listRuns(env.DB)).toMatchObject([
      { id: "a", status: "swept", outcome: "hazards", updatedAt: 9 },
    ]);
  });

  it("reports the active step, else the last one reached", async () => {
    await indexRun("active", "on_the_hill", 5);
    await indexRun("stopped", "stopped", 4, { steps: steps("sweep", "stopped") });
    await indexRun("swept", "swept", 3, { steps: steps("sweep", "done") });
    const byId = Object.fromEntries(
      (await listRuns(env.DB)).map((run) => [run.id, run.currentStep]),
    );
    expect(byId).toEqual({ active: "sweep", stopped: "sweep", swept: "sweep" });
  });

  it("lists runs on the hill first, then newest", async () => {
    await indexRun("old-swept", "swept", 10);
    await indexRun("new-swept", "swept", 30);
    await indexRun("old-hill", "on_the_hill", 5);
    await indexRun("new-hill", "on_the_hill", 20);
    expect((await listRuns(env.DB)).map((run) => run.id)).toEqual([
      "new-hill",
      "old-hill",
      "new-swept",
      "old-swept",
    ]);
  });

  it("limits the list, defaulting to 50", async () => {
    for (let i = 0; i < 52; i++) await indexRun(`r${i}`, "swept", i);
    expect(await listRuns(env.DB)).toHaveLength(50);
    expect(await listRuns(env.DB, 3)).toHaveLength(3);
  });

  it("names the rating's runs on the hill, and its newest run whatever its status", async () => {
    await indexRun("a", "on_the_hill", 1, { rating: "black", runName: "Red Dog Face", createdAt: 10 });
    await indexRun("b", "landed", 1, { rating: "black", runName: "Headwall Face", createdAt: 30 });
    await indexRun("c", "stopped", 1, { rating: "black", runName: "Chute 75", createdAt: 20 });
    await indexRun("d", "on_the_hill", 1, { rating: "green", runName: "Easy Slider", createdAt: 40 });
    const rating: Rating = "black";
    expect(await runNamesFor(env.DB, rating)).toEqual({ active: ["Red Dog Face"], last: "Headwall Face" });
  });

  it("has no last name for a rating that has had no run", async () => {
    await indexRun("a", "on_the_hill", 1, { rating: "green", runName: "Easy Slider" });
    expect(await runNamesFor(env.DB, "double_black")).toEqual({ active: [] });
  });

  describe("a pull request's runs", () => {
    const REPO = "aghchan/simplegoapp";
    const byId = (runs: { id: string }[]) => runs.map((run) => run.id).sort();

    beforeEach(async () => {
      await indexRun("hill", "on_the_hill", 1, { headSha: "sha-a", createdAt: 10 });
      await indexRun("swept", "swept", 1, { headSha: "sha-b", prTitle: "old title" });
      await indexRun("landed", "landed", 1, { headSha: "sha-c" });
      await indexRun("stopped", "stopped", 1, { headSha: "sha-d" });
      await indexRun("failed", "failed", 1, { headSha: "sha-e" });
      await indexRun("other-pr", "on_the_hill", 1, { prNumber: 59 });
      await indexRun("other-repo", "on_the_hill", 1, { repo: "eve/simplegoapp" });
    });

    // Open: the runs that still speak for their PR.
    it("findOpenRuns finds those on the hill or swept, with what a reconcile reads", async () => {
      const open = await findOpenRuns(env.DB, REPO, 58);
      expect(byId(open)).toEqual(["hill", "swept"]);
      expect(open.find((run) => run.id === "hill")).toEqual({
        id: "hill",
        headSha: "sha-a",
        status: "on_the_hill",
        prTitle: "orders: add cancel endpoint",
        createdAt: 10,
      });
      expect(open.find((run) => run.id === "swept")).toMatchObject({ prTitle: "old title" });
    });

    it("findPrRuns finds them whatever their status", async () =>
      expect(byId(await findPrRuns(env.DB, REPO, 58))).toEqual([
        "failed",
        "hill",
        "landed",
        "stopped",
        "swept",
      ]));

    it("openRunPrs names each PR with an open run once", async () => {
      await indexRun("hill-2", "on_the_hill", 1);
      await indexRun("closed-pr", "stopped", 1, { prNumber: 60 });
      expect(await openRunPrs(env.DB)).toEqual([
        { repo: REPO, prNumber: 58 },
        { repo: REPO, prNumber: 59 },
        { repo: "eve/simplegoapp", prNumber: 58 },
      ]);
    });

    it("runsOnHead says whether that head's runs are open, all ended, or none", async () => {
      expect(await runsOnHead(env.DB, REPO, 58, "sha-a")).toBe("open");
      expect(await runsOnHead(env.DB, REPO, 58, "sha-b")).toBe("open");
      for (const sha of ["sha-c", "sha-d", "sha-e"]) {
        expect(await runsOnHead(env.DB, REPO, 58, sha)).toBe("ended");
      }
      expect(await runsOnHead(env.DB, REPO, 58, "sha-z")).toBe("none");
      expect(await runsOnHead(env.DB, REPO, 59, "sha-a")).toBe("none");
      expect(await runsOnHead(env.DB, "eve/simplegoapp", 58, "sha-a")).toBe("none");
    });

    it("runsOnHead counts a head open while any of its runs is", async () => {
      await indexRun("stopped-on-a", "stopped", 1, { headSha: "sha-a" });
      expect(await runsOnHead(env.DB, REPO, 58, "sha-a")).toBe("open");
    });
  });
});

describe("designs owed", () => {
  const REPO = "aghchan/simplegoapp";
  const OTHER_REPO = "eve/simplegoapp";

  // A run of a code PR the owner bypassed at `at`, created then too, swept unless `over` says
  // otherwise.
  const bypassed = (id: string, prNumber: number, at: number, over: Partial<RunSnapshot> = {}) =>
    indexRun(id, "swept", at, {
      prNumber,
      prTitle: `PR ${prNumber}`,
      designBypassedAt: at,
      createdAt: at,
      steps: steps("sweep", "done"),
      ...over,
    });

  // A run of a design PR, whose description says which PRs it is for, its review clear unless
  // `over` says otherwise.
  const design = (
    id: string,
    status: RunStatus,
    covers: number[],
    over: Partial<RunSnapshot> = {},
  ) =>
    indexRun(id, status, 1, {
      prNumber: 900,
      goal: ["Design after the fact", ...covers.map((pr) => `For: #${pr}`)].join("\n"),
      outcome: "clear",
      ...over,
    });

  const owed = async () => (await listOwedDesigns(env.DB)).map((entry) => entry.prNumber);

  it("lists a bypassed PR until a landed design covers it", async () => {
    await bypassed("code", 58, 100);
    await indexRun("not-bypassed", "swept", 5, { prNumber: 59 });
    expect(await listOwedDesigns(env.DB)).toEqual([
      { repo: REPO, prNumber: 58, prTitle: "PR 58", runId: "code", bypassedAt: 100 },
    ]);

    // A design that has not landed yet, or never will, covers nothing.
    await design("open", "on_the_hill", [58]);
    await design("swept", "swept", [58]);
    await design("stopped", "stopped", [58], { prNumber: 901 });
    expect(await owed()).toEqual([58]);

    await design("landed", "landed", [58], { prNumber: 902 });
    expect(await listOwedDesigns(env.DB)).toEqual([]);
  });

  // A design PR merged past a failing or unfinished review never passed the design gate.
  it.each<ReviewOutcome>(["hazards", "failed", "pending", "none"])(
    "a landed design whose review is %s covers nothing",
    async (outcome) => {
      await bypassed("code", 58, 100);
      await design("landed", "landed", [58], { outcome });
      expect(await owed()).toEqual([58]);
      await design("clear", "landed", [58], { prNumber: 901 });
      expect(await owed()).toEqual([]);
    },
  );

  // Only the run that speaks for a PR can owe its design: the newest open run, else the newest
  // landed. A bypass on any other run is no longer the PR's.
  describe("the run that speaks for the PR", () => {
    it.each<RunStatus>(["on_the_hill", "swept", "landed"])(
      "owes the design when a %s run is bypassed",
      async (status) => {
        await bypassed("code", 58, 100, { status });
        expect(await listOwedDesigns(env.DB)).toEqual([
          { repo: REPO, prNumber: 58, prTitle: "PR 58", runId: "code", bypassedAt: 100 },
        ]);
      },
    );

    it("a landed bypassed PR owes it until a landed design covers it", async () => {
      await bypassed("code", 58, 100, { status: "landed" });
      await design("open", "on_the_hill", [58]);
      expect(await owed()).toEqual([58]);
      await design("landed", "landed", [58], { prNumber: 901 });
      expect(await owed()).toEqual([]);
    });

    it.each<RunStatus>(["stopped", "failed"])(
      "a PR closed unmerged, its bypassed run %s, owes nothing",
      async (status) => {
        await bypassed("code", 58, 100, { status });
        expect(await owed()).toEqual([]);
      },
    );

    it("a landed run that passed the design gate owes nothing, whatever was bypassed before", async () => {
      await bypassed("pushed-over", 58, 100, { status: "stopped" });
      await indexRun("landed", "landed", 200, { prNumber: 58, createdAt: 200 });
      expect(await owed()).toEqual([]);
    });

    it("an open run that was not bypassed owes nothing, though an earlier run was", async () => {
      await bypassed("earlier", 58, 100);
      await indexRun("later-push", "on_the_hill", 200, { prNumber: 58, createdAt: 200 });
      expect(await owed()).toEqual([]);
    });

    it("owes it again from the newer run, once the owner bypasses that one", async () => {
      await bypassed("earlier", 58, 100, { status: "stopped" });
      await bypassed("later-push", 58, 300, { status: "on_the_hill", prTitle: "orders: retitled" });
      expect(await listOwedDesigns(env.DB)).toEqual([
        { repo: REPO, prNumber: 58, prTitle: "orders: retitled", runId: "later-push", bypassedAt: 300 },
      ]);
    });

    it("a stopped run newer than the open one does not speak for the PR", async () => {
      await bypassed("open", 58, 100, { status: "on_the_hill" });
      await indexRun("raced", "stopped", 200, { prNumber: 58, createdAt: 200 });
      expect(await listOwedDesigns(env.DB)).toMatchObject([{ runId: "open", bypassedAt: 100 }]);
    });

    it("an open run speaks before a landed one, however much newer that is", async () => {
      await bypassed("landed", 58, 300, { status: "landed" });
      await indexRun("open", "on_the_hill", 200, { prNumber: 58, createdAt: 200 });
      expect(await owed()).toEqual([]);
    });
  });

  it("a PR's own landed run never covers it, whatever its description says", async () => {
    await bypassed("code", 58, 100, { status: "landed", goal: "Cancel orders.\n\nFor: #58" });
    expect(await owed()).toEqual([58]);
    // Another PR's landed run still does.
    await design("design", "landed", [58]);
    expect(await owed()).toEqual([]);
  });

  it("For: #5 does not cover PR 58 or 5x", async () => {
    for (const pr of [5, 15, 50, 58, 105, 555]) await bypassed(`code-${pr}`, pr, pr);
    await design("landed", "landed", [5]);
    expect((await owed()).sort((a, b) => a - b)).toEqual([15, 50, 58, 105, 555]);
  });

  it("For: #58 does not cover PR 5, 8 or 158", async () => {
    for (const pr of [5, 8, 58, 158, 580]) await bypassed(`code-${pr}`, pr, pr);
    await design("landed", "landed", [58]);
    expect((await owed()).sort((a, b) => a - b)).toEqual([5, 8, 158, 580]);
  });

  it("For: #12 covers PR 12, never PR 1 or PR 123", async () => {
    for (const pr of [1, 12, 123, 2]) await bypassed(`code-${pr}`, pr, pr);
    await design("landed", "landed", [12]);
    expect((await owed()).sort((a, b) => a - b)).toEqual([1, 2, 123]);
  });

  it("covers the first, a middle and the last PR a design names", async () => {
    for (const pr of [7, 12, 58, 8, 5]) await bypassed(`code-${pr}`, pr, pr);
    await design("landed", "landed", [7, 12, 58]);
    expect((await owed()).sort((a, b) => a - b)).toEqual([5, 8]);
  });

  it("covers a PR in the design's own repo only", async () => {
    await bypassed("code", 58, 100);
    await design("elsewhere", "landed", [58], { repo: OTHER_REPO });
    expect(await owed()).toEqual([58]);
    await design("here", "landed", [58], { prNumber: 901 });
    expect(await owed()).toEqual([]);
  });

  it("owes a PR of another repo separately", async () => {
    await bypassed("mine", 58, 100);
    await bypassed("theirs", 58, 200, { repo: OTHER_REPO });
    await design("landed", "landed", [58], { repo: OTHER_REPO });
    expect(await listOwedDesigns(env.DB)).toMatchObject([{ repo: REPO, runId: "mine" }]);
  });

  it("one entry per PR, its speaking run's bypass", async () => {
    await bypassed("first", 58, 100);
    await bypassed("second", 58, 300, { prTitle: "orders: retitled" });
    await bypassed("middle", 58, 200);
    await bypassed("other", 60, 250);
    expect(await listOwedDesigns(env.DB)).toEqual([
      { repo: REPO, prNumber: 58, prTitle: "orders: retitled", runId: "second", bypassedAt: 300 },
      { repo: REPO, prNumber: 60, prTitle: "PR 60", runId: "other", bypassedAt: 250 },
    ]);
  });

  it("lists the newest bypass first", async () => {
    await bypassed("old", 58, 100);
    await bypassed("new", 60, 300);
    await bypassed("mid", 61, 200);
    expect(await owed()).toEqual([60, 61, 58]);
  });

  it("indexes what a run's goal covers, and none for a goal that covers nothing", async () => {
    const covers = async (id: string) => {
      const row = await env.DB.prepare("SELECT covers FROM runs WHERE id = ?")
        .bind(id)
        .first<{ covers: string | null }>();
      return row?.covers;
    };
    await design("two", "landed", [12, 7, 12]);
    await design("none", "landed", []);
    await indexRun("plain", "landed", 1, { goal: "Cancel orders." });
    expect(await covers("two")).toBe("12,7");
    expect(await covers("none")).toBeNull();
    expect(await covers("plain")).toBeNull();
  });

  it("indexes the bypass time, and none for a run that was not bypassed", async () => {
    await bypassed("code", 58, 100);
    await indexRun("plain", "swept", 5);
    const at = async (id: string) => {
      const row = await env.DB.prepare("SELECT design_bypassed_at AS at FROM runs WHERE id = ?")
        .bind(id)
        .first<{ at: number | null }>();
      return row?.at;
    };
    expect(await at("code")).toBe(100);
    expect(await at("plain")).toBeNull();
  });
});
