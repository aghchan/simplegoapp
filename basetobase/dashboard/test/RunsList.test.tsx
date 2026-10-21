import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunStatus, RunSummary } from "../../shared/src/types.ts";
import { RunsList } from "../src/pages/RunsList.tsx";

function run(id: string, status: RunStatus, over: Partial<RunSummary> = {}): RunSummary {
  return {
    id,
    prNumber: 58,
    prTitle: "orders: add cancel endpoint",
    runName: `Trail ${id}`,
    rating: "green",
    status,
    currentStep: "sweep",
    updatedAt: 1,
    ...over,
  };
}

describe("RunsList", () => {
  it("groups runs and links to each", () => {
    render(
      <RunsList
        runs={[
          run("r1", "on_the_hill", { runName: "Red Dog Face", rating: "black" }),
          run("r2", "stopped"),
          run("r3", "failed"),
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: "Wind hold · needs you" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "On the hill" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Closed" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Red Dog Face/ })).toHaveAttribute("href", "/runs/r1");
    expect(screen.getByRole("img", { name: "Black diamond" })).toBeVisible();
  });

  it("hides empty groups", () => {
    render(<RunsList runs={[run("r1", "on_the_hill")]} />);
    expect(screen.queryByRole("heading", { name: /needs you/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Closed" })).toBeNull();
  });

  it("puts each run under the heading for its status", () => {
    render(
      <RunsList
        runs={[
          run("r1", "failed"),
          run("r2", "swept"),
          run("r3", "on_the_hill"),
          run("r4", "stopped"),
        ]}
      />,
    );
    const group = (name: string) =>
      within(screen.getByRole("heading", { name }).closest("section")!).getAllByRole("link");
    expect(group("Wind hold · needs you").map((l) => l.getAttribute("href"))).toEqual(["/runs/r1"]);
    expect(group("On the hill").map((l) => l.getAttribute("href"))).toEqual([
      "/runs/r2",
      "/runs/r3",
    ]);
    expect(group("Closed").map((l) => l.getAttribute("href"))).toEqual(["/runs/r4"]);
  });

  it("shows the number, title and rating name beside the run name", () => {
    render(<RunsList runs={[run("r1", "stopped", { rating: "double_black" })]} />);
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
    ["swept", "Swept · huddle arrives in M3"],
  ])("labels a %s run %s", (status, label) => {
    render(<RunsList runs={[run("r1", status)]} />);
    expect(screen.getByText(label)).toBeVisible();
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
