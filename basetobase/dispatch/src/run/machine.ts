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
import type { CheckRunBody } from "../github/client.ts";
import type { PullRequestRef } from "../github/webhook.ts";

export const STALL_MS = 600_000;
export const AGENT_TIMEOUT_MS = 1_800_000;
// Branch protection on main requires a check of this name.
export const CHECK_NAME = "Base to Base";
// GitHub refuses a summary over 65 535 characters.
const CHECK_SUMMARY_MAX = 60_000;

export interface RunState extends RunSnapshot {
  installationId: number;
  defaultBranch: string;
  baseSha: string;
  nonces: Record<string, string>;
  // Each agent's roster name when the run started, for the Conditions report.
  agentNames: Record<string, string>;
  // Agents whose stall has been logged. A repeat stall flips the card but is not logged again.
  stalledLogged: string[];
  // The run's check run on the PR head, once GitHub has created it.
  checkRunId?: number;
}

// "check" mirrors the run's current state onto its check run. It comes last, so GitHub never
// holds up the run's own work or the dashboard.
export type Effect =
  | { type: "dispatch"; agentId: string }
  | { type: "log"; text: string }
  | { type: "index" }
  | { type: "broadcast" }
  | { type: "check" };

export interface Transition {
  state: RunState;
  effects: Effect[];
}

interface Deadline {
  at: number;
  // Fails the agent with this reason. Without one, reaching `at` only marks the agent stalled.
  failure?: string;
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
  const agentNames = Object.fromEntries(
    agents.map((agent) => [agent.id, rosterEntry(cfg, agent.role).name]),
  );

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
    agentNames,
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
      // Ahead of the dispatches: a close that arrives during them finds the run only in the index.
      { type: "index" },
      ...agents.map((agent): Effect => ({ type: "dispatch", agentId: agent.id })),
      { type: "broadcast" },
      { type: "check" },
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
  const failure = failed(s, agentId, reason, now);
  return closeSweepIfDone(failure.state, now, failure.effects);
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
    const due = deadlinesOf(agent, s.createdAt).find((deadline) => now >= deadline.at);
    if (!due) continue;
    const change =
      due.failure === undefined
        ? stalled(next, agent.id, now)
        : failed(next, agent.id, due.failure, now);
    next = change.state;
    logs.push(...change.effects);
  }
  if (next === s) return unchanged(s);
  return closeSweepIfDone(next, now, logs);
}

// Jobs are not cancelled through GitHub: a running agent stops on the 410 its next report gets,
// and a queued one is refused its brief.
export function stopRun(s: RunState, reason: string, now: number): Transition {
  if (s.status !== "on_the_hill") return unchanged(s);
  const stopped = `stopped · ${reason}`;
  const steps = s.steps.map(
    (step): StepSnapshot =>
      step.status === "active" ? { ...step, status: "stopped", finishedAt: now } : step,
  );
  const agents = s.agents.map((agent): AgentSnapshot => {
    if (isTerminal(agent)) return agent;
    return { ...agent, status: "stopped", summary: stopped, finishedAt: now };
  });
  return {
    state: { ...s, status: "stopped", steps, agents, updatedAt: now },
    effects: [
      { type: "log", text: stopped },
      { type: "index" },
      { type: "broadcast" },
      { type: "check" },
    ],
  };
}

// Takes no clock: storing the id changes nothing a viewer sees.
export function onCheckCreated(s: RunState, id: number): Transition {
  if (s.checkRunId !== undefined) return unchanged(s);
  return { state: { ...s, checkRunId: id }, effects: [] };
}

// The check run for the run's current state, without the commit (creating it adds head_sha).
export function checkRunOf(s: RunState, publicUrl: string): CheckRunBody {
  const details = `${publicUrl}/runs/${s.id}`;
  const base = { name: CHECK_NAME, details_url: details };
  const output = (title: string) => ({ title, summary: checkSummary(s, details) });
  if (s.status === "on_the_hill") {
    return { ...base, status: "in_progress", output: output(`${s.runName} · patrol sweep`) };
  }
  if (s.status === "stopped") {
    return { ...base, status: "completed", conclusion: "cancelled", output: output("Stopped") };
  }
  const failure = failureTitle(s);
  if (failure !== undefined) {
    return { ...base, status: "completed", conclusion: "failure", output: output(failure) };
  }
  return { ...base, status: "completed", conclusion: "success", output: output("All clear") };
}

// The earliest moment onTick has something to do, so an alarm set for it always makes progress.
export function nextAlarm(s: RunState): number | null {
  if (s.status !== "on_the_hill") return null;
  const times = s.agents.flatMap((agent) => deadlinesOf(agent, s.createdAt).map((d) => d.at));
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
  const { status } = agent;
  return status === "clear" || status === "hazards" || status === "error" || status === "stopped";
}

// The agent, if the run is still on the hill and the agent has not yet reported.
function liveAgent(s: RunState, id: string): AgentSnapshot | undefined {
  if (s.status !== "on_the_hill") return undefined;
  const agent = s.agents.find((candidate) => candidate.id === id);
  return agent && !isTerminal(agent) ? agent : undefined;
}

