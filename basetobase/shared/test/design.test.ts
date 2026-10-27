import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { coversOf, NO_DESIGN_TITLE } from "../src/design.ts";

const template = readFileSync(
  new URL("../../../.basetobase/patrol/granite-chief.md", import.meta.url),
  "utf8",
);

describe("NO_DESIGN_TITLE", () => {
  it("is the title the bypass waives", () => expect(NO_DESIGN_TITLE).toBe("No approved design"));
});

describe("Granite Chief's patrol template", () => {
  it.each([NO_DESIGN_TITLE, "Design:", "Fixes:", "For:", "git show", "docs/superpowers/specs/"])(
    "mentions %s",
    (text) => expect(template).toContain(text),
  );

  it.each([
    // a design renamed out of the specs folder shows as an edit of it
    "git diff --name-only --no-renames",
    // the beyond-the-fix list follows the simple-bug-fix rule (plugins/standard/rules.md)
    "infrastructure",
    "A `Design:` path outside `docs/superpowers/specs/` → hazard.",
    // a design PR is held to its own block alone
    "Apply none of the Code PR rules",
    // an edit of an approved design must add a round and a newer quorum
    "a `Round <n>:` the base lacks",
    // the panel's prefixes end where the template's reason begins (template.md)
    "`Panel: <prefixes>. Why: <reason>`",
  ])("says %s", (text) => expect(template).toContain(text));

  it("stays within the house style's 40 lines", () => {
    const lines = template.split("\n").filter((line) => line.trim() !== "");
    expect(lines.length).toBeLessThanOrEqual(40);
  });
});

describe("coversOf", () => {
  it("reads each For: line once, in order", () =>
    expect(coversOf("x\nFor: #12\nFor: #12\nFor: #7 ")).toEqual([12, 7]));

  it("reads a goal's title and body, whatever the line endings", () =>
    expect(coversOf("Design: orders\r\n\r\nFor: #12\r\nFor: #7\r\n")).toEqual([12, 7]));

  it.each(["Before: #3", "see For: #3", "For: #3 and #4", "For: 3", "for: #3", " For: #3", "For:#3"])(
    "reads nothing from %j",
    (goal) => expect(coversOf(goal)).toEqual([]),
  );

  it("reads nothing from a goal with no such line", () => expect(coversOf("")).toEqual([]));
});
