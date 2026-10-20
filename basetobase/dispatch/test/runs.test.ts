import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Rating } from "../../shared/src/config.ts";
import type { RunSnapshot, RunStatus, StepSnapshot } from "../../shared/src/types.ts";
import { activeRunNames, findActiveRuns, listRuns, upsertRun } from "../src/runs/index.ts";

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
        currentStep: "sweep",
        updatedAt: 5,
      },
    ]);
  });

  it("updates a run in place", async () => {
    await indexRun("a", "on_the_hill", 5);
    await indexRun("a", "swept", 9, { steps: steps("sweep", "done") });
    expect(await listRuns(env.DB)).toMatchObject([{ id: "a", status: "swept", updatedAt: 9 }]);
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

  it("names only the runs on the hill with that rating", async () => {
    await indexRun("a", "on_the_hill", 1, { rating: "black", runName: "Red Dog Face" });
    await indexRun("b", "swept", 1, { rating: "black", runName: "Headwall Face" });
    await indexRun("c", "on_the_hill", 1, { rating: "green", runName: "Easy Slider" });
    const rating: Rating = "black";
    expect(await activeRunNames(env.DB, rating)).toEqual(["Red Dog Face"]);
  });

  it("finds a pull request's runs on the hill", async () => {
    await indexRun("hill", "on_the_hill", 1, { headSha: "sha-a" });
    await indexRun("done", "swept", 1, { headSha: "sha-b" });
    await indexRun("other-pr", "on_the_hill", 1, { prNumber: 59 });
    await indexRun("other-repo", "on_the_hill", 1, { repo: "eve/simplegoapp" });
    expect(await findActiveRuns(env.DB, "aghchan/simplegoapp", 58)).toEqual([
      { id: "hill", headSha: "sha-a" },
    ]);
  });
});
