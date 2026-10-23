import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSummary } from "../../shared/src/types.ts";
import * as api from "../src/api.ts";
import { lobbyUrl, mergeRuns, useRunsLive } from "../src/useRunsLive.ts";
import { FakeWebSocket } from "./fixtures.ts";

function summary(id: string, over: Partial<RunSummary> = {}): RunSummary {
  return {
    id,
    prNumber: 58,
    prTitle: "orders: add cancel endpoint",
    runName: "Red Dog Face",
    rating: "black",
    status: "on_the_hill",
    outcome: "pending",
    currentStep: "sweep",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const ids = (runs: RunSummary[]) => runs.map((run) => run.id);

describe("mergeRuns", () => {
  it("replaces a run by id and adds a new one", () => {
    const merged = mergeRuns(
      [summary("a"), summary("b")],
      [summary("b", { status: "stopped", updatedAt: 2 }), summary("c", { updatedAt: 3 })],
    );
    expect(merged).toHaveLength(3);
    expect(merged.find((run) => run.id === "b")?.status).toBe("stopped");
  });

  it("keeps the copy it holds when the incoming one is older", () => {
    const merged = mergeRuns([summary("a", { status: "stopped", updatedAt: 5 })], [summary("a")]);
    expect(merged).toEqual([summary("a", { status: "stopped", updatedAt: 5 })]);
  });

  it("takes an incoming copy as new as the one it holds", () => {
    const merged = mergeRuns([summary("a")], [summary("a", { status: "swept" })]);
    expect(merged[0]?.status).toBe("swept");
  });

  it("orders as the server lists: on the hill first, then newest", () => {
    const merged = mergeRuns(
      [summary("old-swept", { status: "swept", updatedAt: 10 })],
      [
        summary("old-hill", { updatedAt: 5 }),
        summary("new-swept", { status: "swept", updatedAt: 30 }),
        summary("new-hill", { updatedAt: 20 }),
      ],
    );
    expect(ids(merged)).toEqual(["new-hill", "old-hill", "new-swept", "old-swept"]);
  });

  it("keeps at most the server's 50", () => {
    const many = Array.from({ length: 52 }, (_, i) => summary(`r${i}`, { updatedAt: i }));
    const merged = mergeRuns([], many);
    expect(merged).toHaveLength(50);
    expect(merged[0]?.id).toBe("r51");
  });
});

describe("lobbyUrl", () => {
  it("uses ws on http and wss on https", () => {
    expect(lobbyUrl({ protocol: "http:", host: "localhost:8787" })).toBe(
      "ws://localhost:8787/api/live",
    );
    expect(lobbyUrl({ protocol: "https:", host: "b2b.example.dev" })).toBe(
      "wss://b2b.example.dev/api/live",
    );
  });
});

describe("useRunsLive", () => {
  const WebSocketImpl = FakeWebSocket as unknown as typeof WebSocket;
  const POLL_MS = 5000;
  let served: RunSummary[];
  const runsCalls = () => vi.mocked(fetch).mock.calls.length;
  const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  const showTab = (state: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    served = [summary("a")];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(served)),
    );
    vi.spyOn(api, "navigateTo").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "visibilityState");
  });

  function setup(on = true) {
    return renderHook(
      ({ live }) => {
        const [runs, setRuns] = useState<RunSummary[]>([summary("a")]);
        useRunsLive(live, setRuns, { WebSocketImpl, backoffMs: [10, 20] });
        return runs;
      },
      { initialProps: { live: on } },
    );
  }

  it("opens nothing until the list has loaded", () => {
    const { rerender } = setup(false);
    expect(FakeWebSocket.instances).toHaveLength(0);
    rerender({ live: true });
    expect(FakeWebSocket.last.url).toBe(`ws://${window.location.host}/api/live`);
  });

  it("applies each summary the lobby sends", () => {
    const { result } = setup();
    act(() => FakeWebSocket.last.open());
    act(() => FakeWebSocket.last.send({ type: "summary", run: summary("b", { updatedAt: 2 }) }));
    act(() =>
      FakeWebSocket.last.send({ type: "summary", run: summary("a", { status: "stopped" }) }),
    );
    expect(ids(result.current)).toEqual(["b", "a"]);
    expect(result.current[1]?.status).toBe("stopped");
  });

  it("ignores a frame that is not a summary", () => {
    const { result } = setup();
    act(() => FakeWebSocket.last.open());
    act(() => FakeWebSocket.last.sendRaw("not json"));
    act(() => FakeWebSocket.last.send({ type: "log", lines: [] }));
    expect(result.current).toEqual([summary("a")]);
  });

  it("refetches each time the socket opens", async () => {
    const { result } = setup();
    expect(runsCalls()).toBe(0);
    served = [summary("a"), summary("b", { updatedAt: 2 })];
    await act(async () => FakeWebSocket.last.open());
    expect(runsCalls()).toBe(1);
    expect(ids(result.current)).toEqual(["b", "a"]);
  });

  it("does not poll while the socket is up", async () => {
    setup();
    await act(async () => FakeWebSocket.last.open());
    await tick(POLL_MS * 3);
    expect(runsCalls()).toBe(1);
  });

  it("polls while the socket is down, then refetches once it reconnects and stops polling", async () => {
    const { result } = setup();
    await act(async () => FakeWebSocket.last.open());
    act(() => FakeWebSocket.last.close());
    served = [summary("a"), summary("b", { updatedAt: 2 })];
    await tick(POLL_MS);
    expect(runsCalls()).toBe(2);
    expect(ids(result.current)).toEqual(["b", "a"]);
    await tick(POLL_MS);
    expect(runsCalls()).toBe(3);

    // The retry made at 10 ms has been connecting all along.
    expect(FakeWebSocket.instances).toHaveLength(2);
    await act(async () => FakeWebSocket.last.open());
    expect(runsCalls()).toBe(4);
    await tick(POLL_MS * 3);
    expect(runsCalls()).toBe(4);
  });

  it("keeps the poll's cadence while reconnect attempts fail", async () => {
    setup();
    act(() => FakeWebSocket.last.close());
    await tick(10);
    act(() => FakeWebSocket.last.close());
    await tick(20);
    act(() => FakeWebSocket.last.close());
    await tick(POLL_MS - 31);
    expect(runsCalls()).toBe(0);
    await tick(1);
    expect(runsCalls()).toBe(1);
  });

  it("does not poll while the tab is hidden, and refetches at once when it is shown", async () => {
    setup();
    act(() => FakeWebSocket.last.close());
    showTab("hidden");
    await tick(POLL_MS * 3);
    expect(runsCalls()).toBe(0);
    showTab("visible");
    await tick(0);
    expect(runsCalls()).toBe(1);
    await tick(POLL_MS);
    expect(runsCalls()).toBe(2);
  });

  it("ignores the tab's visibility while the socket is up", async () => {
    setup();
    await act(async () => FakeWebSocket.last.open());
    showTab("hidden");
    showTab("visible");
    await tick(POLL_MS * 2);
    expect(runsCalls()).toBe(1);
  });

  it("sends a viewer whose session ended to sign in", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      Response.json({ error: "signed out" }, { status: 401 }),
    );
    setup();
    await act(async () => FakeWebSocket.last.open());
    expect(api.navigateTo).toHaveBeenCalledWith("/auth/login");
  });

  it("closes the socket and stops polling on unmount", async () => {
    const { unmount } = setup();
    act(() => FakeWebSocket.last.close());
    await tick(10);
    unmount();
    expect(FakeWebSocket.last.closed).toBe(true);
    await tick(POLL_MS * 3);
    showTab("visible");
    await tick(0);
    expect(runsCalls()).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
