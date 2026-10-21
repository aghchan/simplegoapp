import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogLine, RunSnapshot } from "../../shared/src/types.ts";
import { liveUrl, mergeLog, useRunLive } from "../src/useRunLive.ts";
import { FakeWebSocket, line, makeRun, START } from "./fixtures.ts";

const ids = (lines: { id: number }[]) => lines.map((l) => l.id);
const run = makeRun();

describe("mergeLog", () => {
  it("dedupes and orders", () => {
    expect(ids(mergeLog([line(1), line(3)], [line(2), line(3)]))).toEqual([1, 2, 3]);
  });

  it("orders lines that arrive out of order", () => {
    expect(ids(mergeLog([line(5), line(2)], [line(4), line(1), line(3)]))).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the last lines up to the cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => line(i + 1));
    expect(ids(mergeLog(many, [], 4))).toEqual([7, 8, 9, 10]);
  });

  it("caps at 2000 lines by default", () => {
    const many = Array.from({ length: 2005 }, (_, i) => line(i + 1));
    const merged = mergeLog(many, []);
    expect(merged).toHaveLength(2000);
    expect(merged[0]?.id).toBe(6);
  });
});

describe("liveUrl", () => {
  it("uses ws on http and wss on https", () => {
    expect(liveUrl("r1", { protocol: "http:", host: "localhost:8787" })).toBe(
      "ws://localhost:8787/api/runs/r1/live",
    );
    expect(liveUrl("r1", { protocol: "https:", host: "b2b.example.dev" })).toBe(
      "wss://b2b.example.dev/api/runs/r1/live",
    );
  });
});

describe("useRunLive", () => {
  const WebSocketImpl = FakeWebSocket as unknown as typeof WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(backoffMs = [10], initial?: { run: RunSnapshot; log: LogLine[] }) {
    return renderHook(() => useRunLive("r1", { WebSocketImpl, backoffMs, initial }));
  }

  it("applies snapshot then log, reconnects with fresh snapshot", async () => {
    const { result } = setup();
    expect(result.current.connection).toBe("connecting");
    act(() => FakeWebSocket.last.open());
    act(() => FakeWebSocket.last.send({ type: "snapshot", run, log: [line(1)] }));
    act(() => FakeWebSocket.last.send({ type: "log", lines: [line(2), line(1)] }));
    expect(ids(result.current.log)).toEqual([1, 2]);
    expect(result.current.run).toEqual(run);
    expect(result.current.connection).toBe("live");

    act(() => FakeWebSocket.last.close());
    expect(result.current.connection).toBe("reconnecting");
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.last.url).toMatch(/\/api\/runs\/r1\/live$/);

    const later = makeRun({ updatedAt: START + 60_000 });
    act(() => FakeWebSocket.last.open());
    act(() => FakeWebSocket.last.send({ type: "snapshot", run: later, log: [line(2), line(3)] }));
    expect(result.current.run).toEqual(later);
    expect(ids(result.current.log)).toEqual([1, 2, 3]);
    expect(result.current.connection).toBe("live");
  });

  it("opens the socket on the page's own host", () => {
    setup();
    expect(FakeWebSocket.last.url).toBe(`ws://${window.location.host}/api/runs/r1/live`);
  });

  it("merges overlapping and out-of-order lines by id", () => {
    const { result } = setup();
    act(() => FakeWebSocket.last.open());
    act(() => FakeWebSocket.last.send({ type: "snapshot", run, log: [line(3), line(4)] }));
    act(() => FakeWebSocket.last.send({ type: "log", lines: [line(6), line(5)] }));
    act(() => FakeWebSocket.last.send({ type: "log", lines: [line(1), line(2), line(4)] }));
    expect(ids(result.current.log)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("replaces the run on a run message", () => {
    const { result } = setup();
    act(() => FakeWebSocket.last.open());
    act(() => FakeWebSocket.last.send({ type: "snapshot", run, log: [] }));
    const done = makeRun({ status: "swept" });
    act(() => FakeWebSocket.last.send({ type: "run", run: done }));
    expect(result.current.run?.status).toBe("swept");
  });

  it("starts from the initial run and log, and merges the snapshot into them", () => {
    const { result } = setup([10], { run, log: [line(2), line(1)] });
    expect(result.current.run).toEqual(run);
    expect(ids(result.current.log)).toEqual([1, 2]);
    expect(result.current.connection).toBe("connecting");
    act(() => FakeWebSocket.last.open());
    act(() => FakeWebSocket.last.send({ type: "snapshot", run, log: [line(2), line(3)] }));
    expect(ids(result.current.log)).toEqual([1, 2, 3]);
  });

  it("has nothing to show before the first message", () => {
    const { result } = setup();
    expect(result.current.run).toBeNull();
    expect(result.current.log).toEqual([]);
  });

  it("backs off while connecting keeps failing, and starts over once it opens", async () => {
    setup([10, 20, 50]);
    act(() => FakeWebSocket.last.close());
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(FakeWebSocket.instances).toHaveLength(2);

    act(() => FakeWebSocket.last.close());
    await act(() => vi.advanceTimersByTimeAsync(19));
    expect(FakeWebSocket.instances).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(FakeWebSocket.instances).toHaveLength(3);

    act(() => FakeWebSocket.last.open());
    act(() => FakeWebSocket.last.close());
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("keeps the longest delay once the list runs out", async () => {
    setup([10, 20]);
    for (let attempt = 0; attempt < 3; attempt++) {
      act(() => FakeWebSocket.last.close());
      await act(() => vi.advanceTimersByTimeAsync(attempt === 0 ? 10 : 20));
    }
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("ignores a frame that is not JSON", () => {
    const { result } = setup();
    act(() => FakeWebSocket.last.open());
    act(() => FakeWebSocket.last.send({ type: "snapshot", run, log: [line(1)] }));
    act(() => FakeWebSocket.last.sendRaw("not json"));
    expect(ids(result.current.log)).toEqual([1]);
  });

  it("closes the socket on unmount and does not reconnect", async () => {
    const { unmount } = setup();
    const socket = FakeWebSocket.last;
    unmount();
    expect(socket.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("does not reconnect after unmount while waiting to", async () => {
    const { unmount } = setup();
    act(() => FakeWebSocket.last.close());
    unmount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
