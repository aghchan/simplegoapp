import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwedDesign } from "../../shared/src/types.ts";
import * as api from "../src/api.ts";
import { useOwedDesigns } from "../src/useOwedDesigns.ts";

function owed(prNumber: number): OwedDesign {
  return {
    repo: "aghchan/simplegoapp",
    prNumber,
    prTitle: `PR ${prNumber}`,
    runId: `r${prNumber}`,
    bypassedAt: 5,
  };
}

describe("useOwedDesigns", () => {
  beforeEach(() => {
    vi.spyOn(api, "navigateTo").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("holds nothing until the list arrives, then the list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([owed(58)])));
    const { result } = renderHook(() => useOwedDesigns(1));
    expect(result.current).toEqual([]);
    await waitFor(() => expect(result.current).toEqual([owed(58)]));
    expect(fetch).toHaveBeenCalledWith("/api/owed-designs");
  });

  it("fetches again whenever the key changes, and only then", async () => {
    const answers = [[owed(58)], [owed(58), owed(61)]];
    const fetchMock = vi.fn(async () => Response.json(answers.shift() ?? []));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(({ key }) => useOwedDesigns(key), {
      initialProps: { key: 1 },
    });
    await waitFor(() => expect(result.current).toHaveLength(1));
    rerender({ key: 1 });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender({ key: 2 });
    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drops a slower answer that an older key asked for", async () => {
    const pending: ((owedList: OwedDesign[]) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            pending.push((list) => resolve(Response.json(list)));
          }),
      ),
    );
    const { result, rerender } = renderHook(({ key }) => useOwedDesigns(key), {
      initialProps: { key: 1 },
    });
    rerender({ key: 2 });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[1]!([owed(61)]));
    await waitFor(() => expect(result.current).toEqual([owed(61)]));
    await act(async () => pending[0]!([owed(58)]));
    expect(result.current).toEqual([owed(61)]);
  });

  it("keeps the last list when a refresh fails", async () => {
    const answers = [() => Response.json([owed(58)]), () => new Response(null, { status: 500 })];
    const fetchMock = vi.fn(async () => answers.shift()?.() ?? Response.json([]));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(({ key }) => useOwedDesigns(key), {
      initialProps: { key: 1 },
    });
    await waitFor(() => expect(result.current).toEqual([owed(58)]));
    rerender({ key: 2 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(result.current).toEqual([owed(58)]);
    expect(api.navigateTo).not.toHaveBeenCalled();
  });

  it("sends a signed-out owner to sign in", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    renderHook(() => useOwedDesigns(1));
    await waitFor(() => expect(api.navigateTo).toHaveBeenCalledWith("/auth/login"));
  });
});
