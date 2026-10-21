import shippedConfig from "../../config/basetobase.json" with { type: "json" };

const PANELS = ["backend", "frontend"] as const;
const ROLE_IDS = [
  "granite-chief",
  "gold-coast",
  "summit-six",
  "kt-22",
  "mainline",
  "corduroy",
  "magic-carpet",
  "bluebird",
  "groomer",
] as const;
const MODELS = ["sonnet", "opus"] as const;

export type Panel = (typeof PANELS)[number];
export type Rating = "green" | "blue" | "black" | "double_black";
export type RoleId = (typeof ROLE_IDS)[number];

export interface RosterEntry {
  id: RoleId;
  name: string;
  role: string;
  prefix: string;
  panels: Panel[];
  model: (typeof MODELS)[number];
}

export interface B2BConfig {
  frontendGlobs: string[];
  riskGlobs: string[];
  infraGlobs: string[];
  // A PR touching any of these is not patrolled at all.
  unpatrolledGlobs: string[];
  thresholds: {
    greenLines: number;
    greenFiles: number;
    blueLines: number;
    doubleBlackLines: number;
    doubleBlackTopDirs: number;
  };
  trailNames: Record<Rating, string[]>;
  roster: RosterEntry[];
  enabledRoles: RoleId[];
}

export function loadConfig(raw: unknown): B2BConfig {
  const root = asObject(raw, "config");
  const roster = asArray(root.roster, "roster").map((entry, index) =>
    asRosterEntry(entry, `roster[${index}]`),
  );
  const rosterIds = roster.map((entry) => entry.id);
  return {
    frontendGlobs: asStringArray(root.frontendGlobs, "frontendGlobs"),
    riskGlobs: asStringArray(root.riskGlobs, "riskGlobs"),
    infraGlobs: asStringArray(root.infraGlobs, "infraGlobs"),
    unpatrolledGlobs: asStringArray(root.unpatrolledGlobs, "unpatrolledGlobs"),
    thresholds: asThresholds(root.thresholds),
    trailNames: asTrailNames(root.trailNames),
    roster,
    enabledRoles: asArray(root.enabledRoles, "enabledRoles").map((role, index) =>
      oneOf(role, rosterIds, `enabledRoles[${index}]`),
    ),
  };
}

export const config: B2BConfig = loadConfig(shippedConfig);

export function rosterEntry(cfg: B2BConfig, id: RoleId): RosterEntry {
  const entry = cfg.roster.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`roster has no entry for ${id}`);
  return entry;
}

function fail(path: string, problem: string): never {
  throw new Error(`invalid config: ${path} ${problem}`);
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "must be a string");
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  return value;
}

function asStringArray(value: unknown, path: string): string[] {
  return asArray(value, path).map((item, index) => asString(item, `${path}[${index}]`));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) fail(path, `must be one of ${allowed.join(", ")}`);
  return match;
}

function asThresholds(value: unknown): B2BConfig["thresholds"] {
  const fields = asObject(value, "thresholds");
  const threshold = (name: string) => asNumber(fields[name], `thresholds.${name}`);
  return {
    greenLines: threshold("greenLines"),
    greenFiles: threshold("greenFiles"),
    blueLines: threshold("blueLines"),
    doubleBlackLines: threshold("doubleBlackLines"),
    doubleBlackTopDirs: threshold("doubleBlackTopDirs"),
  };
}

function asTrailNames(value: unknown): B2BConfig["trailNames"] {
  const lists = asObject(value, "trailNames");
  const trailList = (rating: Rating) => {
    const path = `trailNames.${rating}`;
    const names = asStringArray(lists[rating], path);
    if (names.length === 0) fail(path, "must not be empty");
    return names;
  };
  return {
    green: trailList("green"),
    blue: trailList("blue"),
    black: trailList("black"),
    double_black: trailList("double_black"),
  };
}

function asRosterEntry(value: unknown, path: string): RosterEntry {
  const entry = asObject(value, path);
  return {
    id: oneOf(entry.id, ROLE_IDS, `${path}.id`),
    name: asString(entry.name, `${path}.name`),
    role: asString(entry.role, `${path}.role`),
    prefix: asString(entry.prefix, `${path}.prefix`),
    panels: asArray(entry.panels, `${path}.panels`).map((panel, index) =>
      oneOf(panel, PANELS, `${path}.panels[${index}]`),
    ),
    model: oneOf(entry.model, MODELS, `${path}.model`),
  };
}
