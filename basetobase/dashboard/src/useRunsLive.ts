import { useEffect, useRef } from "react";
import type { LobbyMessage, RunSummary } from "../../shared/src/types.ts";
import { getJson, navigateTo, SIGN_IN_URL, SignedOutError } from "./api.ts";

const POLL_MS = 5000;
const BACKOFF_MS = [1000, 2000, 5000, 10000];
// listRuns' default limit.
const LIST_MAX = 50;

export function lobbyUrl(where: Pick<Location, "protocol" | "host"> = window.location): string {
  return `${where.protocol === "https:" ? "wss" : "ws"}://${where.host}/api/live`;
}

// Socket frames and fetches can cross, so a copy older than the one held is dropped. Ordered and
// capped as listRuns lists them.
export function mergeRuns(current: RunSummary[], incoming: RunSummary[]): RunSummary[] {
  const byId = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) {
    const held = byId.get(run.id);
    if (!held || held.updatedAt <= run.updatedAt) byId.set(run.id, run);
  }
  const onHill = (run: RunSummary) => (run.status === "on_the_hill" ? 1 : 0);
  return [...byId.values()]
    .sort((a, b) => onHill(b) - onHill(a) || b.updatedAt - a.updatedAt)
    .slice(0, LIST_MAX);
}

function parse(data: unknown): LobbyMessage | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const message = JSON.parse(data) as LobbyMessage;
    return message.type === "summary" ? message : undefined;
  } catch {
    return undefined;
  }
}

// Keeps the loaded list current over the lobby socket. While the socket is down, polls /api/runs
// every 5 s while the tab is visible. Every open refetches: frames sent while it was down are lost.
// The options are read once: they are a seam for tests.
export function useRunsLive(
  on: boolean,
  update: (change: (runs: RunSummary[]) => RunSummary[]) => void,
  o: { WebSocketImpl?: typeof WebSocket; backoffMs?: number[] } = {},
): void {
  const options = useRef(o).current;

  useEffect(() => {
    if (!on) return;
    const { WebSocketImpl = WebSocket, backoffMs = BACKOFF_MS } = options;
    let stopped = false;
    let up = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let socket: WebSocket | undefined;

    const refresh = () => {
      getJson<RunSummary[]>("/api/runs").then(
        (runs) => {
          if (!stopped) update((current) => mergeRuns(current, runs));
        },
        (error: unknown) => {
          if (!stopped && error instanceof SignedOutError) navigateTo(SIGN_IN_URL);
        },
      );
    };
    const stopPolling = () => {
      clearInterval(poll);
      poll = undefined;
    };
    const startPolling = () => {
      if (poll === undefined && document.visibilityState === "visible") {
        poll = setInterval(refresh, POLL_MS);
      }
    };
    const onVisibility = () => {
      if (up) return;
      stopPolling();
      if (document.visibilityState !== "visible") return;
      refresh();
      startPolling();
    };

    const connect = () => {
      const current = new WebSocketImpl(lobbyUrl());
      socket = current;
      current.onopen = () => {
        up = true;
        failures = 0;
        stopPolling();
        refresh();
      };
      current.onmessage = (event) => {
        const message = parse(event.data);
        if (message) update((runs) => mergeRuns(runs, [message.run]));
      };
      current.onclose = () => {
        if (stopped) return;
        up = false;
        startPolling();
        const delay = backoffMs[Math.min(failures, backoffMs.length - 1)] ?? 0;
        failures += 1;
        retry = setTimeout(connect, delay);
      };
    };

    connect();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearTimeout(retry);
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibility);
      socket?.close();
    };
  }, [on, update, options]);
}
