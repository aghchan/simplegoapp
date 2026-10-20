import { describe, expect, it } from "vitest";
import { parseVerdict, VerdictError } from "../src/verdict.ts";

const exp = { role: "mainline", prefix: "FUN", headSha: "abc" } as const;
const ok = { role: "mainline", headSha: "abc", status: "clear", hazards: [], summary: "Works." };
const hazard = { id: "FUN-1", title: "500 on repeat cancel", detail: "POST twice → 500" };
const raised = { ...ok, status: "hazards", hazards: [hazard] };

function rejection(raw: unknown): unknown {
  try {
    parseVerdict(raw, exp);
  } catch (error) {
    return error;
  }
  throw new Error("parseVerdict accepted the verdict");
}

function expectRejected(raw: unknown, field: RegExp) {
  const error = rejection(raw);
  expect(error).toBeInstanceOf(VerdictError);
  expect(error).toHaveProperty("message", expect.stringMatching(field));
}

const withHazard = (patch: object) => ({ ...raised, hazards: [{ ...hazard, ...patch }] });

describe("parseVerdict", () => {
  it("accepts clear", () => expect(parseVerdict(ok, exp).status).toBe("clear"));
  it("accepts hazards", () => expect(parseVerdict(raised, exp).hazards).toHaveLength(1));
  it("rejects other head", () => expectRejected({ ...ok, headSha: "zzz" }, /headSha/));
  it("rejects a missing head", () => expectRejected({ ...ok, headSha: undefined }, /headSha/));
  it("rejects clear with hazards", () => {
    const hazards = [{ id: "FUN-1", title: "t", detail: "d" }];
    expectRejected({ ...ok, hazards }, /clear/);
  });
  it("rejects hazards status with none", () =>
    expectRejected({ ...ok, status: "hazards" }, /hazards/));
  it("rejects wrong prefix", () => {
    const hazards = [{ id: "SEC-1", title: "t", detail: "d" }];
    expectRejected({ ...ok, status: "hazards", hazards }, /FUN-/);
  });
  it("rejects empty summary", () => expectRejected({ ...ok, summary: "" }, /summary/));

  it.each([
    ["another role", "kt-22"],
    ["a missing role", undefined],
    ["a non-string role", 7],
  ])("rejects %s", (_label, role) => expectRejected({ ...ok, role }, /role/));

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "clear"],
    ["JSON text", JSON.stringify(ok)],
    ["a number", 42],
    ["an array", [ok]],
  ])("rejects %s instead of an object", (_label, raw) => expectRejected(raw, /verdict/));

  it.each(["maybe", "CLEAR", "", 1, null, undefined])("rejects status %j", (status) =>
    expectRejected({ ...ok, status }, /status/),
  );

  it.each([5, null, undefined, ["Works."]])("rejects summary %j", (summary) =>
    expectRejected({ ...ok, summary }, /summary/),
  );

  it.each([
    ["a string", "none"],
    ["an object", {}],
    ["null", null],
    ["missing", undefined],
  ])("rejects hazards that are %s", (_label, hazards) =>
    expectRejected({ ...ok, hazards }, /hazards/),
  );

  it.each([null, "FUN-1", 7, []])("rejects a hazard that is %j", (entry) =>
    expectRejected({ ...raised, hazards: [entry] }, /hazards\[0\]/),
  );

  it.each(["id", "title", "detail"])("rejects a hazard %s that is not a string", (field) =>
    expectRejected(withHazard({ [field]: 7 }), new RegExp(`hazards\\[0\\]\\.${field}`)),
  );

  it.each(["id", "title", "detail"])("rejects a hazard with no %s", (field) =>
    expectRejected(withHazard({ [field]: undefined }), new RegExp(`hazards\\[0\\]\\.${field}`)),
  );

  it("names the position of the failing hazard", () => {
    const hazards = [hazard, { ...hazard, id: "FUN-2", title: "" }];
    expectRejected({ ...raised, hazards }, /hazards\[1\]\.title/);
  });

  it.each(["FUN-0", "FUN-7", "FUN-123"])("accepts hazard id %s", (id) =>
    expect(parseVerdict(withHazard({ id }), exp).hazards).toHaveLength(1),
  );

  it.each([
    "FUN-",
    "FUN-x",
    "FUN-1a",
    "FUN--1",
    "FUN_1",
    "fun-1",
    "XFUN-1",
    " FUN-1",
    "FUN-1 ",
    "FUN-1\n",
    "FUN-１",
  ])("rejects hazard id %j", (id) => expectRejected(withHazard({ id }), /hazards\[0\]\.id.*FUN-/));

  describe("length limits", () => {
    const text = (length: number) => "x".repeat(length);
    const hazardLimits = [
      ["title", 120],
      ["detail", 4000],
    ] as const;

    it.each(hazardLimits)("accepts a %s of exactly %d characters", (field, max) =>
      expect(parseVerdict(withHazard({ [field]: text(max) }), exp).hazards).toHaveLength(1),
    );
    it.each(hazardLimits)("rejects a %s over %d characters", (field, max) =>
      expectRejected(
        withHazard({ [field]: text(max + 1) }),
        new RegExp(`hazards\\[0\\]\\.${field}`),
      ),
    );
    it.each(["title", "detail"])("rejects an empty hazard %s", (field) =>
      expectRejected(withHazard({ [field]: "" }), new RegExp(`hazards\\[0\\]\\.${field}`)),
    );
    it("accepts a summary of exactly 1000 characters", () =>
      expect(parseVerdict({ ...ok, summary: text(1000) }, exp).summary).toHaveLength(1000));
    it("rejects a summary over 1000 characters", () =>
      expectRejected({ ...ok, summary: text(1001) }, /summary/));
  });

  it("returns a fresh object holding only the known fields", () => {
    const input = {
      ...raised,
      notes: "not part of a verdict",
      hazards: [{ ...hazard, severity: "high" }],
    };
    const parsed = parseVerdict(input, exp);
    expect(parsed).toStrictEqual({
      role: "mainline",
      headSha: "abc",
      status: "hazards",
      hazards: [hazard],
      summary: "Works.",
    });
    expect(parsed).not.toBe(input);
    expect(parsed.hazards[0]).not.toBe(input.hazards[0]);
  });

  it("keeps submitted text out of error messages", () => {
    const submitted = "SUBMITTED-TEXT";
    for (const raw of [{ ...ok, status: submitted }, withHazard({ id: submitted })]) {
      expect(rejection(raw)).toHaveProperty("message", expect.not.stringContaining(submitted));
    }
  });
});
