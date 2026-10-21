import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentSnapshot, ReviewOutcome } from "../../shared/src/types.ts";
import { PipelineRow } from "../src/components/PipelineRow.tsx";
import { agent, makeRun, START, step } from "./fixtures.ts";

const run = makeRun();

function renderRow(over: Partial<Parameters<typeof PipelineRow>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <PipelineRow
      steps={run.steps}
      agents={run.agents}
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

  describe("a done sweep", () => {
    const sweepDone = (outcome: ReviewOutcome) => [
      step("sweep", "done", { startedAt: START, finishedAt: START + 5000, outcome }),
      step("huddle", "pending"),
    ];
    const sweepButton = () => screen.getByRole("button", { name: /Patrol sweep/ });
    const swept = () => screen.getByText("Swept");

    it("shows a clear review with a green check and a green Swept flag", () => {
      renderRow({ steps: sweepDone("clear"), agents: [agent("mainline", { status: "clear" })] });
      expect(sweepButton()).toHaveTextContent("Done · 5s");
      expect(sweepButton().querySelector(".mark-ok")).not.toBeNull();
      expect(swept()).toHaveTextContent("Swept reached");
      expect(swept().querySelector(".flag-ok")).not.toBeNull();
    });

    it.each<[ReviewOutcome, AgentSnapshot[], string, string]>([
      [
        "hazards",
        [agent("kt-22", { status: "hazards" }), agent("mainline", { status: "clear" })],
        "Done · hazards flagged · 5s",
        "hazard",
      ],
      [
        "failed",
        [
          agent("mainline", { status: "error" }),
          agent("kt-22", { status: "stopped" }),
          agent("granite-chief", { status: "hazards" }),
        ],
        "Done · 2 failed · 5s",
        "bad",
      ],
      ["none", [], "Done · no patrollers · 5s", "idle"],
    ])("never shows a %s review as a pass", (outcome, agents, text, tone) => {
      const { container } = render(
        <PipelineRow
          steps={sweepDone(outcome)}
          agents={agents}
          selected="sweep"
          now={START + 9000}
          onSelect={vi.fn()}
        />,
      );
      expect(sweepButton()).toHaveTextContent(text);
      expect(sweepButton().querySelector(`.mark-${tone}`)).not.toBeNull();
      expect(container.querySelector(".mark-ok")).toBeNull();
      // All verdicts are in, so the flag is reached, but it is not green.
      expect(swept()).toHaveTextContent("Swept reached");
      expect(container.querySelector(".flag-ok")).toBeNull();
    });

    it("counts only the failures of that step", () => {
      const huddler = agent("mainline", { id: "mainline-huddle-1", step: "huddle", status: "error" });
      renderRow({
        steps: sweepDone("failed"),
        agents: [agent("kt-22", { status: "error" }), huddler],
        now: START + 9000,
      });
      expect(sweepButton()).toHaveTextContent("Done · 1 failed");
    });
  });
});
