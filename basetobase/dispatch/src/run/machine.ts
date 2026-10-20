import {
  rosterEntry,
  type B2BConfig,
  type Panel,
  type RoleId,
} from "../../../shared/src/config.ts";
import { RATING_LABELS, STEP_ORDER } from "../../../shared/src/labels.ts";
import type { Triage } from "../../../shared/src/triage.ts";
import type {
  AgentBrief,
  AgentSnapshot,
  RunSnapshot,
  StepId,
  StepSnapshot,
  Verdict,
} from "../../../shared/src/types.ts";
import type { PullRequestRef } from "../github/webhook.ts";

export const STALL_MS = 600_000;
export const AGENT_TIMEOUT_MS = 1_800_000;

export interface RunState extends RunSnapshot {
  installationId: number;
  defaultBranch: string;
  baseSha: string;
  nonces: Record<string, string>;
  // Agents whose stall has been logged. A repeat stall flips the card but is not logged again.
  stalledLogged: string[];
}

export type Effect =
  | { type: "dispatch"; agentId: string }
  | { type: "log"; text: string }
  | { type: "index" }
  | { type: "broadcast" };

export interface Transition {
  state: RunState;
  effects: Effect[];
}

interface Deadlines {
  // Null once the agent has stalled: that condition is applied and must not be scheduled again.
  stallAt: number | null;
  timeoutAt: number;
}

export function createRun(
  pr: PullRequestRef,
  runId: string,
  t: Triage,
  cfg: B2BConfig,
  now: number,
  nonce: () => string,
): Transition {
  const body = pr.body.trim();
  const goal = body === "" ? pr.title : `${pr.title}\n\n${body}`;
  const agents = cfg.roster
    .filter(
      (entry) =>
        cfg.enabledRoles.includes(entry.id) &&
        entry.panels.some((panel) => t.panels.includes(panel)),
    )
    .map(
      (entry): AgentSnapshot => ({
        id: agentIdFor(entry.id, "sweep", 0),
        role: entry.id,
        step: "sweep",
        round: 0,
        status: "queued",
        hasTranscript: false,
        hazards: [],
      }),
    );
  const nonces: Record<string, string> = {};
  for (const agent of agents) nonces[agent.id] = nonce();

  let state: RunState = {
    id: runId,
    repo: pr.repo,
    prNumber: pr.number,
    prTitle: pr.title,
    prUrl: pr.url,
    branch: pr.branch,
    headSha: pr.headSha,
    panels: t.panels,
    rating: t.rating,
    runName: t.runName,
    goal,
    status: "on_the_hill",
    steps: STEP_ORDER.map((id): StepSnapshot => ({ id, status: "pending", notes: [] })),
    agents,
    createdAt: now,
    updatedAt: now,
    installationId: pr.installationId,
    defaultBranch: pr.defaultBranch,
    baseSha: pr.baseSha,
    nonces,
    stalledLogged: [],
  };
  state = patchStep(state, "lift_line", { status: "done", startedAt: now, finishedAt: now });
  state = patchStep(state, "trail_map", {
    status: "done",
    startedAt: now,
    finishedAt: now,
    notes: [panelNote(t.panels), ratingNote(t), `Goal: ${goal.split("\n", 1)[0] ?? ""}`],
  });
  state = patchStep(state, "sweep", { status: "active", startedAt: now });
  // With no agent to wait for, the sweep is over before it starts.
  state = sweptState(state, now) ?? state;

  return {
    state,
    effects: [
      { type: "log", text: `run created · ${t.runName}` },
      ...agents.map((agent): Effect => ({ type: "dispatch", agentId: agent.id })),
      { type: "index" },
      { type: "broadcast" },
    ],
  };
}

export function onDispatched(s: RunState, agentId: string, now: number): Transition {
  const agent = liveAgent(s, agentId);
  // Events can beat the dispatch call's own response; the agent has moved on by then.
  if (agent?.status !== "queued") return unchanged(s);
  return broadcast(patchAgent(s, agentId, { status: "dispatched", dispatchedAt: now }, now));
}

