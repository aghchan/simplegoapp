import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { parseRoute, useRoute, type Route } from "../src/router.ts";

describe("parseRoute", () => {
  it.each<[string, Route]>([
    ["/", { page: "runs" }],
    ["/runs/abc", { page: "run", runId: "abc" }],
    ["/runs/abc/", { page: "run", runId: "abc" }],
    ["/runs", { page: "notFound" }],
    ["/runs/a/b", { page: "notFound" }],
    ["/x", { page: "notFound" }],
  ])("parseRoute %s", (pathname, route) => {
    expect(parseRoute(pathname)).toEqual(route);
  });
});

describe("useRoute", () => {
  beforeEach(() => window.history.replaceState(null, "", "/"));

  it("starts at the current path", () => {
    window.history.replaceState(null, "", "/runs/abc");
    const { result } = renderHook(() => useRoute());
    expect(result.current[0]).toEqual({ page: "run", runId: "abc" });
  });

  it("pushes history when navigating", () => {
    const { result } = renderHook(() => useRoute());
    act(() => result.current[1]("/runs/r1"));
    expect(result.current[0]).toEqual({ page: "run", runId: "r1" });
    expect(window.location.pathname).toBe("/runs/r1");
  });

  it("follows the back button", () => {
    const { result } = renderHook(() => useRoute());
    act(() => result.current[1]("/runs/r1"));
    act(() => {
      window.history.replaceState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current[0]).toEqual({ page: "runs" });
  });
});
