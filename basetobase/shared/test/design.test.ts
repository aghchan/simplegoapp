import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NO_DESIGN_TITLE } from "../src/design.ts";

const template = readFileSync(
  new URL("../../../.basetobase/patrol/granite-chief.md", import.meta.url),
  "utf8",
);

describe("NO_DESIGN_TITLE", () => {
  it("is the title the bypass waives", () => expect(NO_DESIGN_TITLE).toBe("No approved design"));
});

describe("Granite Chief's patrol template", () => {
  it.each([NO_DESIGN_TITLE, "Design:", "Fixes:", "git show", "docs/superpowers/specs/"])(
    "mentions %s",
    (text) => expect(template).toContain(text),
  );
  it("stays within the house style's 40 lines", () => {
    const lines = template.split("\n").filter((line) => line.trim() !== "");
    expect(lines.length).toBeLessThanOrEqual(40);
  });
});