export function onEvents(
  s: RunState,
  agentId: string,
  count: number,
  now: number,
  jobUrl: string,
): Transition {
  const agent = liveAgent(s, agentId);
  // A batch that added nothing new is a retried duplicate; it must not push the stall clock back.
  if (!agent || count < 1) return unchanged(s);
  const patch: Partial<AgentSnapshot> = {
    status: "running",
    lastEventAt: now,
    // The watchdog clocks run from dispatch, so an agent that skipped onDispatched needs one.
    dispatchedAt: agent.dispatchedAt ?? now,
  };
  if (!agent.jobUrl && jobUrl) patch.jobUrl = jobUrl;
  return broadcast(patchAgent(s, agentId, patch, now));
}

export function onVerdict(s: RunState, agentId: string, v: Verdict, now: number): Transition {
  if (!liveAgent(s, agentId)) return unchanged(s);
  const reported = patchAgent(
    s,
    agentId,
    { status: v.status, summary: v.summary, hazards: v.hazards, finishedAt: now },
    now,
  );
  return closeSweepIfDone(reported, now);
}

export function onFailure(s: RunState, agentId: string, reason: string, now: number): Transition {
  if (!liveAgent(s, agentId)) return unchanged(s);
  return closeSweepIfDone(failed(s, agentId, reason, now), now);
}

// Unlike the other handlers this ignores the run's and the agent's status: runners upload their
// transcript after a stop or a timeout, which is when the owner most wants it. It takes no clock,
// so updatedAt stays put.
export function onTranscript(s: RunState, agentId: string): Transition {
  const agent = s.agents.find((candidate) => candidate.id === agentId);
  if (!agent || agent.hasTranscript) return unchanged(s);
  const agents = s.agents.map((a) => (a.id === agentId ? { ...a, hasTranscript: true } : a));
  return broadcast({ ...s, agents });
}

export function onTick(s: RunState, now: number): Transition {
  if (s.status !== "on_the_hill") return unchanged(s);
  let next = s;
  const logs: Effect[] = [];
  for (const agent of s.agents) {
    const due = deadlinesOf(agent);
    if (!due) continue;
    if (now >= due.timeoutAt) {
      next = failed(next, agent.id, "timed out", now);
    } else if (due.stallAt !== null && now >= due.stallAt) {
      next = patchAgent(next, agent.id, { status: "stalled" }, now);
      if (!next.stalledLogged.includes(agent.id)) {
        next = { ...next, stalledLogged: [...next.stalledLogged, agent.id] };
        const silence = `${STALL_MS / 60_000}m`;
        logs.push({ type: "log", text: `${agent.id} stalled · no events for ${silence}` });
      }
    }
  }
  if (next === s) return unchanged(s);
  const settled = closeSweepIfDone(next, now);
  return { state: settled.state, effects: [...logs, ...settled.effects] };
}

// Agents keep their last status: AgentStatus has no stopped, and their jobs are still running.
export function stopRun(s: RunState, reason: string, now: number): Transition {
  if (s.status !== "on_the_hill") return unchanged(s);
  const steps = s.steps.map(
    (step): StepSnapshot =>
      step.status === "active" ? { ...step, status: "stopped", finishedAt: now } : step,
  );
  return {
    state: { ...s, status: "stopped", steps, updatedAt: now },
    effects: [
      { type: "log", text: `stopped · ${reason}` },
      { type: "index" },
      { type: "broadcast" },
    ],
  };
}

// The earliest moment onTick has something to do, so an alarm set for it always makes progress.
export function nextAlarm(s: RunState): number | null {
  if (s.status !== "on_the_hill") return null;
  const times = s.agents.flatMap((agent) => {
    const due = deadlinesOf(agent);
    if (!due) return [];
    return due.stallAt === null ? [due.timeoutAt] : [due.stallAt, due.timeoutAt];
  });
  return times.length === 0 ? null : Math.min(...times);
}

