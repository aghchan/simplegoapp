import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../shared/src/types.ts";
import { createBatcher } from "../src/batcher.ts";

const ev = (seq: number): AgentEvent => ({ seq, ts: 1, kind: "say", text: `e${seq}` });
const permanent = (message: string) => Object.assign(new Error(message), { permanent: true });

let logged: string[];

beforeEach(() => {
  vi.useFakeTimers();
  logged = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => void logged.push(line));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createBatcher", () => {
  it("splits at maxBatch", async () => {
    const sent: AgentEvent[][] = [];
    const b = createBatcher(async (batch) => void sent.push(batch));
    for (let i = 0; i < 120; i++) b.push(ev(i));
    await b.close();
    expect(sent.map((x) => x.length)).toEqual([50, 50, 20]);
  });

  it("flushes on interval", async () => {
    const sent: AgentEvent[][] = [];
    const b = createBatcher(async (batch) => void sent.push(batch));
    b.push(ev(0));
    b.push(ev(1));
    b.push(ev(2));
    await vi.advanceTimersByTimeAsync(1999);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([[ev(0), ev(1), ev(2)]]);
  });

  it("flushes a full batch without waiting for the interval", async () => {
    const sent: AgentEvent[][] = [];
    const b = createBatcher(async (batch) => void sent.push(batch));
    for (let i = 0; i < 50; i++) b.push(ev(i));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((x) => x.length)).toEqual([50]);
    await b.close();
  });

  it("retries a failed batch and preserves order", async () => {
    const sent: AgentEvent[][] = [];
    let failures = 2;
    const b = createBatcher(async (batch) => {
      if (failures-- > 0) throw new Error("503");
      sent.push(batch);
    });
    b.push(ev(0));
    b.push(ev(1));
    await vi.advanceTimersByTimeAsync(5000);
    b.push(ev(2));
    await b.close();
    expect(sent.flat().map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("keeps events pushed during a retry behind the failed batch", async () => {
    const sent: number[][] = [];
    let failures = 1;
    const b = createBatcher(async (batch) => {
      if (failures-- > 0) throw new Error("503");
      sent.push(batch.map((e) => e.seq));
    });
    b.push(ev(0));
    await vi.advanceTimersByTimeAsync(2000);
    b.push(ev(1));
    b.push(ev(2));
    await b.close();
    expect(sent).toEqual([[0], [1, 2]]);
  });

  it("close retries a batch that is waiting out its delay straight away", async () => {
    const sent: number[] = [];
    let failures = 1;
    const b = createBatcher(async (batch) => {
      if (failures-- > 0) throw new Error("503");
      sent.push(batch.length);
    });
    b.push(ev(0));
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual([]);
    await b.close();
    expect(sent).toEqual([1]);
  });

  it("waits 1, 2, 5, 10 and 30 s between attempts, then 30 s again", async () => {
    const attempts: number[] = [];
    const b = createBatcher(async () => {
      attempts.push(Date.now());
      throw new Error("503");
    });
    b.push(ev(0));
    await vi.advanceTimersByTimeAsync(2000 + 1000 + 2000 + 5000 + 10_000 + 30_000 + 30_000);
    expect(attempts.map((at, i) => at - (attempts[i - 1] ?? 0)).slice(1)).toEqual([
      1000, 2000, 5000, 10_000, 30_000, 30_000,
    ]);
    expect(logged[0]).toBe("sending 1 events failed, retrying in 1000 ms: 503");
    void b.close().catch(() => {});
    await vi.advanceTimersByTimeAsync(300_000);
  });

  it("sends one batch at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const b = createBatcher(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 100));
      inFlight--;
    });
    for (let i = 0; i < 120; i++) b.push(ev(i));
    const closed = b.close();
    await vi.advanceTimersByTimeAsync(1000);
    await closed;
    expect(most).toBe(1);
  });

  it("push never blocks while sending", () => {
    const b = createBatcher(() => new Promise(() => {}));
    expect(() => {
      for (let i = 0; i < 500; i++) b.push(ev(i));
    }).not.toThrow();
  });

  it("drops a permanently rejected batch with one stderr line and carries on", async () => {
    const sent: number[][] = [];
    const calls: number[][] = [];
    const b = createBatcher(async (batch) => {
      calls.push(batch.map((e) => e.seq));
      if (batch[0]?.seq === 0) throw permanent("POST /agent/events → 400: bad event");
      sent.push(batch.map((e) => e.seq));
    });
    b.push(ev(0));
    await vi.advanceTimersByTimeAsync(2000);
    b.push(ev(1));
    await b.close();
    expect(calls).toEqual([[0], [1]]);
    expect(sent).toEqual([[1]]);
    expect(logged).toEqual(["dropped 1 events: POST /agent/events → 400: bad event"]);
  });

  it("stops retrying once close gives up", async () => {
    const calls: number[] = [];
    const b = createBatcher(
      async () => {
        calls.push(Date.now());
        throw new Error("503");
      },
      { closeTimeoutMs: 10_000 },
    );
    b.push(ev(0));
    const closed = b.close();
    const settled = expect(closed).rejects.toThrow("event queue not drained within 10000 ms");
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    const attemptsAtGiveUp = calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(attemptsAtGiveUp);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up on a send that never returns once close times out", async () => {
    const b = createBatcher(() => new Promise(() => {}), { closeTimeoutMs: 300_000 });
    b.push(ev(0));
    const settled = expect(b.close()).rejects.toThrow(/not drained within 300000 ms/);
    await vi.advanceTimersByTimeAsync(299_999);
    let early = false;
    void settled.then(() => (early = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(early).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
  });

  it("sends nothing after close", async () => {
    const sent: AgentEvent[][] = [];
    const b = createBatcher(async (batch) => void sent.push(batch));
    b.push(ev(0));
    await b.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([[ev(0)]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes immediately when nothing was pushed", async () => {
    const send = vi.fn(async () => {});
    await createBatcher(send).close();
    expect(send).not.toHaveBeenCalled();
  });
});
