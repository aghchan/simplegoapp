import type { Panel, Rating, RoleId } from "./config.ts";

export type StepId =
  | "lift_line"
  | "trail_map"
  | "sweep"
  | "huddle"
  | "summit"
  | "drop_in"
  | "send_it";
// "skipped": the run went past the step without doing it (a step not built yet, before landing).
export type StepStatus = "pending" | "active" | "done" | "stopped" | "skipped";
// "landed": GitHub merged the PR on the run's head. Until M4 deploys, that is the end of the line.
export type RunStatus = "on_the_hill" | "swept" | "landed" | "stopped" | "failed";
export type AgentStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "stalled"
  | "clear"
  | "hazards"
  | "error"
  | "stopped";
// What the review came to; only "clear" passes. "pending": the sweep is not done, and for a
// stopped run never will be. "none": no patroller covered the change.
export type ReviewOutcome = "pending" | "none" | "clear" | "hazards" | "failed";
export type EventKind = "system" | "say" | "tool" | "tool_result" | "done" | "error";

export interface AgentEvent {
  seq: number;
  ts: number;
  kind: EventKind;
  text: string;
}

export interface LogLine {
  id: number;
  agentId: string | null;
  ts: number;
  kind: EventKind;
  text: string;
}

export interface Hazard {
  id: string;
  title: string;
  detail: string;
}

export interface Verdict {
  role: RoleId;
  headSha: string;
  status: "clear" | "hazards";
  hazards: Hazard[];
  summary: string;
}

export interface AgentSnapshot {
  id: string;
  role: RoleId;
  step: StepId;
  round: number;
  status: AgentStatus;
  dispatchedAt?: number;
  // The job's first call to Dispatch: GitHub has started it. The stall and timeout clocks run from it.
  briefedAt?: number;
  lastEventAt?: number;
  finishedAt?: number;
  jobUrl?: string;
  hasTranscript: boolean;
  summary?: string;
  hazards: Hazard[];
}

export interface StepSnapshot {
  id: StepId;
  status: StepStatus;
  startedAt?: number;
  finishedAt?: number;
  notes: string[];
  // The sweep step's only.
  outcome?: ReviewOutcome;
}

export interface RunSnapshot {
  id: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  branch: string;
  headSha: string;
  panels: Panel[];
  rating: Rating;
  runName: string;
  goal: string;
  status: RunStatus;
  outcome: ReviewOutcome;
  // The merge commit, once the run has landed.
  mergeSha?: string;
  steps: StepSnapshot[];
  agents: AgentSnapshot[];
  createdAt: number;
  updatedAt: number;
}

export interface RunSummary {
  id: string;
  prNumber: number;
  prTitle: string;
  runName: string;
  rating: Rating;
  status: RunStatus;
  outcome: ReviewOutcome;
  currentStep: StepId;
  createdAt: number;
  updatedAt: number;
}

export interface AgentBrief {
  role: RoleId;
  name: string;
  model: "sonnet" | "opus";
  prefix: string;
  goal: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
}

export type LiveMessage =
  | { type: "snapshot"; run: RunSnapshot; log: LogLine[] }
  | { type: "log"; lines: LogLine[] }
  | { type: "run"; run: RunSnapshot };

// The runs list's socket: one frame each time a run's index row is written.
export type LobbyMessage = { type: "summary"; run: RunSummary };
