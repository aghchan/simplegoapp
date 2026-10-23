import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ReviewOutcome, RunStatus, RunSummary } from "../../shared/src/types.ts";
import { newestRun, newestSpeakingRun, RunsList } from "../src/pages/RunsList.tsx";

// Each id is its own PR, unless a test gives two runs one prNumber.
const PR_OF_ID = new Map<string, number>();
function prOf(id: string): number {
  if (!PR_OF_ID.has(id)) PR_OF_ID.set(id, 100 + PR_OF_ID.size);
  return PR_OF_ID.get(id)!;
}

function run(id: string, status: RunStatus, over: Partial<RunSummary> = {}): RunSummary {
  return {
    id,
    prNumber: prOf(id),
    prTitle: "orders: add cancel endpoint",
    runName: `Trail ${id}`,
    rating: "green",
    status,
    // As reviewOutcome gives it: a swept run defaults to a clear review.
    outcome: status === "swept" ? "clear" : status === "failed" ? "failed" : "pending",
    currentStep: "sweep",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

// The hrefs of the top-level runs filed under a heading: earlier runs are not counted.
function group(name: string): (string | null)[] {
  const section = screen.getByRole("heading", { name }).closest("section")!;
  return within(section)
    .getAllByRole("link")
    .filter((link) => link.closest(".run-earlier") === null)
    .map((link) => link.getAttribute("href"));
}

describe("newestRun", () => {
  it("is the run started last, wherever it is listed", () => {
    const runs = [run("r1", "stopped", { createdAt: 5 }), run("r2", "swept", { createdAt: 9 })];
    expect(newestRun(runs)?.id).toBe("r2");
  });

  it("is the one listed first when two started together", () => {
    const runs = [run("r1", "swept", { createdAt: 9 }), run("r2", "swept", { createdAt: 9 })];
    expect(newestRun(runs)?.id).toBe("r1");
  });

  it("is nothing when there are no runs", () => {
    expect(newestRun([])).toBeUndefined();
  });
});

describe("newestSpeakingRun", () => {
  it("passes over a PR's newer run that Dispatch stopped in a race", () => {
    const runs = [
      run("r1", "on_the_hill", { prNumber: 58, createdAt: 4 }),
      run("r2", "stopped", { prNumber: 58, createdAt: 9 }),
      run("r3", "swept", { prNumber: 59, createdAt: 6 }),
    ];
    expect(newestSpeakingRun(runs)?.id).toBe("r3");
  });

  it("is a PR's landed run when it is newer than another PR's open one", () => {
    const runs = [
      run("r1", "landed", { prNumber: 58, createdAt: 7 }),
      run("r2", "stopped", { prNumber: 58, createdAt: 9 }),
      run("r3", "on_the_hill", { prNumber: 59, createdAt: 6 }),
    ];
    expect(newestSpeakingRun(runs)?.id).toBe("r1");
  });

  it("is nothing when there are no runs", () => {
    expect(newestSpeakingRun([])).toBeUndefined();
  });
});

describe("RunsList", () => {
  it("groups runs and links to each", () => {
    render(
      <RunsList
        runs={[
          run("r1", "on_the_hill", { runName: "Red Dog Face", rating: "black" }),
          run("r2", "stopped"),
          run("r3", "failed"),
          run("r4", "swept"),
          run("r5", "landed"),
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: "Wind hold · needs you" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "On the hill · running" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Swept · patrol done" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Landed · merged" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Closed" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Red Dog Face/ })).toHaveAttribute("href", "/runs/r1");
    expect(screen.getByRole("img", { name: "Black diamond" })).toBeVisible();
  });

  it("hides empty groups", () => {
    render(<RunsList runs={[run("r1", "on_the_hill")]} />);
    expect(screen.queryByRole("heading", { name: /needs you/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Closed" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^Swept/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^Landed/ })).toBeNull();
  });

  it("puts each run under the heading for its status", () => {
    render(
      <RunsList
        runs={[
          run("r1", "failed"),
          run("r2", "swept"),
          run("r3", "on_the_hill"),
          run("r4", "stopped"),
          run("r5", "landed"),
        ]}
      />,
    );
    expect(group("Wind hold · needs you")).toEqual(["/runs/r1"]);
    expect(group("On the hill · running")).toEqual(["/runs/r3"]);
    expect(group("Swept · patrol done")).toEqual(["/runs/r2"]);
    expect(group("Landed · merged")).toEqual(["/runs/r5"]);
    expect(group("Closed")).toEqual(["/runs/r4"]);
  });

  it("lists the groups in order: needs you, on the hill, swept, landed, closed", () => {
    render(
      <RunsList
        runs={[
          run("r1", "stopped"),
          run("r5", "landed"),
          run("r2", "swept"),
          run("r3", "on_the_hill"),
          run("r4", "failed"),
        ]}
      />,
    );
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Wind hold · needs you",
      "On the hill · running",
      "Swept · patrol done",
      "Landed · merged",
      "Closed",
    ]);
  });

  // Where a run is filed comes from its status first: a run that has ended needs nothing.
  it.each<[RunStatus, ReviewOutcome, string]>([
    ["stopped", "hazards", "Closed"],
    ["stopped", "failed", "Closed"],
    ["stopped", "clear", "Closed"],
    ["landed", "hazards", "Landed · merged"],
    ["landed", "failed", "Landed · merged"],
    ["landed", "none", "Landed · merged"],
    ["on_the_hill", "pending", "On the hill · running"],
    ["failed", "failed", "Wind hold · needs you"],
  ])("files a %s run whose review is %s under %s", (status, outcome, heading) => {
    render(<RunsList runs={[run("r1", status, { outcome })]} />);
    expect(group(heading)).toEqual(["/runs/r1"]);
    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });

  it("does not call a stopped run with hazards urgent", () => {
    render(<RunsList runs={[run("r1", "stopped", { outcome: "hazards" })]} />);
    const link = screen.getByRole("link");
    expect(link).toHaveClass("run-quiet");
    expect(link).not.toHaveClass("run-urgent");
    expect(within(link).getByText("Stopped")).toBeVisible();
  });

  it("gives a landed run the landed colour, not the urgent or quiet one", () => {
    render(<RunsList runs={[run("r1", "landed", { outcome: "clear" })]} />);
    const link = screen.getByRole("link");
    expect(link).toHaveClass("run-landed");
    expect(link).not.toHaveClass("run-urgent");
    expect(link).not.toHaveClass("run-quiet");
  });

  it("shows the number, title and rating name beside the run name", () => {
    render(<RunsList runs={[run("r1", "stopped", { prNumber: 58, rating: "double_black" })]} />);
    const link = screen.getByRole("link");
    expect(link).toHaveTextContent("Trail r1");
    expect(link).toHaveTextContent("#58 orders: add cancel endpoint");
    expect(within(link).getByRole("img", { name: "Double black diamond" })).toBeVisible();
  });

  it("names the current step by its themed and plain labels while on the hill", () => {
    render(<RunsList runs={[run("r1", "on_the_hill", { currentStep: "sweep" })]} />);
    expect(screen.getByText("Patrol sweep · Independent review")).toBeVisible();
  });

  it.each<[RunStatus, string]>([
    ["failed", "Needs you"],
    ["stopped", "Stopped"],
    ["swept", "Swept · patrol done"],
    ["landed", "Landed · merged"],
  ])("labels a %s run %s", (status, label) => {
    render(<RunsList runs={[run("r1", status)]} />);
    expect(within(screen.getByRole("link")).getByText(label)).toBeVisible();
  });

  describe("a swept run", () => {
    const linksIn = (name: string) =>
      within(screen.getByRole("heading", { name }).closest("section")!).getAllByRole("link");

    it.each<[ReviewOutcome, string]>([
      ["hazards", "Hazards flagged"],
      ["failed", "Review failed"],
    ])("whose review is %s needs you, reading %s", (outcome, label) => {
      render(<RunsList runs={[run("r1", "swept", { outcome }), run("r2", "swept")]} />);
      const [link] = linksIn("Wind hold · needs you");
      expect(link).toHaveAttribute("href", "/runs/r1");
      expect(link).toHaveClass("run-urgent");
      expect(within(link!).getByText(label)).toBeVisible();
      expect(within(link!).queryByText("Swept · patrol done")).toBeNull();
      expect(group("Swept · patrol done")).toEqual(["/runs/r2"]);
    });

    it("reads Swept · patrol done only when its review is clear", () => {
      const outcomes: ReviewOutcome[] = ["clear", "hazards", "failed", "none", "pending"];
      render(
        <RunsList runs={outcomes.map((outcome) => run(outcome, "swept", { outcome }))} />,
      );
      const passing = screen
        .getAllByRole("link")
        .filter((link) => within(link).queryByText("Swept · patrol done") !== null);
      expect(passing.map((link) => link.getAttribute("href"))).toEqual(["/runs/clear"]);
    });

    it.each<[ReviewOutcome, string]>([
      ["none", "No patrollers for this change"],
      ["pending", "No outcome yet"],
    ])("with a %s review stays under Swept, quiet, reading %s", (outcome, label) => {
      render(<RunsList runs={[run("r1", "swept", { outcome })]} />);
      const [link] = linksIn("Swept · patrol done");
      expect(within(link!).getByText(label)).toBeVisible();
      expect(link).toHaveClass("run-quiet");
      expect(screen.queryByRole("heading", { name: /needs you/ })).toBeNull();
    });
  });

  describe("a PR's runs", () => {
    // PR #58 was pushed to twice. Listed as listRuns lists them: the first run was updated last.
    const first = run("r1", "failed", {
      prNumber: 58,
      runName: "First Chair",
      createdAt: 1,
      updatedAt: 9,
    });
    const second = run("r2", "stopped", {
      prNumber: 58,
      runName: "Second Chair",
      createdAt: 2,
      updatedAt: 8,
    });
    const latest = run("r3", "swept", {
      prNumber: 58,
      runName: "Third Chair",
      createdAt: 3,
      updatedAt: 3,
    });
    const pr58 = [first, second, latest];
    const toggle = () => screen.getByRole("button", { name: "2 earlier runs" });
    const earlierShown = () =>
      within(document.getElementById(toggle().getAttribute("aria-controls")!)!)
        .queryAllByRole("link")
        .map((link) => link.getAttribute("href"));

    it("shows the PR once, filed by its latest run", () => {
      render(<RunsList runs={pr58} />);
      expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
        "Swept · patrol done",
      ]);
      expect(group("Swept · patrol done")).toEqual(["/runs/r3"]);
      expect(screen.getAllByRole("link")).toHaveLength(1);
    });

    it("collapses the earlier runs under a button that says how many", () => {
      render(<RunsList runs={pr58} />);
      expect(toggle()).toHaveAttribute("type", "button");
      expect(toggle()).toHaveAttribute("aria-expanded", "false");
      expect(earlierShown()).toEqual([]);
      expect(screen.queryByRole("link", { name: /First Chair/ })).toBeNull();
    });

    it("shows them newest first in the list it controls, and hides them again", async () => {
      const user = userEvent.setup();
      render(<RunsList runs={pr58} />);
      await user.click(toggle());
      expect(toggle()).toHaveAttribute("aria-expanded", "true");
      expect(earlierShown()).toEqual(["/runs/r2", "/runs/r1"]);

      await user.click(toggle());
      expect(toggle()).toHaveAttribute("aria-expanded", "false");
      expect(earlierShown()).toEqual([]);
    });

    it("can be opened from the keyboard", async () => {
      const user = userEvent.setup();
      render(<RunsList runs={pr58} />);
      toggle().focus();
      await user.keyboard("{Enter}");
      expect(toggle()).toHaveAttribute("aria-expanded", "true");
    });

    it("names an earlier run by its trail and own status, quietly, without the PR", async () => {
      const user = userEvent.setup();
      render(<RunsList runs={pr58} />);
      await user.click(toggle());
      const old = screen.getByRole("link", { name: /First Chair/ });
      expect(old).toHaveTextContent("Needs you");
      expect(old).not.toHaveTextContent("#58");
      expect(old).toHaveClass("run-quiet");
      expect(old).not.toHaveClass("run-urgent");
      expect(screen.getByRole("link", { name: /Second Chair/ })).toHaveTextContent("Stopped");
    });

    it("counts one earlier run in the singular", () => {
      render(<RunsList runs={[second, latest]} />);
      expect(screen.getByRole("button", { name: "1 earlier run" })).toBeVisible();
    });

    it("has no button for a PR with one run", () => {
      render(<RunsList runs={[latest]} />);
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("opens by itself when the current page is one of the earlier runs", () => {
      render(<RunsList runs={pr58} activeRunId="r1" />);
      expect(toggle()).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("link", { name: /First Chair/ })).toHaveAttribute(
        "aria-current",
        "page",
      );
    });

    it("opens by itself when the page moves to an earlier run", () => {
      const { rerender } = render(<RunsList runs={pr58} activeRunId="r3" />);
      expect(toggle()).toHaveAttribute("aria-expanded", "false");
      rerender(<RunsList runs={pr58} activeRunId="r2" />);
      expect(toggle()).toHaveAttribute("aria-expanded", "true");
    });

    it("opens by itself when a newer run pushes the one on show down", () => {
      const { rerender } = render(<RunsList runs={[second, latest]} activeRunId="r3" />);
      const newer = run("r4", "on_the_hill", { prNumber: 58, createdAt: 4, updatedAt: 10 });
      rerender(<RunsList runs={[newer, second, latest]} activeRunId="r3" />);
      expect(group("On the hill · running")).toEqual(["/runs/r4"]);
      expect(toggle()).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("link", { name: /Trail r4/ })).not.toHaveAttribute("aria-current");
    });

    it("can be closed while the page is on an earlier run", async () => {
      const user = userEvent.setup();
      render(<RunsList runs={pr58} activeRunId="r1" />);
      await user.click(toggle());
      expect(toggle()).toHaveAttribute("aria-expanded", "false");
    });

    it("orders the PRs in a group as their latest runs are listed", () => {
      const other = run("r9", "swept", { prNumber: 59, createdAt: 5, updatedAt: 7 });
      // listRuns order: r1 (updated 9), r2, r9, r3.
      render(<RunsList runs={[first, second, other, latest]} />);
      expect(group("Swept · patrol done")).toEqual(["/runs/r9", "/runs/r3"]);
      expect(screen.getAllByRole("button")).toHaveLength(1);
    });

    // The sweep finishes, and the PR moves from Swept to Landed.
    const landed: RunSummary = { ...latest, status: "landed", updatedAt: 10 };

    it("stays open when the PR moves to another group", async () => {
      const user = userEvent.setup();
      const { rerender } = render(<RunsList runs={pr58} />);
      await user.click(toggle());
      rerender(<RunsList runs={[landed, first, second]} />);
      expect(group("Landed · merged")).toEqual(["/runs/r3"]);
      expect(toggle()).toHaveAttribute("aria-expanded", "true");
      expect(earlierShown()).toEqual(["/runs/r2", "/runs/r1"]);
    });

    it("keeps the keyboard's focus when the PR moves to another group", async () => {
      const user = userEvent.setup();
      const { rerender } = render(<RunsList runs={pr58} />);
      toggle().focus();
      await user.keyboard("{Enter}");
      rerender(<RunsList runs={[landed, first, second]} />);
      expect(group("Landed · merged")).toEqual(["/runs/r3"]);
      expect(toggle()).toHaveFocus();
    });

    it("does not take the focus back when the PR returns to the list later", () => {
      const other = run("r9", "swept", { prNumber: 59 });
      const { rerender } = render(<RunsList runs={[...pr58, other]} />);
      toggle().focus();
      rerender(<RunsList runs={[other]} />);
      const link = screen.getByRole("link", { name: /Trail r9/ });
      link.focus();
      rerender(<RunsList runs={[...pr58, other]} />);
      expect(link).toHaveFocus();
    });
  });

  // Dispatch keeps the newest open run on the PR's head, so a race can leave a run it stopped
  // newer than the one that is live or landed.
  describe("a PR whose newest run was stopped in a race", () => {
    it.each<[RunStatus, string]>([
      ["on_the_hill", "On the hill · running"],
      ["swept", "Swept · patrol done"],
      ["landed", "Landed · merged"],
    ])("is filed by its %s run, under %s", (status, heading) => {
      render(
        <RunsList
          runs={[
            run("r1", status, { prNumber: 58, createdAt: 4 }),
            run("r2", "stopped", { prNumber: 58, createdAt: 5 }),
          ]}
        />,
      );
      expect(group(heading)).toEqual(["/runs/r1"]);
      expect(screen.queryByRole("heading", { name: "Closed" })).toBeNull();
      expect(screen.getByRole("button", { name: "1 earlier run" })).toBeVisible();
    });

    it("is filed by its open run before a newer landed one", () => {
      render(
        <RunsList
          runs={[
            run("r1", "on_the_hill", { prNumber: 58, createdAt: 4 }),
            run("r2", "landed", { prNumber: 58, createdAt: 5 }),
          ]}
        />,
      );
      expect(group("On the hill · running")).toEqual(["/runs/r1"]);
      expect(screen.queryByRole("heading", { name: "Landed · merged" })).toBeNull();
    });
  });

  it("marks the open run as the current page", () => {
    render(
      <RunsList runs={[run("r1", "on_the_hill"), run("r2", "on_the_hill")]} activeRunId="r2" />,
    );
    expect(screen.getByRole("link", { name: /Trail r2/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /Trail r1/ })).not.toHaveAttribute("aria-current");
  });

  it("says so when there are no runs", () => {
    render(<RunsList runs={[]} />);
    expect(screen.getByText(/No runs yet/)).toBeVisible();
    expect(screen.queryByRole("heading")).toBeNull();
  });
});