// When onTick must act on the agent, most severe first.
function deadlinesOf(agent: AgentSnapshot, createdAt: number): Deadline[] {
  if (isTerminal(agent)) return [];
  // A lost dispatch result (the Durable Object can reset mid-call) would leave it queued forever.
  if (agent.dispatchedAt === undefined) {
    return [{ at: createdAt + STALL_MS, failure: "never dispatched" }];
  }
  const timeout = { at: agent.dispatchedAt + AGENT_TIMEOUT_MS, failure: "timed out" };
  // A stall already applied must not be scheduled again, or its alarm would re-fire forever.
  if (agent.status === "stalled") return [timeout];
  return [timeout, { at: (agent.lastEventAt ?? agent.dispatchedAt) + STALL_MS }];
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

function failed(s: RunState, id: string, reason: string, now: number): Transition {
  return {
    state: patchAgent(s, id, { status: "error", summary: reason, finishedAt: now }, now),
    effects: [{ type: "log", text: `${id} failed · ${reason}` }],
  };
}

function stalled(s: RunState, id: string, now: number): Transition {
  const state = patchAgent(s, id, { status: "stalled" }, now);
  if (s.stalledLogged.includes(id)) return { state, effects: [] };
  return {
    state: { ...state, stalledLogged: [...s.stalledLogged, id] },
    effects: [{ type: "log", text: `${id} stalled · no events for ${STALL_MS / 60_000}m` }],
  };
}

// The run with its sweep closed, or undefined while any sweep agent has yet to report.
function sweptState(s: RunState, now: number): RunState | undefined {
  if (!s.agents.every((agent) => agent.step !== "sweep" || isTerminal(agent))) return undefined;
  const notes = conditionsReport(s);
  const sweepDone = patchStep(s, "sweep", { status: "done", finishedAt: now, notes });
  return { ...sweepDone, status: "swept", updatedAt: now };
}

// A tally of the sweep, then each patroller's summary, which for a failed one is the reason.
function conditionsReport(s: RunState): string[] {
  const sweeps = s.agents.filter((agent) => agent.step === "sweep");
  // In with a verdict or a failure; a stopped agent never came in.
  const reported = sweeps.filter((agent) => isTerminal(agent) && agent.status !== "stopped").length;
  const hazards = sweeps.reduce((total, agent) => total + agent.hazards.length, 0);
  const failed = sweeps.filter((agent) => agent.status === "error").length;
  const tally =
    `${reported} of ${counted(sweeps.length, "patroller")} in · ` +
    `${counted(hazards, "hazard")} · ${failed} failed`;
  const summaries = sweeps.flatMap((agent) =>
    agent.summary ? [`${nameOf(s, agent)}: ${agent.summary}`] : [],
  );
  return [tally, ...summaries];
}

function nameOf(s: RunState, agent: AgentSnapshot): string {
  return s.agentNames[agent.id] ?? agent.role;
}

// Why an ended run fails its check, or undefined when it passes. Hazards are named before a failed
// agent: they are what the author has to answer.
function failureTitle(s: RunState): string | undefined {
  const hazards = s.agents.reduce((total, agent) => total + agent.hazards.length, 0);
  if (hazards > 0) return `${counted(hazards, "hazard")} flagged`;
  // An agent that never reported found no hazards; its silence must not pass the check.
  const failed = s.agents.find((agent) => agent.status === "error" || agent.status === "stopped");
  if (failed) return `${nameOf(s, failed)} failed: ${failed.summary ?? failed.status}`;
  return s.status === "failed" ? "Run failed" : undefined;
}

// The Conditions report, each hazard, and the dashboard link, which a cut never drops.
function checkSummary(s: RunState, details: string): string {
  const hazards = s.agents.flatMap((agent) =>
    agent.hazards.map((hazard) => `**${hazard.id}** ${hazard.title} — ${nameOf(s, agent)}`),
  );
  const link = `[Open ${s.runName} on the dashboard](${details})`;
  const body = [...conditionsReport(s), ...hazards].join("\n\n");
  const room = CHECK_SUMMARY_MAX - link.length - 2;
  const kept = body.length > room ? `${body.slice(0, room - 1)}…` : body;
  return `${kept}\n\n${link}`;
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// `earned` are the effects the caller's own change produced; they come first.
function closeSweepIfDone(s: RunState, now: number, earned: Effect[] = []): Transition {
  const swept = sweptState(s, now);
  if (!swept) return { state: s, effects: [...earned, { type: "broadcast" }] };
  const sweeps = swept.agents.filter((agent) => agent.step === "sweep");
  const hazards = sweeps.reduce((total, agent) => total + agent.hazards.length, 0);
  // A sweep with errors must not read as clean: an agent that never reported found no hazards.
  const errors = sweeps.filter((agent) => agent.status === "error").length;
  const failures = errors > 0 ? ` · ${errors} failed` : "";
  return {
    state: swept,
    effects: [
      ...earned,
      { type: "log", text: `all ${sweeps.length} sweeps in · ${hazards} hazards${failures}` },
      { type: "index" },
      { type: "broadcast" },
      { type: "check" },
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
