import { describe, expect, it } from "vitest";
import raw from "../../config/basetobase.json" with { type: "json" };
import { config, loadConfig, rosterEntry } from "../src/config.ts";

describe("loadConfig", () => {
  it("names the missing field", () => {
    const trailNames = { ...raw.trailNames, green: undefined };
    expect(() => loadConfig({ ...raw, trailNames })).toThrow(/trailNames\.green/);
  });
  it("rejects unknown enabled role", () =>
    expect(() => loadConfig({ ...raw, enabledRoles: ["nope"] })).toThrow(/enabledRoles/));
  it("rejects an empty trail name list", () => {
    const trailNames = { ...raw.trailNames, black: [] };
    expect(() => loadConfig({ ...raw, trailNames })).toThrow(/trailNames\.black/);
  });
});

describe("rosterEntry", () => {
  it("finds an entry by id", () => {
    expect(rosterEntry(config, "groomer")).toEqual({
      id: "groomer",
      name: "Groomer",
      role: "Implementer",
      prefix: "",
      panels: [],
      model: "opus",
    });
  });
  it("throws for a role missing from the roster", () =>
    expect(() => rosterEntry({ ...config, roster: [] }, "mainline")).toThrow(/mainline/));
});
