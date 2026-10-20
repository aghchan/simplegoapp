import type { AgentEvent } from "../../shared/src/types.ts";

export interface Batcher {
  push(e: AgentEvent): void;
  // Delivers what is queued, retrying a batch that is waiting out its delay straight away. Rejects
  // when that takes longer than the close timeout; the queue is then abandoned.
  close(): Promise<void>;
}

const RETRY_CEILING_MS = 30_000;

// One batch is in flight at a time and the queue has no bound, so push never waits for Dispatch.
// A failed batch is retried until it goes through, ahead of everything pushed after it. `send`
// rejects with `permanent: true` on the error for a batch that must not be retried: it is dropped.
export function createBatcher(
  send: (b: AgentEvent[]) => Promise<void>,
  o: {
    intervalMs?: number;
    maxBatch?: number;
    retryDelaysMs?: number[];
    closeTimeoutMs?: number;
  } = {},
): Batcher {
  const intervalMs = o.intervalMs ?? 2000;
  const maxBatch = o.maxBatch ?? 50;
  const retryDelaysMs = o.retryDelaysMs ?? [1000, 2000, 5000, 10_000, 30_000];
  const closeTimeoutMs = o.closeTimeoutMs ?? 300_000;

  const queue: AgentEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draining: Promise<void> | undefined;
  let wakeSleeper: (() => void) | undefined;
  let abandoned = false;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const handle = setTimeout(() => {
        wakeSleeper = undefined;
        resolve();
      }, ms);
      wakeSleeper = () => {
        clearTimeout(handle);
        wakeSleeper = undefined;
        resolve();
      };
    });
  }

  async function deliver(batch: AgentEvent[]): Promise<void> {
    for (let attempt = 0; !abandoned; attempt++) {
      try {
        await send(batch);
        return;
      } catch (error) {
        if (isPermanent(error)) {
          console.error(`dropped ${batch.length} events: ${messageOf(error)}`);
          return;
        }
        const delay = retryDelaysMs[attempt] ?? RETRY_CEILING_MS;
        console.error(
          `sending ${batch.length} events failed, retrying in ${delay} ms: ${messageOf(error)}`,
        );
        await sleep(delay);
      }
    }
  }

  async function drain(): Promise<void> {
    try {
      while (queue.length > 0 && !abandoned) await deliver(queue.splice(0, maxBatch));
    } finally {
      draining = undefined;
    }
  }

  // Never starts a drain that would finish without awaiting: `draining` is cleared in drain's own
  // finally, which would then run before the assignment here.
  function start(): void {
    if (draining || abandoned || queue.length === 0) return;
    draining = drain();
  }

  async function flush(): Promise<void> {
    while (!abandoned && (queue.length > 0 || draining)) {
      start();
      await draining;
    }
  }

  return {
    push(event) {
      queue.push(event);
      if (queue.length >= maxBatch) {
        start();
      } else if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          start();
        }, intervalMs);
      }
    },

    async close() {
      clearTimeout(timer);
      timer = undefined;
      wakeSleeper?.();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<"expired">((resolve) => {
        deadline = setTimeout(() => resolve("expired"), closeTimeoutMs);
      });
      const outcome = await Promise.race([flush().then(() => "drained" as const), expired]);
      clearTimeout(deadline);
      if (outcome === "expired") {
        abandoned = true;
        wakeSleeper?.();
        throw new Error(`event queue not drained within ${closeTimeoutMs} ms`);
      }
    },
  };
}

function isPermanent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "permanent" in error && error.permanent === true
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
