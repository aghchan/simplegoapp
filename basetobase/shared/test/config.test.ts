import { describe, expect, it } from "vitest";
import shipped from "../../config/basetobase.json" with { type: "json" };
import trailNameFile from "../../config/trail-names.json" with { type: "json" };
import { config, loadConfig, rosterEntry, withEnabledRoles } from "../src/config.ts";

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
  it("enables Granite Chief and Mainline", () =>
    expect(config.enabledRoles).toEqual(["granite-chief", "mainline"]));
  it("leaves Base to Base's own files unpatrolled", () =>
    expect(config.unpatrolledGlobs).toEqual([
      "basetobase/**",
      ".basetobase/**",
      ".github/workflows/basetobase-*.yml",
    ]));
});

describe("withEnabledRoles", () => {
  it("pins the roles", () =>
    expect(withEnabledRoles(config, "mainline").enabledRoles).toEqual(["mainline"]));
  it("pins several, in the order given", () =>
    expect(withEnabledRoles(config, "mainline,granite-chief").enabledRoles).toEqual([
      "mainline",
      "granite-chief",
    ]));
  it("leaves the config alone when unset", () =>
    expect(withEnabledRoles(config, undefined)).toBe(config));
  it("leaves the config alone when empty", () => expect(withEnabledRoles(config, "")).toBe(config));
  it("changes only the enabled roles", () =>
    expect(withEnabledRoles(config, "mainline")).toEqual({
      ...config,
      enabledRoles: ["mainline"],
    }));
  it("does not change the config it was given", () => {
    withEnabledRoles(config, "mainline");
    expect(config.enabledRoles).toEqual(["granite-chief", "mainline"]);
  });
  it("names the role it does not know", () =>
    expect(() => withEnabledRoles(config, "nope")).toThrow(/ENABLED_ROLES\[0\]/));
  it("names the position of the role it does not know", () =>
    expect(() => withEnabledRoles(config, "mainline,nope")).toThrow(/ENABLED_ROLES\[1\]/));
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
