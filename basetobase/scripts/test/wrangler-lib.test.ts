import { describe, expect, it } from "vitest";
import { isAuthFailure } from "../src/wrangler-lib.ts";

describe("isAuthFailure", () => {
  it("spots an expired or rejected login", () => {
    expect(
      isAuthFailure(
        "The given account is not valid or is not authorized to access this service [code: 7403]",
      ),
    ).toBe(true);
    expect(isAuthFailure("You are not authenticated. Please run `wrangler login`.")).toBe(true);
    expect(isAuthFailure("Authentication error [code: 10000]")).toBe(true);
  });

  it("leaves other failures alone", () => {
    expect(isAuthFailure("✘ [ERROR] No migrations folder found.")).toBe(false);
    expect(isAuthFailure("Build failed with 1 error")).toBe(false);
  });
});