export function snapshotOf(s: RunState): RunSnapshot {
  // Listed field by field so a private field added to RunState can never reach a dashboard socket.
  return {
    id: s.id,
    repo: s.repo,
    prNumber: s.prNumber,
    prTitle: s.prTitle,
    prUrl: s.prUrl,
    branch: s.branch,
    headSha: s.headSha,
    panels: s.panels,
    rating: s.rating,
    runName: s.runName,
    goal: s.goal,
    status: s.status,
    steps: s.steps,
    agents: s.agents,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function briefOf(s: RunState, agentId: string, cfg: B2BConfig): AgentBrief {
  const agent = s.agents.find((candidate) => candidate.id === agentId);
  if (!agent) throw new Error(`run ${s.id} has no agent ${agentId}`);
  const entry = rosterEntry(cfg, agent.role);
  return {
    role: entry.id,
    name: entry.name,
    model: entry.model,
    prefix: entry.prefix,
    goal: s.goal,
    prNumber: s.prNumber,
    baseSha: s.baseSha,
    headSha: s.headSha,
  };
}

function agentIdFor(role: RoleId, step: StepId, round: number): string {
  return `${role}-${step}-${round}`;
}

function isTerminal(agent: AgentSnapshot): boolean {
  return agent.status === "clear" || agent.status === "hazards" || agent.status === "error";
}

// The agent, if the run is still on the hill and the agent has not yet reported.
function liveAgent(s: RunState, id: string): AgentSnapshot | undefined {
  if (s.status !== "on_the_hill") return undefined;
  const agent = s.agents.find((candidate) => candidate.id === id);
  return agent && !isTerminal(agent) ? agent : undefined;
}

function deadlinesOf(agent: AgentSnapshot): Deadlines | null {
  if (agent.dispatchedAt === undefined || isTerminal(agent)) return null;
  const silentSince = agent.lastEventAt ?? agent.dispatchedAt;
  return {
    stallAt: agent.status === "stalled" ? null : silentSince + STALL_MS,
    timeoutAt: agent.dispatchedAt + AGENT_TIMEOUT_MS,
  };
}

function unchanged(s: RunState): Transition {
  return { state: s, effects: [] };
}

function broadcast(state: RunState): Transition {
  return { state, effects: [{ type: "broadcast" }] };
}

function patchAgent(
  s: RunState,
  id: string,
  patch: Partial<AgentSnapshot>,
  now: number,
): RunState {
  const agents = s.agents.map((agent) => (agent.id === id ? { ...agent, ...patch } : agent));
  return { ...s, agents, updatedAt: now };
}

function patchStep(s: RunState, id: StepId, patch: Partial<StepSnapshot>): RunState {
  return { ...s, steps: s.steps.map((step) => (step.id === id ? { ...step, ...patch } : step)) };
}

function failed(s: RunState, id: string, reason: string, now: number): RunState {
  return patchAgent(s, id, { status: "error", summary: reason, finishedAt: now }, now);
}

// The run with its sweep closed, or undefined while any sweep agent has yet to report.
function sweptState(s: RunState, now: number): RunState | undefined {
  if (!s.agents.every((agent) => agent.step !== "sweep" || isTerminal(agent))) return undefined;
  const sweepDone = patchStep(s, "sweep", { status: "done", finishedAt: now });
  return { ...sweepDone, status: "swept", updatedAt: now };
}

function closeSweepIfDone(s: RunState, now: number): Transition {
  const swept = sweptState(s, now);
  if (!swept) return broadcast(s);
  const sweeps = swept.agents.filter((agent) => agent.step === "sweep");
  const hazards = sweeps.reduce((total, agent) => total + agent.hazards.length, 0);
  return {
    state: swept,
    effects: [
      { type: "log", text: `all ${sweeps.length} sweeps in · ${hazards} hazards` },
      { type: "index" },
      { type: "broadcast" },
    ],
  };
}

function panelNote(panels: Panel[]): string {
  const backend = panels.includes("backend");
  const frontend = panels.includes("frontend");
  if (backend && frontend) return "Backend and frontend run.";
  if (backend) return "Backend run.";
  if (frontend) return "Frontend run.";
  return "No panels selected.";
}

function ratingNote(t: Triage): string {
  const change = `+${t.additions} −${t.deletions} across ${t.files} files`;
  return `Rated ${RATING_LABELS[t.rating]}: ${change} → ${t.runName}.`;
}
