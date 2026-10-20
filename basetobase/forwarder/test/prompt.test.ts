import { describe, expect, it } from "vitest";
import type { AgentBrief } from "../../shared/src/types.ts";
import { buildPrompt } from "../src/prompt.ts";

const brief: AgentBrief = {
  role: "mainline",
  name: "Mainline",
  model: "sonnet",
  prefix: "FUN",
  goal: "orders: add cancel endpoint",
  prNumber: 58,
  baseSha: "base58",
  headSha: "head58",
};

describe("buildPrompt", () => {
  it("puts role text first and includes goal, diff and verdict path", () => {
    const p = buildPrompt(brief, "ROLE", "VERDICT", "/w/verdict.json");
    expect(p.startsWith("ROLE")).toBe(true);
    expect(p).toContain("git diff base58...head58");
    expect(p).toContain("Goal:\norders: add cancel endpoint");
    expect(p).toContain("/w/verdict.json");
    expect(p).toContain("VERDICT");
  });

  it("lays the sections out in order, one blank line apart", () => {
    expect(buildPrompt(brief, "ROLE\n", "VERDICT\n", "/w/verdict.json")).toBe(
      [
        "ROLE",
        "Goal:\norders: add cancel endpoint",
        "PR #58. Review: git diff base58...head58",
        "VERDICT",
        "Write the verdict JSON to /w/verdict.json. Role: mainline. Head SHA: head58. Hazard ids: FUN-N.",
      ].join("\n\n"),
    );
  });
});
