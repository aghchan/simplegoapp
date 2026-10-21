import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PipelineRow } from "../src/components/PipelineRow.tsx";
import { makeRun, START, step } from "./fixtures.ts";

const run = makeRun();

function renderRow(over: Partial<Parameters<typeof PipelineRow>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <PipelineRow
      steps={run.steps}
      selected="sweep"
      now={START + 872_000}
      onSelect={onSelect}
      {...over}
    />,
  );
  return onSelect;
}

describe("PipelineRow", () => {
  it("shows themed and plain labels with live elapsed", () => {
    renderRow();
    expect(
      screen.getByRole("button", { name: /Patrol sweep.*Independent review.*14m 32s/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("button")).toHaveLength(7);
    expect(screen.getByText("Swept")).toBeVisible();
  });

  it("gives every step its themed name with its plain name", () => {
    renderRow();
    expect(screen.getByRole("button", { name: /Lift line.*PR opened/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Trail map.*Triage/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Patrol huddle.*Quorum/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Summit check.*Final verify/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Drop in.*Merge/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Send it.*Deploy/ })).toBeVisible();
  });

  it("marks only the selected step as pressed", () => {
    renderRow();
    const pressed = screen
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
  });

  it("selects the step that is clicked", async () => {
    const onSelect = renderRow();
    await userEvent.click(screen.getByRole("button", { name: /Lift line/ }));
    expect(onSelect).toHaveBeenCalledWith("lift_line");
  });

  it("can be used from the keyboard", async () => {
    const onSelect = renderRow();
    screen.getByRole("button", { name: /Trail map/ }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("trail_map");
  });

  it("shows how long a finished step took and that a pending one is waiting", () => {
    renderRow();
    expect(screen.getByRole("button", { name: /Lift line.*Done.*39s/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Trail map.*Done.*41s/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Patrol huddle.*Waiting/ })).toBeVisible();
  });

  it("shows a stopped step as stopped, with the time it had been running", () => {
    const steps = [step("sweep", "stopped", { startedAt: START, finishedAt: START + 125_000 })];
    renderRow({ steps, now: START + 999_000 });
    expect(screen.getByRole("button", { name: /Patrol sweep.*Stopped.*2m 05s/ })).toBeVisible();
  });

  it("says whether each milestone flag has been reached", () => {
    const steps = [
      step("sweep", "done", { startedAt: START, finishedAt: START + 5000 }),
      step("huddle", "pending"),
    ];
    renderRow({ steps });
    expect(screen.getByText("Swept")).toHaveTextContent("Swept reached");
    expect(screen.getByText("All clear")).toHaveTextContent("All clear not yet reached");
  });
});
