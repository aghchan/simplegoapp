import { describe, expect, it } from "vitest";
import { formatDuration } from "../src/format.ts";

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [39_000, "39s"],
    [872_000, "14m 32s"],
    [3_720_000, "1h 02m"],
  ])("%d ms → %s", (ms, text) => expect(formatDuration(ms)).toBe(text));

  it.each([
    [59_999, "59s"],
    [60_000, "1m 00s"],
    [3_599_999, "59m 59s"],
    [3_600_000, "1h 00m"],
    [360_000_000, "100h 00m"],
  ])("switches unit at the edge: %d ms → %s", (ms, text) => expect(formatDuration(ms)).toBe(text));

  it.each([
    [999, "0s"],
    [1_999.9, "1s"],
    [3_659_999, "1h 00m"],
  ])("floors instead of rounding: %d ms → %s", (ms, text) => expect(formatDuration(ms)).toBe(text));

  it.each([
    [-1, "0s"],
    [-5_000, "0s"],
    [-3_720_000, "0s"],
  ])("treats negative %d ms as zero → %s", (ms, text) => expect(formatDuration(ms)).toBe(text));
});
