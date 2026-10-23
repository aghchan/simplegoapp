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
