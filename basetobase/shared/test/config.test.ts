import { describe, expect, it } from "vitest";
import shipped from "../../config/basetobase.json" with { type: "json" };
import trailNameFile from "../../config/trail-names.json" with { type: "json" };
import { config, loadConfig, rosterEntry } from "../src/config.ts";

const raw = { ...shipped, trailNames: trailNameFile.trailNames };

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
  it("requires the unpatrolled globs", () =>
    expect(() => loadConfig({ ...raw, unpatrolledGlobs: undefined })).toThrow(
      /unpatrolledGlobs must be an array/,
    ));
  it("rejects an unpatrolled glob that is not a string", () =>
    expect(() => loadConfig({ ...raw, unpatrolledGlobs: ["basetobase/**", 7] })).toThrow(
      /unpatrolledGlobs\[1\]/,
    ));
  it("requires the refresh globs", () =>
    expect(() => loadConfig({ ...raw, refreshGlobs: undefined })).toThrow(
      /refreshGlobs must be an array/,
    ));
  it("lets the refresh workflow touch the trail names and their saved answers only", () =>
    expect(config.refreshGlobs).toEqual([
      "basetobase/config/trail-names.json",
      "basetobase/scripts/overpass/*.json",
    ]));
  it("leaves Base to Base's own files unpatrolled", () =>
    expect(config.unpatrolledGlobs).toEqual([
      "basetobase/**",
      ".basetobase/**",
      ".github/workflows/basetobase-*.yml",
    ]));
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
