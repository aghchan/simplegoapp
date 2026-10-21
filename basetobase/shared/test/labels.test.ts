import { describe, expect, it } from "vitest";
import {
  AGENT_STATUS_LABELS,
  OUTCOME_LABELS,
  RUN_STATUS_LABELS,
  STEP_LABELS,
} from "../src/labels.ts";

describe("labels", () => {
  it("gives every step a themed and a plain label", () => {
    for (const label of Object.values(STEP_LABELS)) {
      expect(label.themed).not.toBe("");
      expect(label.plain).not.toBe("");
      expect(label.plain).not.toBe(label.themed);
    }
  });

  it("states what the themed run statuses mean", () => {
    expect(RUN_STATUS_LABELS.on_the_hill).toBe("On the hill · running");
    expect(RUN_STATUS_LABELS.swept).toBe("Swept · patrol done");
  });

  it("does not name a milestone of the run in a status", () => {
    const milestones = Object.values(STEP_LABELS).flatMap((label) => label.milestone ?? []);
    expect(milestones).toContain("All clear");
    expect(Object.values(AGENT_STATUS_LABELS)).not.toContain("All clear");
    expect(AGENT_STATUS_LABELS.clear).toBe("Clear");
    expect(Object.values(OUTCOME_LABELS)).not.toContain("All clear");
  });

  it("names each review outcome, saying a pass only for clear", () => {
    expect(OUTCOME_LABELS).toEqual({
      pending: "No outcome yet",
      none: "No patrollers for this change",
      clear: "Patrol clear · review passed",
      hazards: "Hazards flagged",
      failed: "Review failed",
    });
  });
});
