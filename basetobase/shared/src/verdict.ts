import type { RoleId } from "./config.ts";
import type { Hazard, Verdict } from "./types.ts";

export class VerdictError extends Error {}

const TITLE_MAX = 120;
const DETAIL_MAX = 4000;
const SUMMARY_MAX = 1000;

// Messages name the field and the rule, never the submitted value: agent output is untrusted and
// these messages are passed on.
function fail(path: string, problem: string): never {
  throw new VerdictError(`${path} ${problem}`);
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

function asBoundedString(value: unknown, path: string, max: number): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length === 0 || value.length > max) fail(path, `must be 1 to ${max} characters`);
  return value;
}

function isHazardId(id: string, prefix: string): boolean {
  const head = `${prefix}-`;
  return id.startsWith(head) && /^\d+$/.test(id.slice(head.length));
}

function asHazard(value: unknown, path: string, prefix: string): Hazard {
  const fields = asObject(value, path);
  const id = fields.id;
  if (typeof id !== "string" || !isHazardId(id, prefix)) {
    fail(`${path}.id`, `must match ${prefix}-<number>`);
  }
  return {
    id,
    title: asBoundedString(fields.title, `${path}.title`, TITLE_MAX),
    detail: asBoundedString(fields.detail, `${path}.detail`, DETAIL_MAX),
  };
}

export function parseVerdict(
  raw: unknown,
  expect: { role: RoleId; prefix: string; headSha: string },
): Verdict {
  const fields = asObject(raw, "verdict");
  if (fields.role !== expect.role) fail("role", `must be ${expect.role}`);
  if (fields.headSha !== expect.headSha) fail("headSha", `must be ${expect.headSha}`);
  const status = fields.status;
  if (status !== "clear" && status !== "hazards") fail("status", "must be clear or hazards");
  const hazards = asArray(fields.hazards, "hazards").map((hazard, index) =>
    asHazard(hazard, `hazards[${index}]`, expect.prefix),
  );
  if (status === "clear" && hazards.length > 0) {
    fail("hazards", "must be empty when status is clear");
  }
  if (status === "hazards" && hazards.length === 0) {
    fail("hazards", "must list at least one hazard when status is hazards");
  }
  return {
    role: expect.role,
    headSha: expect.headSha,
    status,
    hazards,
    summary: asBoundedString(fields.summary, "summary", SUMMARY_MAX),
  };
}
