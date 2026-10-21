import type { Rating } from "./config.ts";
import type { AgentStatus, RunStatus, StepId } from "./types.ts";

export const STEP_ORDER: StepId[] = [
  "lift_line",
  "trail_map",
  "sweep",
  "huddle",
  "summit",
  "drop_in",
  "send_it",
];

export const STEP_LABELS: Record<StepId, { themed: string; plain: string; milestone?: string }> = {
  lift_line: { themed: "Lift line", plain: "PR opened" },
  trail_map: { themed: "Trail map", plain: "Triage" },
  sweep: { themed: "Patrol sweep", plain: "Independent review", milestone: "Swept" },
  huddle: { themed: "Patrol huddle", plain: "Quorum", milestone: "All clear" },
  summit: { themed: "Summit check", plain: "Final verify", milestone: "Summit" },
  drop_in: { themed: "Drop in", plain: "Merge" },
  send_it: { themed: "Send it", plain: "Deploy", milestone: "Open" },
};

export const RATING_LABELS: Record<Rating, string> = {
  green: "Green circle",
  blue: "Blue square",
  black: "Black diamond",
  double_black: "Double black diamond",
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  on_the_hill: "On the hill",
  swept: "Swept · huddle arrives in M3",
  stopped: "Stopped",
  failed: "Needs you",
};

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  queued: "Queued",
  dispatched: "Dispatched",
  running: "Running",
  stalled: "Stalled",
  clear: "All clear",
  hazards: "Hazards flagged",
  error: "Failed",
  stopped: "Stopped",
};
