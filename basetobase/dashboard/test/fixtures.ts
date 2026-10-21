import type { RoleId } from "../../shared/src/config.ts";
import type {
  AgentSnapshot,
  LogLine,
  RunSnapshot,
  StepId,
  StepSnapshot,
  StepStatus,
} from "../../shared/src/types.ts";

export const START = Date.parse("2026-10-20T13:52:00Z");

export const JOB_URL = "https://github.com/aghchan/simplegoapp/actions/runs/9/job/2";

export function step(
  id: StepId,
  status: StepStatus,
  over: Partial<StepSnapshot> = {},
): StepSnapshot {
  return { id, status, notes: [], ...over };
}

export function agent(role: RoleId, over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: `${role}-sweep-0`,
    role,
    step: "sweep",
    round: 0,
    status: "running",
    hasTranscript: false,
    hazards: [],
    ...over,
  };
}

// The sweep began at START: three patrollers, one with a transcript.
export function makeRun(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: "r1",
    repo: "aghchan/simplegoapp",
    prNumber: 58,
    prTitle: "orders: add cancel endpoint",
    prUrl: "https://github.com/aghchan/simplegoapp/pull/58",
    branch: "claude/orders-cancel",
    headSha: "a91f3c2e0b7d4c1f8a6e5d3b2c1a0f9e8d7c6b5a",
    panels: ["backend"],
    rating: "black",
    runName: "Red Dog Face",
    goal: "Let a customer cancel their own pending order.",
    status: "on_the_hill",
    steps: [
      step("lift_line", "done", { startedAt: START - 80_000, finishedAt: START - 41_000 }),
      step("trail_map", "done", {
        startedAt: START - 41_000,
        finishedAt: START,
        notes: [
          "7 files changed and none are frontend, so this is a backend run.",
          "Rated black diamond: +214 -12 across 7 files.",
        ],
      }),
      step("sweep", "active", { startedAt: START }),
      step("huddle", "pending"),
      step("summit", "pending"),
      step("drop_in", "pending"),
      step("send_it", "pending"),
    ],
    agents: [
      agent("mainline", {
        status: "running",
        jobUrl: JOB_URL,
        hasTranscript: true,
        summary: "Running 18 end-to-end requests",
      }),
      agent("granite-chief", { status: "clear", summary: "The change fits the goal" }),
      agent("kt-22", { status: "hazards", summary: "Cancel never checks the owner" }),
    ],
    createdAt: START - 80_000,
    updatedAt: START,
    ...over,
  };
}

export function line(
  id: number,
  agentId: string | null = null,
  over: Partial<LogLine> = {},
): LogLine {
  return { id, agentId, ts: START + id * 1000, kind: "say", text: `line ${id}`, ...over };
}

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  static get last(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("no socket was opened");
    return socket;
  }

  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.onopen?.();
  }

  send(message: unknown): void {
    this.sendRaw(JSON.stringify(message));
  }

  sendRaw(data: string): void {
    this.onmessage?.({ data });
  }

  // Dropped by the server, or closed by the page: either way `onclose` follows.
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}
