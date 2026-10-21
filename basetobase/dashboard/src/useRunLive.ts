import { useEffect, useRef, useState } from "react";
import type { LiveMessage, LogLine, RunSnapshot } from "../../shared/src/types.ts";

const LOG_CAP = 2000;
const BACKOFF_MS = [1000, 2000, 5000, 10000];

export type Connection = "connecting" | "live" | "reconnecting";

export interface RunLive {
  run: RunSnapshot | null;
  log: LogLine[];
  connection: Connection;
}

// Live messages can overlap a snapshot or arrive out of order, so lines are told apart by id.
export function mergeLog(a: LogLine[], b: LogLine[], cap = LOG_CAP): LogLine[] {
  const byId = new Map<number, LogLine>();
  for (const line of [...a, ...b]) byId.set(line.id, line);
  const lines = [...byId.values()].sort((x, y) => x.id - y.id);
  return lines.slice(Math.max(0, lines.length - cap));
}

export function liveUrl(
  runId: string,
  where: Pick<Location, "protocol" | "host"> = window.location,
): string {
  return `${where.protocol === "https:" ? "wss" : "ws"}://${where.host}/api/runs/${runId}/live`;
}

function parse(data: unknown): LiveMessage | undefined {
  if (typeof data !== "string") return undefined;
  try {
    return JSON.parse(data) as LiveMessage;
  } catch {
    return undefined;
  }
}

// `initial` is what the page already holds when the socket is opened. The options are read once:
// they are a seam for tests, not something to change while the page is open.
export function useRunLive(
  runId: string,
  o: {
    WebSocketImpl?: typeof WebSocket;
    backoffMs?: number[];
    initial?: { run: RunSnapshot; log: LogLine[] };
  } = {},
): RunLive {
  const options = useRef(o).current;
  const [run, setRun] = useState<RunSnapshot | null>(options.initial?.run ?? null);
  const [log, setLog] = useState<LogLine[]>(() => mergeLog([], options.initial?.log ?? []));
  const [connection, setConnection] = useState<Connection>("connecting");

  useEffect(() => {
    const { WebSocketImpl = WebSocket, backoffMs = BACKOFF_MS } = options;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;

    const apply = (message: LiveMessage) => {
      if (message.type === "snapshot") {
        setRun(message.run);
        setLog((current) => mergeLog(current, message.log));
      } else if (message.type === "log") {
        setLog((current) => mergeLog(current, message.lines));
      } else if (message.type === "run") {
        setRun(message.run);
      }
    };

    const connect = () => {
      const current = new WebSocketImpl(liveUrl(runId));
      socket = current;
      current.onopen = () => {
        failures = 0;
        setConnection("live");
      };
      current.onmessage = (event) => {
        const message = parse(event.data);
        if (message) apply(message);
      };
      current.onclose = () => {
        if (stopped) return;
        setConnection("reconnecting");
        const delay = backoffMs[Math.min(failures, backoffMs.length - 1)] ?? 0;
        failures += 1;
        timer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [runId, options]);

  return { run, log, connection };
}
