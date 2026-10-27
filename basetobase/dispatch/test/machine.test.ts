import { afterEach, describe, expect, it, vi } from "vitest";
import {
  config as shippedConfig,
  rosterEntry,
  withEnabledRoles,
  type B2BConfig,
  type RoleId,
} from "../../shared/src/config.ts";
import { RATING_LABELS, STEP_ORDER } from "../../shared/src/labels.ts";
import type { Triage } from "../../shared/src/triage.ts";
import type {
  AgentSnapshot,
  ReviewOutcome,
  RunStatus,
  StepId,
  StepSnapshot,
  Verdict,
} from "../../shared/src/types.ts";
import {
  AGENT_TIMEOUT_MS,
  JOB_START_MS,
  STALL_MS,
  briefOf,
  checkRunOf,
  createRun,
  landRun,
  nextAlarm,
  askCheckRepost,
  onBriefed,
  onCheckCreated,
  onCheckReposted,
  onDispatched,
  onEvents,
  onFailure,
  onRetitled,
  onTick,
  onTranscript,
  onVerdict,
  replacedCheckOf,
  retryableAgents,
  retryAgents,
  reviewOutcome,
  snapshotOf,
  stopRun,
  wantsCheck,
  type Effect,
  type RunState,
  type Transition,
} from "../src/run/machine.ts";
import { prRef } from "./helpers.ts";

// One agent on a run whatever the shipped config enables, as the dispatch vitest binding pins for
// the Durable Object.
const config = withEnabledRoles(shippedConfig, "mainline");
const pr = prRef();
const t: Triage = {
  panels: ["backend"],
  rating: "black",
  runName: "Red Dog Face",
  files: 7,
  additions: 214,
  deletions: 12,
};
const ID = "mainline-sweep-0";
const GRANITE = "granite-chief-sweep-0";
const GOLD = "gold-coast-sweep-0";
const SUMMIT = "summit-six-sweep-0";
const KT = "kt-22-sweep-0";
const URL_1 = "https://github.com/aghchan/simplegoapp/actions/runs/1";
const URL_2 = "https://github.com/aghchan/simplegoapp/actions/runs/2";
const CREATED_AT = 1000;
const DISPATCHED_AT = 1200;
const KT_DISPATCHED_AT = 1300;
const BRIEFED_AT = 1400;
const KT_BRIEFED_AT = 1450;
const JOB = { githubRunId: "1", jobUrl: URL_1 };
const KT_JOB = { githubRunId: "2", jobUrl: URL_2 };
const MERGE_SHA = "abc1234def5678";

// Two patrollers on the backend panel, listed out of roster order on purpose.
const PATROL: B2BConfig = { ...config, enabledRoles: ["kt-22", "granite-chief"] };
// Five on the backend panel, enough to leave every kind of agent status in one run.
const SQUAD: B2BConfig = {
  ...config,
  enabledRoles: ["granite-chief", "gold-coast", "summit-six", "kt-22", "mainline"],
};

const stepOf = (s: RunState, id: StepId): StepSnapshot => {
  const found = s.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
};
const agentOf = (s: RunState, id: string = ID): AgentSnapshot => {
  const found = s.agents.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no agent ${id}`);
  return found;
};
const effectTypes = (effects: Effect[]) => effects.map((effect) => effect.type);

function counter(): () => string {
  let count = 0;
  return () => `n${++count}`;
}

function verdictFor(role: RoleId, hazardCount = 0): Verdict {
  const { prefix } = rosterEntry(config, role);
  return {
    role,
    headSha: "head58",
    status: hazardCount === 0 ? "clear" : "hazards",
    hazards: Array.from({ length: hazardCount }, (_, index) => ({
      id: `${prefix}-${index + 1}`,
      title: `Hazard ${index + 1}`,
      detail: `Detail of hazard ${index + 1}`,
    })),
    summary: hazardCount === 0 ? "Nothing found." : `${hazardCount} found.`,
  };
}
const clearVerdict = verdictFor("mainline");
const hazardVerdict = verdictFor("mainline", 2);

const created = (): Transition => createRun(pr, "r1", t, config, CREATED_AT, () => "n1");
const dispatchedRun = (): RunState => onDispatched(created().state, ID, DISPATCHED_AT).state;
// The job has started on GitHub and asked for its brief.
const briefedRun = (): RunState => onBriefed(dispatchedRun(), ID, BRIEFED_AT, JOB).state;
const runningRun = (): RunState => onEvents(briefedRun(), ID, 3, 1500, URL_1).state;
const stalledRun = (): RunState => onTick(briefedRun(), BRIEFED_AT + STALL_MS).state;
const timedOutRun = (): RunState => onTick(briefedRun(), BRIEFED_AT + AGENT_TIMEOUT_MS).state;
const landedRun = (): RunState => landRun(sweptBy("clear", "clear"), MERGE_SHA, 3000).state;

// Granite Chief dispatched at DISPATCHED_AT, KT-22 at KT_DISPATCHED_AT, neither heard from.
function patrolRun(): RunState {
  const s = createRun(pr, "r1", t, PATROL, CREATED_AT, counter()).state;
  return onDispatched(onDispatched(s, GRANITE, DISPATCHED_AT).state, KT, KT_DISPATCHED_AT).state;
}

// The patrol run once Granite Chief's job is briefed at BRIEFED_AT and KT-22's at KT_BRIEFED_AT.
function briefedPatrol(): RunState {
  const s = onBriefed(patrolRun(), GRANITE, BRIEFED_AT, JOB).state;
  return onBriefed(s, KT, KT_BRIEFED_AT, KT_JOB).state;
}

// Granite Chief still queued, KT-22 dispatched at KT_DISPATCHED_AT.
function queuedBesideDispatched(): RunState {
  const s = createRun(pr, "r1", t, PATROL, CREATED_AT, counter()).state;
  return onDispatched(s, KT, KT_DISPATCHED_AT).state;
}

type Outcome = "clear" | "hazards" | "failed";

// A patroller reporting: a clear verdict, a verdict with two hazards, or a failure.
function report(s: RunState, role: RoleId, outcome: Outcome, now: number): Transition {
  const id = `${role}-sweep-0`;
  if (outcome === "failed") return onFailure(s, id, "boom", now);
  return onVerdict(s, id, verdictFor(role, outcome === "hazards" ? 2 : 0), now);
}

// The patrol run once Granite Chief and then KT-22 have reported.
const sweptBy = (granite: Outcome, kt: Outcome): RunState =>
  report(report(patrolRun(), "granite-chief", granite, 2000).state, "kt-22", kt, 2500).state;

// A sweep closed around a stopped agent, hand-built as in "an agent that is stopped".
function closedAroundStopped(): RunState {
  const s = patrolRun();
  const agents = s.agents.map((a) =>
    a.id === GRANITE ? { ...a, status: "stopped" as const, summary: "stopped · lost" } : a,
  );
  return onVerdict({ ...s, agents }, KT, verdictFor("kt-22"), 2000).state;
}

const unpatrolled = (): RunState =>
  createRun(pr, "r1", { ...t, panels: [] }, config, CREATED_AT, counter()).state;

function expectUnchanged(before: RunState, after: Transition): void {
  expect(after.state).toBe(before);
  expect(after.effects).toEqual([]);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe("createRun", () => {
  it("createRun completes lift line and trail map and dispatches enabled roles", () => {
    const { state, effects } = created();
    expect(state.steps.map((s) => s.status)).toEqual([
      "done",
      "done",
      "active",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(state.agents.map((a) => a.id)).toEqual(["mainline-sweep-0"]);
    expect(state.nonces["mainline-sweep-0"]).toBe("n1");
    expect(state.goal).toBe(
      "orders: add cancel endpoint\n\nLet a customer cancel their own pending order.",
    );
    expect(stepOf(state, "trail_map").notes).toContain(
      "Rated Black diamond: +214 −12 across 7 files → Red Dog Face.",
    );
    expect(effects).toEqual([
      { type: "log", text: "run created · Red Dog Face" },
      { type: "index" },
      { type: "dispatch", agentId: "mainline-sweep-0" },
      { type: "broadcast" },
      { type: "check" },
    ]);
  });

  it("lists the steps in pipeline order", () =>
    expect(created().state.steps.map((s) => s.id)).toEqual(STEP_ORDER));

  it("copies the pull request and triage onto the run", () => {
    expect(created().state).toMatchObject({
      id: "r1",
      repo: "aghchan/simplegoapp",
      prNumber: 58,
      prTitle: "orders: add cancel endpoint",
      prUrl: "https://github.com/aghchan/simplegoapp/pull/58",
      branch: "claude/orders-cancel",
      headSha: "head58",
      panels: ["backend"],
      rating: "black",
      runName: "Red Dog Face",
      status: "on_the_hill",
      createdAt: 1000,
      updatedAt: 1000,
      installationId: 7,
      defaultBranch: "main",
      baseSha: "base58",
      stalledLogged: [],
    });
  });

  it("stamps the steps it completes and starts", () => {
    const { state } = created();
    expect(stepOf(state, "lift_line")).toEqual({
      id: "lift_line",
      status: "done",
      startedAt: 1000,
      finishedAt: 1000,
      notes: [],
    });
    expect(stepOf(state, "trail_map")).toMatchObject({
      status: "done",
      startedAt: 1000,
      finishedAt: 1000,
    });
    expect(stepOf(state, "sweep")).toEqual({
      id: "sweep",
      status: "active",
      startedAt: 1000,
      notes: [],
    });
    expect(stepOf(state, "huddle")).toEqual({ id: "huddle", status: "pending", notes: [] });
  });

  it("creates the agent queued, as round 0 of the sweep", () =>
    expect(created().state.agents).toEqual([
      {
        id: "mainline-sweep-0",
        role: "mainline",
        step: "sweep",
        round: 0,
        status: "queued",
        hasTranscript: false,
        hazards: [],
      },
    ]));

  it("trail map notes are the panel line, the rating line, then the goal's first line", () =>
    expect(stepOf(created().state, "trail_map").notes).toEqual([
      "Backend run.",
      "Rated Black diamond: +214 −12 across 7 files → Red Dog Face.",
      "Goal: orders: add cancel endpoint",
    ]));

  it.each<[string, Triage["panels"], string]>([
    ["a backend run", ["backend"], "Backend run."],
    ["a frontend run", ["frontend"], "Frontend run."],
    ["a run on both panels", ["backend", "frontend"], "Backend and frontend run."],
    ["a run with no panels", [], "No panels selected."],
  ])("opens the trail map with the right line for %s", (_label, panels, note) => {
    const { state } = createRun(pr, "r1", { ...t, panels }, config, CREATED_AT, counter());
    expect(stepOf(state, "trail_map").notes[0]).toBe(note);
  });

  it.each(Object.keys(RATING_LABELS) as Triage["rating"][])(
    "labels a %s rating with its plain name",
    (rating) => {
      const { state } = createRun(pr, "r1", { ...t, rating }, config, CREATED_AT, counter());
      expect(stepOf(state, "trail_map").notes[1]).toBe(
        `Rated ${RATING_LABELS[rating]}: +214 −12 across 7 files → Red Dog Face.`,
      );
    },
  );

  it.each<[string, string, string]>([
    ["a body", "Let a customer cancel.", "orders: add cancel endpoint\n\nLet a customer cancel."],
    ["an empty body", "", "orders: add cancel endpoint"],
    ["a whitespace-only body", " \n\t \r\n", "orders: add cancel endpoint"],
    [
      "a padded body",
      "\n\n  Line one\nLine two  \n\n",
      "orders: add cancel endpoint\n\nLine one\nLine two",
    ],
  ])("builds the goal from the title and %s", (_label, body, goal) => {
    const { state } = createRun({ ...pr, body }, "r1", t, config, CREATED_AT, counter());
    expect(state.goal).toBe(goal);
    expect(stepOf(state, "trail_map").notes[2]).toBe("Goal: orders: add cancel endpoint");
  });

  it("creates agents in roster order for the panels that apply", () => {
    const cfg: B2BConfig = {
      ...config,
      enabledRoles: ["magic-carpet", "kt-22", "groomer", "granite-chief"],
    };
    const ids = (panels: Triage["panels"]) =>
      createRun(pr, "r1", { ...t, panels }, cfg, CREATED_AT, counter()).state.agents.map(
        (a) => a.id,
      );
    expect(ids(["backend"])).toEqual([GRANITE, KT]);
    expect(ids(["frontend"])).toEqual([GRANITE, KT, "magic-carpet-sweep-0"]);
    expect(ids(["backend", "frontend"])).toEqual([GRANITE, KT, "magic-carpet-sweep-0"]);
  });

  // Indexed first: a close that arrives while GitHub takes the dispatches must find the run.
  it("gives each agent its own nonce and one dispatch, after the index", () => {
    const { state, effects } = createRun(pr, "r1", t, PATROL, CREATED_AT, counter());
    expect(state.nonces).toEqual({ [GRANITE]: "n1", [KT]: "n2" });
    expect(effects).toEqual([
      { type: "log", text: "run created · Red Dog Face" },
      { type: "index" },
      { type: "dispatch", agentId: GRANITE },
      { type: "dispatch", agentId: KT },
      { type: "broadcast" },
      { type: "check" },
    ]);
  });

  it("keeps each agent's roster name for the Conditions report", () => {
    const { state } = createRun(pr, "r1", t, PATROL, CREATED_AT, counter());
    expect(state.agentNames).toEqual({ [GRANITE]: "Granite Chief", [KT]: "KT-22" });
  });

  it("only creates agents for enabled roles", () => {
    const everyPanel: Triage = { ...t, panels: ["backend", "frontend"] };
    const { state } = createRun(pr, "r1", everyPanel, config, CREATED_AT, counter());
    expect(state.agents.map((a) => a.role)).toEqual(config.enabledRoles);
  });

  it("sweeps at creation when there are no panels", () => {
    const noFiles: Triage = { ...t, panels: [], files: 0, additions: 0, deletions: 0 };
    const mint = vi.fn(() => "unused");
    const { state, effects } = createRun(pr, "r1", noFiles, config, CREATED_AT, mint);
    expect(state.status).toBe("swept");
    expect(state.agents).toEqual([]);
    expect(state.nonces).toEqual({});
    expect(mint).not.toHaveBeenCalled();
    expect(state.steps.map((s) => s.status)).toEqual([
      "done",
      "done",
      "done",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(stepOf(state, "sweep")).toMatchObject({
      status: "done",
      startedAt: CREATED_AT,
      finishedAt: CREATED_AT,
      notes: ["No patrollers for this change", "0 of 0 patrollers in · 0 hazards · 0 failed"],
    });
    expect(effects).toEqual([
      { type: "log", text: "run created · Red Dog Face" },
      { type: "index" },
      { type: "broadcast" },
      { type: "check" },
    ]);
  });

  it("sweeps at creation when no enabled role covers the panels", () => {
    // Magic Carpet reviews the frontend only, so a backend change selects nobody.
    const cfg: B2BConfig = { ...config, enabledRoles: ["magic-carpet"] };
    const { state, effects } = createRun(pr, "r1", t, cfg, CREATED_AT, counter());
    expect(state.status).toBe("swept");
    expect(stepOf(state, "sweep").status).toBe("done");
    expect(effectTypes(effects)).toEqual(["log", "index", "broadcast", "check"]);
  });
});

describe("onDispatched", () => {
  it("marks the agent dispatched and starts its watchdog clocks", () => {
    const { state, effects } = onDispatched(created().state, ID, DISPATCHED_AT);
    expect(agentOf(state)).toMatchObject({ status: "dispatched", dispatchedAt: DISPATCHED_AT });
    expect(state.status).toBe("on_the_hill");
    expect(effects).toEqual([{ type: "broadcast" }]);
  });

  it("keeps the first dispatch time when told twice", () => {
    const s = dispatchedRun();
    expectUnchanged(s, onDispatched(s, ID, DISPATCHED_AT + 5000));
  });

  it("does not pull back to dispatched an agent whose events got here first", () => {
    const early = onEvents(created().state, ID, 1, 1100, URL_1).state;
    expectUnchanged(early, onDispatched(early, ID, 1150));
  });
});

describe("onEvents", () => {
  it("events mark running and set jobUrl once", () => {
    let s = dispatchedRun();
    s = onEvents(s, ID, 2, 1500, URL_1).state;
    s = onEvents(s, ID, 1, 1800, URL_2).state;
    expect(agentOf(s).status).toBe("running");
    expect(agentOf(s).jobUrl).toBe(URL_1);
  });

  it("records when the latest events arrived", () => {
    const { state, effects } = onEvents(dispatchedRun(), ID, 2, 1500, URL_1);
    expect(agentOf(state)).toMatchObject({
      status: "running",
      lastEventAt: 1500,
      dispatchedAt: DISPATCHED_AT,
    });
    expect(effects).toEqual([{ type: "broadcast" }]);
    expect(onEvents(state, ID, 1, 1800, URL_1).state.agents[0]).toMatchObject({
      lastEventAt: 1800,
    });
  });

  it("lets the first non-empty job url win", () => {
    let s = onEvents(dispatchedRun(), ID, 1, 1500, "").state;
    expect(agentOf(s)).not.toHaveProperty("jobUrl");
    s = onEvents(s, ID, 1, 1600, URL_1).state;
    s = onEvents(s, ID, 1, 1700, "").state;
    expect(agentOf(s).jobUrl).toBe(URL_1);
  });

  it("events after stall resume running", () => {
    const resumed = onEvents(stalledRun(), ID, 1, BRIEFED_AT + STALL_MS + 5000, URL_1);
    expect(agentOf(resumed.state).status).toBe("running");
    expect(resumed.effects).toEqual([{ type: "broadcast" }]);
  });

  it("ignores a batch that added no new events", () => {
    const s = runningRun();
    expectUnchanged(s, onEvents(s, ID, 0, 9000, URL_2));
  });

  it("starts the clocks of an agent whose events beat the dispatch response", () => {
    const { state } = onEvents(created().state, ID, 1, 1100, URL_1);
    expect(agentOf(state)).toMatchObject({
      status: "running",
      dispatchedAt: 1100,
      lastEventAt: 1100,
    });
  });
});

describe("onBriefed", () => {
  it("starts the agent's clocks and records its job", () => {
    const { state, effects } = onBriefed(dispatchedRun(), ID, BRIEFED_AT, JOB);
    expect(agentOf(state)).toMatchObject({
      status: "dispatched",
      dispatchedAt: DISPATCHED_AT,
      briefedAt: BRIEFED_AT,
      jobUrl: URL_1,
    });
    expect(state.jobRuns).toEqual({ [ID]: "1" });
    expect(state.updatedAt).toBe(BRIEFED_AT);
    expect(effects).toEqual([{ type: "broadcast" }]);
  });

  it("keeps each agent's own job", () => {
    expect(briefedPatrol().jobRuns).toEqual({ [GRANITE]: "1", [KT]: "2" });
  });

  it("keeps the job url the agent already has", () => {
    const { state } = onBriefed(runningRun(), ID, 9000, { githubRunId: "1", jobUrl: URL_2 });
    expect(agentOf(state).jobUrl).toBe(URL_1);
  });

  it("restarts the clocks for a re-run of the job, forgetting the last attempt's events", () => {
    const { state } = onBriefed(runningRun(), ID, 9000, JOB);
    expect(agentOf(state)).toMatchObject({ status: "running", briefedAt: 9000 });
    expect(agentOf(state)).not.toHaveProperty("lastEventAt");
    expect(nextAlarm(state)).toBe(9000 + STALL_MS);
  });

  it("watches a re-run of a stalled agent for a stall again", () => {
    const at = BRIEFED_AT + STALL_MS + 5000;
    const { state } = onBriefed(stalledRun(), ID, at, JOB);
    expect(agentOf(state).status).toBe("running");
    expect(nextAlarm(state)).toBe(at + STALL_MS);
    expect(agentOf(onTick(state, at + STALL_MS).state).status).toBe("stalled");
  });

  it("puts an agent briefed before its dispatch result came in on the brief's clocks", () => {
    const { state } = onBriefed(created().state, ID, 1100, JOB);
    expect(agentOf(state)).toMatchObject({ status: "queued", briefedAt: 1100 });
    expect(nextAlarm(state)).toBe(1100 + STALL_MS);
    expectUnchanged(state, onTick(state, CREATED_AT + STALL_MS));
  });
});

describe("onVerdict", () => {
  it("last verdict sweeps the run", () => {
    const { state, effects } = onVerdict(runningRun(), ID, clearVerdict, 2000);
    expect(state.status).toBe("swept");
    expect(stepOf(state, "sweep")).toMatchObject({ status: "done", finishedAt: 2000 });
    expect(effects).toContainEqual({ type: "log", text: "all 1 sweeps in · 0 hazards" });
  });

  it("logs, indexes and broadcasts the sweep, then mirrors it to the check run", () =>
    expect(onVerdict(runningRun(), ID, clearVerdict, 2000).effects).toEqual([
      { type: "log", text: "all 1 sweeps in · 0 hazards" },
      { type: "index" },
      { type: "broadcast" },
      { type: "check" },
    ]));

  it("records a clear verdict on the agent", () => {
    const { state } = onVerdict(runningRun(), ID, clearVerdict, 2000);
    expect(agentOf(state)).toMatchObject({
      status: "clear",
      finishedAt: 2000,
      summary: "Nothing found.",
      hazards: [],
    });
  });

  it("records hazards on the agent and counts them in the sweep", () => {
    const { state, effects } = onVerdict(runningRun(), ID, hazardVerdict, 2000);
    expect(agentOf(state)).toMatchObject({
      status: "hazards",
      finishedAt: 2000,
      summary: "2 found.",
      hazards: hazardVerdict.hazards,
    });
    expect(effects).toContainEqual({ type: "log", text: "all 1 sweeps in · 2 hazards" });
  });

  it("accepts the verdict of an agent that had stalled", () => {
    const { state } = onVerdict(stalledRun(), ID, clearVerdict, BRIEFED_AT + STALL_MS + 1);
    expect(agentOf(state).status).toBe("clear");
    expect(state.status).toBe("swept");
  });

  it("leaves the sweep open while another patroller is out, mirroring the verdict", () => {
    const { state, effects } = onVerdict(patrolRun(), GRANITE, verdictFor("granite-chief"), 2000);
    expect(agentOf(state, GRANITE).status).toBe("clear");
    expect(agentOf(state, KT).status).toBe("dispatched");
    expect(state.status).toBe("on_the_hill");
    expect(stepOf(state, "sweep").status).toBe("active");
    expect(effects).toEqual([{ type: "broadcast" }, { type: "check" }]);
  });

  it("sweeps when the last patroller reports, counting every agent's hazards", () => {
    const first = onVerdict(patrolRun(), GRANITE, verdictFor("granite-chief", 1), 2000).state;
    const { state, effects } = onVerdict(first, KT, verdictFor("kt-22", 2), 2500);
    expect(state.status).toBe("swept");
    expect(stepOf(state, "sweep")).toMatchObject({ status: "done", finishedAt: 2500 });
    expect(effects).toEqual([
      { type: "log", text: "all 2 sweeps in · 3 hazards" },
      { type: "index" },
      { type: "broadcast" },
      { type: "check" },
    ]);
  });

  it("ignores a second verdict", () => {
    const swept = onVerdict(runningRun(), ID, clearVerdict, 2000).state;
    expect(onVerdict(swept, ID, hazardVerdict, 3000).effects).toEqual([]);
    expectUnchanged(swept, onVerdict(swept, ID, hazardVerdict, 3000));
  });
});

describe("onFailure", () => {
  it("failure completes the sweep with error", () => {
    const { state, effects } = onFailure(runningRun(), ID, "timed out", 2000);
    expect(agentOf(state).status).toBe("error");
    expect(agentOf(state).summary).toBe("timed out");
    expect(agentOf(state).finishedAt).toBe(2000);
    expect(state.status).toBe("swept");
    expect(stepOf(state, "sweep")).toMatchObject({ status: "done", finishedAt: 2000 });
    expect(effects).toEqual([
      { type: "log", text: "mainline-sweep-0 failed · timed out" },
      { type: "log", text: "all 1 sweeps in · 0 hazards · 1 failed" },
      { type: "index" },
      { type: "broadcast" },
      { type: "check" },
    ]);
  });

  it("fails an agent that was never dispatched", () => {
    const { state, effects } = onFailure(created().state, ID, "dispatch failed: 500", 1100);
    expect(agentOf(state)).toMatchObject({ status: "error", summary: "dispatch failed: 500" });
    expect(state.status).toBe("swept");
    expect(effects).toEqual([
      { type: "log", text: "mainline-sweep-0 failed · dispatch failed: 500" },
      { type: "log", text: "all 1 sweeps in · 0 hazards · 1 failed" },
      { type: "index" },
      { type: "broadcast" },
      { type: "check" },
    ]);
  });

  // The job's failure step may be the first Dispatch hears from it.
  it("links the job of an agent that failed before its brief", () => {
    const why = "job failed before the agent reported";
    const { state } = onFailure(dispatchedRun(), ID, why, 2000, URL_2);
    expect(agentOf(state)).toMatchObject({ status: "error", summary: why, jobUrl: URL_2 });
  });

  it("keeps the job link the agent already has", () =>
    expect(agentOf(onFailure(runningRun(), ID, "boom", 2000, URL_2).state).jobUrl).toBe(URL_1));

  it("logs the failure even while another patroller keeps the sweep open", () => {
    const { state, effects } = onFailure(patrolRun(), GRANITE, "boom", 2000);
    expect(agentOf(state, GRANITE)).toMatchObject({ status: "error", summary: "boom" });
    expect(state.status).toBe("on_the_hill");
    expect(effects).toEqual([
      { type: "log", text: "granite-chief-sweep-0 failed · boom" },
      { type: "broadcast" },
      { type: "check" },
    ]);
  });

  it("sweeps once a failure and a verdict have both come in", () => {
    const first = onFailure(patrolRun(), GRANITE, "boom", 2000).state;
    const { state, effects } = onVerdict(first, KT, verdictFor("kt-22", 1), 2500);
    expect(state.status).toBe("swept");
    expect(effects).toEqual([
      { type: "log", text: "all 2 sweeps in · 1 hazards · 1 failed" },
      { type: "index" },
      { type: "broadcast" },
      { type: "check" },
    ]);
  });

  it.each<[Outcome, Outcome, string]>([
    ["clear", "clear", "all 2 sweeps in · 0 hazards"],
    ["hazards", "clear", "all 2 sweeps in · 2 hazards"],
    ["failed", "clear", "all 2 sweeps in · 0 hazards · 1 failed"],
    ["hazards", "failed", "all 2 sweeps in · 2 hazards · 1 failed"],
    ["failed", "failed", "all 2 sweeps in · 0 hazards · 2 failed"],
  ])("summarizes a sweep that ends %s, %s as '%s'", (first, second, summary) => {
    const opened = report(patrolRun(), "granite-chief", first, 2000).state;
    const closed = report(opened, "kt-22", second, 2500);
    expect(closed.state.status).toBe("swept");
    expect(closed.effects).toContainEqual({ type: "log", text: summary });
  });
});

describe("the sweep's Conditions report", () => {
  const notesOf = (s: RunState) => stepOf(s, "sweep").notes;

  it("names the outcome, tallies the sweep, then gives each patroller's summary in run order", () => {
    const first = onFailure(patrolRun(), KT, "claude exited 1", 2000).state;
    const { state } = onVerdict(first, GRANITE, verdictFor("granite-chief", 2), 2500);
    expect(notesOf(state)).toEqual([
      "Review failed",
      "2 of 2 patrollers in · 2 hazards · 1 failed",
      "Granite Chief: 2 found.",
      "KT-22: claude exited 1",
    ]);
  });

  it("is not written while the sweep is open", () => {
    const { state } = onVerdict(patrolRun(), GRANITE, verdictFor("granite-chief"), 2000);
    expect(notesOf(state)).toEqual([]);
  });

  it("gives the reason of a patroller that never reported", () => {
    expect(notesOf(timedOutRun())).toEqual([
      "Review failed",
      "1 of 1 patroller in · 0 hazards · 1 failed",
      "Mainline: timed out",
    ]);
  });

  it.each([
    [0, "1 of 1 patroller in · 0 hazards · 0 failed"],
    [1, "1 of 1 patroller in · 1 hazard · 0 failed"],
    [2, "1 of 1 patroller in · 2 hazards · 0 failed"],
  ])("tallies %i hazards as '%s'", (count, tally) => {
    const { state } = onVerdict(runningRun(), ID, verdictFor("mainline", count), 2000);
    expect(notesOf(state)[1]).toBe(tally);
  });

  it.each<[string, () => RunState, string]>([
    ["clear", () => sweptBy("clear", "clear"), "Patrol clear · review passed"],
    ["hazards", () => sweptBy("hazards", "clear"), "Hazards flagged"],
    ["failed", () => sweptBy("clear", "failed"), "Review failed"],
    ["failed with hazards", () => sweptBy("hazards", "failed"), "Review failed"],
    ["none", unpatrolled, "No patrollers for this change"],
  ])("names a %s review on its first line", (_name, run, first) =>
    expect(notesOf(run())[0]).toBe(first));
});

describe("reviewOutcome", () => {
  it.each<[Outcome, Outcome, ReviewOutcome]>([
    ["clear", "clear", "clear"],
    ["hazards", "clear", "hazards"],
    ["clear", "hazards", "hazards"],
    ["hazards", "hazards", "hazards"],
    ["failed", "clear", "failed"],
    ["clear", "failed", "failed"],
    ["failed", "failed", "failed"],
    ["failed", "hazards", "failed"],
    ["hazards", "failed", "failed"],
  ])("is %s, %s → %s once the sweep is in", (granite, kt, outcome) =>
    expect(reviewOutcome(sweptBy(granite, kt))).toBe(outcome));

  it("is pending while the sweep is open, even once a patroller has failed", () => {
    expect(reviewOutcome(patrolRun())).toBe("pending");
    expect(reviewOutcome(report(patrolRun(), "granite-chief", "failed", 2000).state)).toBe(
      "pending",
    );
    expect(reviewOutcome(report(patrolRun(), "kt-22", "hazards", 2000).state)).toBe("pending");
  });

  it("is pending for a run stopped before its sweep was in", () =>
    expect(reviewOutcome(stopRun(runningRun(), "PR closed", 1500).state)).toBe("pending"));

  it("is none for a sweep with no patrollers", () => expect(reviewOutcome(unpatrolled())).toBe("none"));

  it("fails a patroller that timed out", () => expect(reviewOutcome(timedOutRun())).toBe("failed"));

  it("is pending for a run that landed before its sweep was in", () =>
    expect(reviewOutcome(landRun(runningRun(), MERGE_SHA, 1500).state)).toBe("pending"));

  it.each<[Outcome, Outcome, ReviewOutcome]>([
    ["clear", "clear", "clear"],
    ["hazards", "clear", "hazards"],
    ["clear", "failed", "failed"],
  ])("keeps a %s, %s sweep's %s once the run is stopped or has landed", (granite, kt, outcome) => {
    expect(reviewOutcome(stopRun(sweptBy(granite, kt), "PR closed", 3000).state)).toBe(outcome);
    expect(reviewOutcome(landRun(sweptBy(granite, kt), MERGE_SHA, 3000).state)).toBe(outcome);
  });

  it("fails a sweep that closed around a stopped patroller", () =>
    expect(reviewOutcome(closedAroundStopped())).toBe("failed"));

  it("fails a failed run", () =>
    expect(reviewOutcome({ ...sweptBy("clear", "clear"), status: "failed" })).toBe("failed"));
});

describe("watchdog", () => {
  it("stalls after 10 minutes silent, logs once", () => {
    const a = onTick(briefedRun(), BRIEFED_AT + STALL_MS);
    expect(agentOf(a.state).status).toBe("stalled");
    expect(
      onTick(a.state, BRIEFED_AT + STALL_MS + 1).effects.filter((e) => e.type === "log"),
    ).toHaveLength(0);
  });

  // A stall shows on the dashboard only: the check has nothing new to say.
  it("logs the stall and broadcasts it, leaving the check alone", () => {
    const { state, effects } = onTick(briefedRun(), BRIEFED_AT + STALL_MS);
    expect(state.status).toBe("on_the_hill");
    expect(effects).toEqual([
      { type: "log", text: "mainline-sweep-0 stalled · no events for 10m" },
      { type: "broadcast" },
    ]);
  });

  it("does nothing a minute early", () => {
    const s = briefedRun();
    expectUnchanged(s, onTick(s, BRIEFED_AT + STALL_MS - 1));
  });

  it("measures the silence from the last event, not from the brief", () => {
    const s = onEvents(briefedRun(), ID, 3, 5000, URL_1).state;
    expectUnchanged(s, onTick(s, 5000 + STALL_MS - 1));
    expect(agentOf(onTick(s, 5000 + STALL_MS).state).status).toBe("stalled");
  });

  it("leaves a stalled agent alone until it times out", () => {
    const s = stalledRun();
    expectUnchanged(s, onTick(s, BRIEFED_AT + STALL_MS + 1));
    expectUnchanged(s, onTick(s, BRIEFED_AT + AGENT_TIMEOUT_MS - 1));
  });

  it("stalls again after resuming, but does not log the second stall", () => {
    const resumedAt = BRIEFED_AT + STALL_MS + 5000;
    const resumed = onEvents(stalledRun(), ID, 1, resumedAt, URL_1).state;
    const again = onTick(resumed, resumedAt + STALL_MS);
    expect(agentOf(again.state).status).toBe("stalled");
    expect(again.effects).toEqual([{ type: "broadcast" }]);
    expect(again.state.stalledLogged).toEqual([ID]);
  });

  it("times out 30 minutes after the brief", () => {
    const at = BRIEFED_AT + AGENT_TIMEOUT_MS;
    const { state } = onTick(briefedRun(), at);
    expect(agentOf(state)).toMatchObject({
      status: "error",
      summary: "timed out",
      finishedAt: at,
    });
  });

  it("a timeout completes the sweep like any other failure", () => {
    const { state, effects } = onTick(briefedRun(), BRIEFED_AT + AGENT_TIMEOUT_MS);
    expect(state.status).toBe("swept");
    expect(effects).toEqual([
      { type: "log", text: "mainline-sweep-0 failed · timed out" },
      { type: "log", text: "all 1 sweeps in · 0 hazards · 1 failed" },
      { type: "index" },
      { type: "broadcast" },
      { type: "check" },
    ]);
  });

  it("does not time out a millisecond early", () => {
    const { state } = onTick(briefedRun(), BRIEFED_AT + AGENT_TIMEOUT_MS - 1);
    expect(agentOf(state).status).toBe("stalled");
  });

  it("counts the timeout from the brief even if the agent is still talking", () => {
    const chatty = onEvents(briefedRun(), ID, 1, BRIEFED_AT + AGENT_TIMEOUT_MS - 1000, URL_1);
    expect(agentOf(onTick(chatty.state, BRIEFED_AT + AGENT_TIMEOUT_MS).state).status).toBe(
      "error",
    );
  });

  it("times out a stalled agent", () => {
    const { state } = onTick(stalledRun(), BRIEFED_AT + AGENT_TIMEOUT_MS);
    expect(agentOf(state)).toMatchObject({ status: "error", summary: "timed out" });
  });

  // A job that waited in GitHub's queue still gets its 30 minutes.
  it("counts no time before the brief against the agent", () => {
    const late = onBriefed(dispatchedRun(), ID, DISPATCHED_AT + JOB_START_MS - 1, JOB).state;
    expectUnchanged(late, onTick(late, DISPATCHED_AT + JOB_START_MS));
    expect(nextAlarm(late)).toBe(DISPATCHED_AT + JOB_START_MS - 1 + STALL_MS);
  });

  it("does not stall an agent whose job has yet to start", () => {
    const s = dispatchedRun();
    expectUnchanged(s, onTick(s, DISPATCHED_AT + STALL_MS));
    expectUnchanged(s, onTick(s, DISPATCHED_AT + JOB_START_MS - 1));
  });

  it("fails an agent whose job never started, 30 minutes after dispatch", () => {
    const at = DISPATCHED_AT + JOB_START_MS;
    const { state, effects } = onTick(dispatchedRun(), at);
    expect(agentOf(state)).toMatchObject({
      status: "error",
      summary: "job never started on GitHub",
      finishedAt: at,
    });
    expect(state.status).toBe("swept");
    expect(effects).toEqual([
      { type: "log", text: "mainline-sweep-0 failed · job never started on GitHub" },
      { type: "log", text: "all 1 sweeps in · 0 hazards · 1 failed" },
      { type: "index" },
      { type: "broadcast" },
      { type: "check" },
    ]);
  });

  it("leaves an agent that is not yet dispatched alone for 10 minutes", () => {
    const s = created().state;
    expectUnchanged(s, onTick(s, CREATED_AT + STALL_MS - 1));
  });

  it("fails an agent still not dispatched 10 minutes after the run was created", () => {
    const at = CREATED_AT + STALL_MS;
    const { state, effects } = onTick(created().state, at);
    expect(agentOf(state)).toMatchObject({
      status: "error",
      summary: "never dispatched",
      finishedAt: at,
    });
    expect(state.status).toBe("swept");
    expect(effects).toEqual([
      { type: "log", text: "mainline-sweep-0 failed · never dispatched" },
      { type: "log", text: "all 1 sweeps in · 0 hazards · 1 failed" },
      { type: "index" },
      { type: "broadcast" },
      { type: "check" },
    ]);
  });

  it("fails only the agent that was never dispatched, leaving the sweep open", () => {
    const { state, effects } = onTick(queuedBesideDispatched(), CREATED_AT + STALL_MS);
    expect(agentOf(state, GRANITE)).toMatchObject({ status: "error", summary: "never dispatched" });
    expect(agentOf(state, KT).status).toBe("dispatched");
    expect(state.status).toBe("on_the_hill");
    expect(effects).toEqual([
      { type: "log", text: "granite-chief-sweep-0 failed · never dispatched" },
      { type: "broadcast" },
      { type: "check" },
    ]);
  });

  it("takes an agent off the dispatch clock once it is dispatched", () => {
    const s = dispatchedRun();
    expectUnchanged(s, onTick(s, CREATED_AT + STALL_MS));
  });

  it("ignores a dispatch result that arrives after the agent was failed", () => {
    const failedFirst = onTick(queuedBesideDispatched(), CREATED_AT + STALL_MS).state;
    expectUnchanged(failedFirst, onDispatched(failedFirst, GRANITE, CREATED_AT + STALL_MS + 5));
  });

  it("leaves agents that already reported alone", () => {
    const reported = onVerdict(briefedPatrol(), GRANITE, verdictFor("granite-chief"), 2000).state;
    const { state } = onTick(reported, KT_BRIEFED_AT + AGENT_TIMEOUT_MS);
    expect(agentOf(state, GRANITE)).toEqual(agentOf(reported, GRANITE));
    expect(agentOf(state, KT).status).toBe("error");
  });

  it("handles every agent due at the same tick with one index and one broadcast", () => {
    const { state, effects } = onTick(briefedPatrol(), KT_BRIEFED_AT + AGENT_TIMEOUT_MS);
    expect(state.agents.map((a) => a.status)).toEqual(["error", "error"]);
    expect(state.status).toBe("swept");
    expect(effects).toEqual([
      { type: "log", text: "granite-chief-sweep-0 failed · timed out" },
      { type: "log", text: "kt-22-sweep-0 failed · timed out" },
      { type: "log", text: "all 2 sweeps in · 0 hazards · 2 failed" },
      { type: "index" },
      { type: "broadcast" },
      { type: "check" },
    ]);
  });

  it("logs each stall at a shared tick, in agent order, with one broadcast", () => {
    const { state, effects } = onTick(briefedPatrol(), KT_BRIEFED_AT + STALL_MS);
    expect(state.agents.map((a) => a.status)).toEqual(["stalled", "stalled"]);
    expect(effects).toEqual([
      { type: "log", text: "granite-chief-sweep-0 stalled · no events for 10m" },
      { type: "log", text: "kt-22-sweep-0 stalled · no events for 10m" },
      { type: "broadcast" },
    ]);
  });

  it("times one agent out and stalls another in the same tick, mirroring the failure", () => {
    const { state, effects } = onTick(briefedPatrol(), BRIEFED_AT + AGENT_TIMEOUT_MS);
    expect(agentOf(state, GRANITE)).toMatchObject({ status: "error", summary: "timed out" });
    expect(agentOf(state, KT).status).toBe("stalled");
    expect(state.status).toBe("on_the_hill");
    expect(effects).toEqual([
      { type: "log", text: "granite-chief-sweep-0 failed · timed out" },
      { type: "log", text: "kt-22-sweep-0 stalled · no events for 10m" },
      { type: "broadcast" },
      { type: "check" },
    ]);
  });
});

describe("stopRun", () => {
  it("stop marks the active step stopped", () => {
    const { state } = stopRun(runningRun(), "PR closed", 1500);
    expect(stepOf(state, "sweep")).toMatchObject({ status: "stopped", finishedAt: 1500 });
    expect(state.status).toBe("stopped");
    expect(state.updatedAt).toBe(1500);
  });

  it("logs the reason, indexes, broadcasts and mirrors it to the check, then cancels the job", () =>
    expect(stopRun(runningRun(), "PR closed", 1500).effects).toEqual([
      { type: "log", text: "stopped · PR closed" },
      { type: "index" },
      { type: "broadcast" },
      { type: "check" },
      { type: "cancel", agentId: ID, githubRunId: "1" },
    ]));

  it("cancels only the jobs GitHub has started for agents still out", () => {
    // Granite Chief briefed and still out, KT-22 reported without a brief on record.
    const graniteOut = onVerdict(
      onBriefed(patrolRun(), GRANITE, BRIEFED_AT, JOB).state,
      KT,
      verdictFor("kt-22"),
      1600,
    ).state;
    const cancelsOf = (s: RunState) =>
      stopRun(s, "PR closed", 5000).effects.filter((effect) => effect.type === "cancel");
    expect(cancelsOf(graniteOut)).toEqual([
      { type: "cancel", agentId: GRANITE, githubRunId: "1" },
    ]);
    // Both briefed; Granite Chief has reported.
    const ktOut = onVerdict(briefedPatrol(), GRANITE, verdictFor("granite-chief"), 1600).state;
    expect(cancelsOf(ktOut)).toEqual([{ type: "cancel", agentId: KT, githubRunId: "2" }]);
  });

  it("cancels nothing while no job has started", () =>
    expect(effectTypes(stopRun(patrolRun(), "PR closed", 1500).effects)).not.toContain("cancel"));

  it("leaves finished and upcoming steps as they were", () => {
    const before = runningRun();
    const { state } = stopRun(before, "PR closed", 1500);
    expect(state.steps.map((s) => s.status)).toEqual([
      "done",
      "done",
      "stopped",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(stepOf(state, "lift_line")).toEqual(stepOf(before, "lift_line"));
    expect(stepOf(state, "huddle")).toEqual(stepOf(before, "huddle"));
  });

  it.each<[string, () => RunState]>([
    ["a queued", () => created().state],
    ["a dispatched", dispatchedRun],
    ["a briefed", briefedRun],
    ["a running", runningRun],
    ["a stalled", stalledRun],
  ])("marks %s agent stopped, with the reason and the time", (_label, build) => {
    const before = build();
    const { state } = stopRun(before, "PR closed", 5000);
    expect(agentOf(state)).toEqual({
      ...agentOf(before),
      status: "stopped",
      summary: "stopped · PR closed",
      finishedAt: 5000,
    });
  });

  it("stops what is unfinished and leaves what already reported as it was", () => {
    let s = createRun(pr, "r1", t, SQUAD, CREATED_AT, counter()).state;
    for (const id of [GRANITE, GOLD, SUMMIT, KT]) s = onDispatched(s, id, DISPATCHED_AT).state;
    s = onVerdict(s, GRANITE, verdictFor("granite-chief"), 1600).state;
    s = onVerdict(s, GOLD, verdictFor("gold-coast", 1), 1700).state;
    s = onFailure(s, SUMMIT, "boom", 1800).state;
    s = onEvents(s, KT, 2, 1900, URL_1).state;

    const { state } = stopRun(s, "PR closed", 5000);
    expect(state.agents.map((a) => [a.id, a.status])).toEqual([
      [GRANITE, "clear"],
      [GOLD, "hazards"],
      [SUMMIT, "error"],
      [KT, "stopped"],
      [ID, "stopped"],
    ]);
    for (const id of [GRANITE, GOLD, SUMMIT]) expect(agentOf(state, id)).toEqual(agentOf(s, id));
    expect(agentOf(state, KT)).toMatchObject({ summary: "stopped · PR closed", finishedAt: 5000 });
    expect(agentOf(state, ID)).toMatchObject({ summary: "stopped · PR closed", finishedAt: 5000 });
  });

  it("ignores events and verdicts after stop", () => {
    const stopped = stopRun(runningRun(), "PR closed", 1500).state;
    expect(onEvents(stopped, ID, 3, 1600, URL_1)).toEqual({ state: stopped, effects: [] });
    expect(onVerdict(stopped, ID, clearVerdict, 1600)).toEqual({ state: stopped, effects: [] });
  });

  it("is a no-op the second time, so a duplicate close does not log twice", () => {
    const stopped = stopRun(runningRun(), "PR closed", 1500).state;
    expectUnchanged(stopped, stopRun(stopped, "PR closed", 1600));
  });

  it.each<RunStatus>(["failed", "landed"])("leaves a %s run alone", (status) => {
    const s: RunState = { ...sweptBy("clear", "clear"), status };
    expectUnchanged(s, stopRun(s, "PR closed", 3000));
  });

  describe("a swept run", () => {
    it("is stopped, keeping its sweep and its agents", () => {
      const swept = sweptBy("hazards", "clear");
      const { state } = stopRun(swept, "superseded by head59", 3000);
      expect(state).toEqual({ ...swept, status: "stopped", updatedAt: 3000 });
    });

    // The sweep's conclusion on GitHub stands.
    it("logs, indexes and broadcasts, but leaves the check alone", () =>
      expect(stopRun(sweptBy("clear", "clear"), "PR closed", 3000).effects).toEqual([
        { type: "log", text: "stopped · PR closed" },
        { type: "index" },
        { type: "broadcast" },
      ]));

    it("is a no-op the second time", () => {
      const stopped = stopRun(sweptBy("clear", "clear"), "PR closed", 3000).state;
      expectUnchanged(stopped, stopRun(stopped, "PR closed", 3100));
    });
  });
});

describe("landRun", () => {
  const SHA7 = "abc1234";

  it("lands a swept run on the merge commit", () => {
    const { state } = landRun(sweptBy("clear", "clear"), MERGE_SHA, 3000);
    expect(state).toMatchObject({ status: "landed", mergeSha: MERGE_SHA, updatedAt: 3000 });
  });

  it("skips the steps not built yet, and drops in as merged on GitHub", () => {
    const swept = sweptBy("clear", "clear");
    const { state } = landRun(swept, MERGE_SHA, 3000);
    expect(state.steps).toEqual([
      stepOf(swept, "lift_line"),
      stepOf(swept, "trail_map"),
      stepOf(swept, "sweep"),
      { id: "huddle", status: "skipped", notes: ["No huddle until M3."] },
      { id: "summit", status: "skipped", notes: ["No summit check until M4."] },
      {
        id: "drop_in",
        status: "done",
        startedAt: 3000,
        finishedAt: 3000,
        notes: [`Merged on GitHub as ${SHA7}.`],
      },
      { id: "send_it", status: "skipped", notes: ["Deploy is manual until M4."] },
    ]);
  });

  it("skips the huddle and summit only while they are pending", () => {
    const swept = sweptBy("clear", "clear");
    const huddled: RunState = {
      ...swept,
      steps: swept.steps.map((step) =>
        step.id === "huddle" ? { ...step, status: "done", notes: ["Quorum met."] } : step,
      ),
    };
    const { state } = landRun(huddled, MERGE_SHA, 3000);
    expect(stepOf(state, "huddle")).toEqual(stepOf(huddled, "huddle"));
    expect(stepOf(state, "summit").status).toBe("skipped");
  });

  // Its check concluded with the sweep, and stays as GitHub has it.
  it("logs, indexes and broadcasts a finished review, leaving its check alone", () =>
    expect(landRun(sweptBy("hazards", "clear"), MERGE_SHA, 3000).effects).toEqual([
      { type: "log", text: `landed · merged as ${SHA7}` },
      { type: "index" },
      { type: "broadcast" },
    ]));

  it("keeps the agents of a finished review as they were", () => {
    const swept = sweptBy("clear", "failed");
    expect(landRun(swept, MERGE_SHA, 3000).state.agents).toEqual(swept.agents);
  });

  describe("merged mid-review", () => {
    it("stops the agents still out and their step", () => {
      const { state } = landRun(runningRun(), MERGE_SHA, 3000);
      expect(agentOf(state)).toMatchObject({
        status: "stopped",
        summary: "stopped · PR merged",
        finishedAt: 3000,
      });
      expect(stepOf(state, "sweep")).toMatchObject({ status: "stopped", finishedAt: 3000 });
      expect(state.status).toBe("landed");
    });

    it("ends the check and cancels the jobs GitHub has started", () =>
      expect(landRun(runningRun(), MERGE_SHA, 3000).effects).toEqual([
        { type: "log", text: `landed · merged as ${SHA7}` },
        { type: "index" },
        { type: "broadcast" },
        { type: "check" },
        { type: "cancel", agentId: ID, githubRunId: "1" },
      ]));

    it("cancels nothing for an agent whose job never started", () =>
      expect(effectTypes(landRun(dispatchedRun(), MERGE_SHA, 3000).effects)).not.toContain(
        "cancel",
      ));

    it("lands a run that was stopped", () => {
      const stopped = stopRun(runningRun(), "PR closed", 2000).state;
      const { state, effects } = landRun(stopped, MERGE_SHA, 3000);
      expect(state.status).toBe("landed");
      expect(agentOf(state)).toEqual(agentOf(stopped));
      expect(effectTypes(effects)).toEqual(["log", "index", "broadcast", "check"]);
    });
  });

  it("is a no-op once landed, so a repeated merge event does not log twice", () => {
    const landed = landedRun();
    expectUnchanged(landed, landRun(landed, MERGE_SHA, 4000));
    expectUnchanged(landed, landRun(landed, "fff0000", 4000));
  });

  it("ends the watch on the run", () =>
    expect(nextAlarm(landRun(runningRun(), MERGE_SHA, 3000).state)).toBeNull());
});

describe("retryAgents", () => {
  const fresh = () => "fresh";
  // Granite Chief failed; KT-22 reported clear, so the sweep is in and the review failed.
  const failedGranite = () => sweptBy("failed", "clear");
  // Both briefed; Granite Chief's job failed, then KT-22 came in clear.
  const failedBriefed = () =>
    onVerdict(
      onFailure(briefedPatrol(), GRANITE, "job failed before the agent reported", 1600).state,
      KT,
      verdictFor("kt-22"),
      1700,
    ).state;

  it("runs a failed agent again from a fresh job, with a fresh nonce", () => {
    const before = failedGranite();
    const { state } = retryAgents(before, { agentId: GRANITE }, 5000, fresh);
    expect(agentOf(state, GRANITE)).toEqual({
      id: GRANITE,
      role: "granite-chief",
      step: "sweep",
      round: 0,
      status: "queued",
      hasTranscript: false,
      hazards: [],
      retries: 1,
      retriedAt: 5000,
    });
    expect(state.nonces).toEqual({ ...before.nonces, [GRANITE]: "fresh" });
    expect(state.updatedAt).toBe(5000);
  });

  it("leaves the other agents' reports standing", () => {
    const before = failedGranite();
    const { state } = retryAgents(before, { agentId: GRANITE }, 5000, fresh);
    expect(agentOf(state, KT)).toBe(agentOf(before, KT));
  });

  it("reopens the sweep and puts the run back on the hill, its outcome pending again", () => {
    const { state } = retryAgents(failedGranite(), { agentId: GRANITE }, 5000, fresh);
    expect(state.status).toBe("on_the_hill");
    expect(stepOf(state, "sweep")).toEqual({
      id: "sweep",
      status: "active",
      startedAt: CREATED_AT,
      notes: [],
    });
    expect(reviewOutcome(state)).toBe("pending");
    expect(checkRunOf(state, "https://b2b.example").status).toBe("in_progress");
  });

  it("logs and indexes the retry, dispatches the agent, and posts a fresh check", () => {
    const { state, effects } = retryAgents(failedGranite(), { agentId: GRANITE }, 5000, fresh);
    expect(effects).toEqual([
      { type: "log", text: `${GRANITE} retried · attempt 2` },
      { type: "index" },
      { type: "dispatch", agentId: GRANITE },
      { type: "broadcast" },
      { type: "check" },
    ]);
    // A completed check run cannot go back to in progress.
    expect(state.checkReposts).toBe(1);
  });

  it("cancels the failed agent's old job and forgets it, keeping the others' jobs", () => {
    const { state, effects } = retryAgents(failedBriefed(), { agentId: GRANITE }, 5000, fresh);
    expect(effects.at(-1)).toEqual({ type: "cancel", agentId: GRANITE, githubRunId: "1" });
    expect(state.jobRuns).toEqual({ [KT]: "2" });
    // A stop now cancels nothing of Granite Chief's until its new job is briefed.
    const stopped = stopRun(state, "PR closed", 6000);
    expect(stopped.effects.filter((effect) => effect.type === "cancel")).toEqual([]);
  });

  it("forgets the failed attempt's stall, so a stall of the new one is logged", () => {
    let s = onTick(briefedPatrol(), KT_BRIEFED_AT + STALL_MS).state;
    s = onFailure(s, GRANITE, "boom", KT_BRIEFED_AT + STALL_MS + 1).state;
    s = onFailure(s, KT, "boom", KT_BRIEFED_AT + STALL_MS + 2).state;
    expect(s.stalledLogged).toEqual([GRANITE, KT]);
    expect(retryAgents(s, { agentId: GRANITE }, 5000, fresh).state.stalledLogged).toEqual([KT]);
  });

  it("retries every failed agent on a step, each with its own nonce", () => {
    const both = sweptBy("failed", "failed");
    const { state, effects } = retryAgents(both, { step: "sweep" }, 5000, counter());
    expect(state.agents.map((agent) => agent.status)).toEqual(["queued", "queued"]);
    expect(new Set([state.nonces[GRANITE], state.nonces[KT]]).size).toBe(2);
    expect(effects.filter((effect) => effect.type === "dispatch")).toEqual([
      { type: "dispatch", agentId: GRANITE },
      { type: "dispatch", agentId: KT },
    ]);
  });

  it("leaves a step's agents that did not fail as they reported", () => {
    const before = sweptBy("failed", "hazards");
    const { state } = retryAgents(before, { step: "sweep" }, 5000, fresh);
    expect(agentOf(state, GRANITE).status).toBe("queued");
    expect(agentOf(state, KT)).toBe(agentOf(before, KT));
  });

  it("retries an agent that failed while the sweep was still out, leaving the sweep be", () => {
    const before = report(patrolRun(), "granite-chief", "failed", 2000).state;
    const { state } = retryAgents(before, { agentId: GRANITE }, 5000, fresh);
    expect(state.status).toBe("on_the_hill");
    expect(stepOf(state, "sweep")).toEqual(stepOf(before, "sweep"));
    expect(agentOf(state, GRANITE).status).toBe("queued");
  });

  it("counts the attempts across retries", () => {
    let s = retryAgents(failedGranite(), { agentId: GRANITE }, 5000, fresh).state;
    s = onFailure(s, GRANITE, "boom again", 6000).state;
    const { state, effects } = retryAgents(s, { agentId: GRANITE }, 7000, fresh);
    expect(agentOf(state, GRANITE)).toMatchObject({ retries: 2, retriedAt: 7000 });
    expect(effects[0]).toEqual({ type: "log", text: `${GRANITE} retried · attempt 3` });
  });

  it("starts the retried agent's clocks at the retry, not at the run's start", () => {
    const { state } = retryAgents(failedGranite(), { agentId: GRANITE }, 50_000, fresh);
    expect(nextAlarm(state)).toBe(50_000 + STALL_MS);
    expectUnchanged(state, onTick(state, CREATED_AT + STALL_MS));
    const lost = onTick(state, 50_000 + STALL_MS);
    expect(agentOf(lost.state, GRANITE)).toMatchObject({
      status: "error",
      summary: "never dispatched",
    });
  });

  it("sweeps again once the retried agent reports", () => {
    let s = retryAgents(failedGranite(), { agentId: GRANITE }, 5000, fresh).state;
    s = onDispatched(s, GRANITE, 5100).state;
    s = onBriefed(s, GRANITE, 5200, JOB).state;
    const { state, effects } = onVerdict(s, GRANITE, verdictFor("granite-chief"), 6000);
    expect(state.status).toBe("swept");
    expect(stepOf(state, "sweep")).toMatchObject({ status: "done", finishedAt: 6000 });
    expect(reviewOutcome(state)).toBe("clear");
    expect(effectTypes(effects)).toEqual(["log", "index", "broadcast", "check"]);
  });

  describe("retries nothing", () => {
    it.each<[string, () => RunState]>([
      ["when every agent reported a verdict", () => sweptBy("clear", "hazards")],
      ["for an agent still out", () => runningRun()],
      ["for a stopped agent", () => closedAroundStopped()],
      ["once the run is stopped", () => stopRun(failedGranite(), "PR closed", 3000).state],
      ["once the run has landed", () => landRun(failedGranite(), MERGE_SHA, 3000).state],
    ])("%s", (_name, run) => {
      const s = run();
      expectUnchanged(s, retryAgents(s, { step: "sweep" }, 5000, fresh));
      for (const agent of s.agents) {
        expectUnchanged(s, retryAgents(s, { agentId: agent.id }, 5000, fresh));
      }
    });

    it("on another step, or for an agent the run does not have", () => {
      const s = failedGranite();
      expectUnchanged(s, retryAgents(s, { step: "huddle" }, 5000, fresh));
      expectUnchanged(s, retryAgents(s, { agentId: "corduroy-sweep-0" }, 5000, fresh));
    });
  });

  it("retryableAgents names the agents a retry would run", () => {
    const s = sweptBy("failed", "failed");
    expect(retryableAgents(s, { step: "sweep" })).toEqual([GRANITE, KT]);
    expect(retryableAgents(s, { agentId: GRANITE })).toEqual([GRANITE]);
    expect(retryableAgents(stopRun(s, "PR closed", 3000).state, { step: "sweep" })).toEqual([]);
  });
});

describe("onRetitled", () => {
  it("takes the new title, keeping the goal the agents were briefed with", () => {
    const before = runningRun();
    const { state, effects } = onRetitled(before, "orders: cancel endpoint", 3000);
    expect(state).toEqual({ ...before, prTitle: "orders: cancel endpoint", updatedAt: 3000 });
    expect(effects).toEqual([{ type: "index" }, { type: "broadcast" }]);
  });

  it.each<[string, () => RunState]>([
    ["swept", () => sweptBy("clear", "clear")],
    ["stopped", () => stopRun(runningRun(), "PR closed", 2000).state],
    ["landed", landedRun],
  ])("retitles a %s run", (_label, build) =>
    expect(onRetitled(build(), "orders: cancel endpoint", 4000).state.prTitle).toBe(
      "orders: cancel endpoint",
    ));

  it("is a no-op for the title the run already has", () => {
    const s = runningRun();
    expectUnchanged(s, onRetitled(s, s.prTitle, 3000));
  });
});

const lateArrivals: [string, (s: RunState) => Transition][] = [
  ["onDispatched", (s) => onDispatched(s, ID, 9000)],
  ["onBriefed", (s) => onBriefed(s, ID, 9000, JOB)],
  ["onEvents", (s) => onEvents(s, ID, 3, 9000, URL_1)],
  ["onVerdict", (s) => onVerdict(s, ID, hazardVerdict, 9000)],
  ["onFailure", (s) => onFailure(s, ID, "boom", 9000)],
  ["onTick", (s) => onTick(s, BRIEFED_AT + AGENT_TIMEOUT_MS)],
];

describe.each<RunStatus>(["swept", "stopped", "landed", "failed"])("a %s run", (status) => {
  it.each(lateArrivals)("ignores %s", (_name, run) => {
    const s: RunState = { ...runningRun(), status };
    expectUnchanged(s, run(s));
  });
});

describe("an agent that already reported", () => {
  const reported = () =>
    onVerdict(patrolRun(), GRANITE, verdictFor("granite-chief"), 2000).state;

  it.each<[string, (s: RunState) => Transition]>([
    ["a dispatch", (s) => onDispatched(s, GRANITE, 9000)],
    ["a brief", (s) => onBriefed(s, GRANITE, 9000, JOB)],
    ["events", (s) => onEvents(s, GRANITE, 3, 9000, URL_1)],
    ["a verdict", (s) => onVerdict(s, GRANITE, verdictFor("granite-chief", 1), 9000)],
    ["a failure", (s) => onFailure(s, GRANITE, "boom", 9000)],
  ])("ignores %s", (_name, run) => {
    const s = reported();
    expect(s.status).toBe("on_the_hill");
    expectUnchanged(s, run(s));
  });
});

// A stopped agent under a run still on the hill cannot arise from the transitions, so the state is
// built by hand: it pins that every guard, the sweep and the alarm read "stopped" as finished.
describe("an agent that is stopped", () => {
  const graniteStopped = (): RunState => {
    const s = patrolRun();
    const agents = s.agents.map((a) =>
      a.id === GRANITE ? { ...a, status: "stopped" as const } : a,
    );
    return { ...s, agents };
  };

  it.each<[string, (s: RunState) => Transition]>([
    ["a dispatch", (s) => onDispatched(s, GRANITE, 9000)],
    ["a brief", (s) => onBriefed(s, GRANITE, 9000, JOB)],
    ["events", (s) => onEvents(s, GRANITE, 3, 9000, URL_1)],
    ["a verdict", (s) => onVerdict(s, GRANITE, verdictFor("granite-chief", 1), 9000)],
    ["a failure", (s) => onFailure(s, GRANITE, "boom", 9000)],
  ])("ignores %s", (_name, run) => {
    const s = graniteStopped();
    expectUnchanged(s, run(s));
  });

  it("is off the watchdog", () => {
    expect(nextAlarm(graniteStopped())).toBe(KT_DISPATCHED_AT + JOB_START_MS);
    const { state } = onTick(graniteStopped(), DISPATCHED_AT + AGENT_TIMEOUT_MS);
    expect(agentOf(state, GRANITE).status).toBe("stopped");
  });

  it("counts as reported when the sweep closes, though not as a failure", () => {
    const { state, effects } = onVerdict(graniteStopped(), KT, verdictFor("kt-22"), 2000);
    expect(state.status).toBe("swept");
    expect(effects).toContainEqual({ type: "log", text: "all 2 sweeps in · 0 hazards" });
  });
});

describe("an agent the run does not have", () => {
  it.each<[string, (s: RunState) => Transition]>([
    ["onDispatched", (s) => onDispatched(s, "nobody-sweep-0", 9000)],
    ["onBriefed", (s) => onBriefed(s, "nobody-sweep-0", 9000, JOB)],
    ["onEvents", (s) => onEvents(s, "nobody-sweep-0", 3, 9000, URL_1)],
    ["onVerdict", (s) => onVerdict(s, "nobody-sweep-0", clearVerdict, 9000)],
    ["onFailure", (s) => onFailure(s, "nobody-sweep-0", "boom", 9000)],
    ["onTranscript", (s) => onTranscript(s, "nobody-sweep-0")],
  ])("ignores %s", (_name, run) => {
    const s = runningRun();
    expectUnchanged(s, run(s));
  });
});

describe("onTranscript", () => {
  it("marks the agent's transcript stored", () => {
    const { state, effects } = onTranscript(runningRun(), ID);
    expect(agentOf(state).hasTranscript).toBe(true);
    expect(effects).toEqual([{ type: "broadcast" }]);
  });

  it("changes nothing but that flag", () => {
    const before = runningRun();
    const { state } = onTranscript(before, ID);
    expect(state).toEqual({ ...before, agents: [{ ...agentOf(before), hasTranscript: true }] });
  });

  it("is recorded after the run was stopped", () => {
    const stopped = stopRun(runningRun(), "PR closed", 1500).state;
    const { state, effects } = onTranscript(stopped, ID);
    expect(state.status).toBe("stopped");
    expect(agentOf(state)).toMatchObject({ status: "stopped", hasTranscript: true });
    expect(effects).toEqual([{ type: "broadcast" }]);
  });

  it("is recorded after a watchdog timeout", () => {
    const { state, effects } = onTranscript(timedOutRun(), ID);
    expect(state.status).toBe("swept");
    expect(agentOf(state)).toMatchObject({ status: "error", hasTranscript: true });
    expect(effects).toEqual([{ type: "broadcast" }]);
  });

  it("is recorded after the agent's verdict closed the sweep", () => {
    const swept = onVerdict(runningRun(), ID, clearVerdict, 2000).state;
    expect(agentOf(onTranscript(swept, ID).state)).toMatchObject({
      status: "clear",
      hasTranscript: true,
    });
  });

  it("does nothing the second time", () => {
    const stored = onTranscript(runningRun(), ID).state;
    expectUnchanged(stored, onTranscript(stored, ID));
  });
});

describe("nextAlarm", () => {
  it("nextAlarm is the earliest stall or timeout", () =>
    expect(nextAlarm(briefedRun())).toBe(BRIEFED_AT + STALL_MS));

  it("counts the stall from the last event", () => {
    const s = onEvents(briefedRun(), ID, 1, 5000, URL_1).state;
    expect(nextAlarm(s)).toBe(5000 + STALL_MS);
  });

  it("is the timeout when the stall would only come after it", () => {
    const late = onEvents(briefedRun(), ID, 1, BRIEFED_AT + AGENT_TIMEOUT_MS - 1000, URL_1);
    expect(nextAlarm(late.state)).toBe(BRIEFED_AT + AGENT_TIMEOUT_MS);
  });

  it("asks only for the timeout once the agent has stalled", () =>
    expect(nextAlarm(stalledRun())).toBe(BRIEFED_AT + AGENT_TIMEOUT_MS));

  it("takes the earliest across agents", () => {
    expect(nextAlarm(briefedPatrol())).toBe(BRIEFED_AT + STALL_MS);
    const granite = onEvents(briefedPatrol(), GRANITE, 1, 5000, URL_1).state;
    expect(nextAlarm(granite)).toBe(KT_BRIEFED_AT + STALL_MS);
  });

  it("gives an agent that is not yet dispatched until 10 minutes after the run was created", () =>
    expect(nextAlarm(created().state)).toBe(CREATED_AT + STALL_MS));

  it("takes the undispatched agent's deadline when it is the earliest", () =>
    expect(nextAlarm(queuedBesideDispatched())).toBe(CREATED_AT + STALL_MS));

  it("gives a dispatched agent's job 30 minutes to start", () =>
    expect(nextAlarm(dispatchedRun())).toBe(DISPATCHED_AT + JOB_START_MS));

  it("starts the stall and timeout clocks at the brief", () => {
    expect(nextAlarm(briefedRun())).toBe(BRIEFED_AT + STALL_MS);
    expect(nextAlarm(onTick(briefedRun(), BRIEFED_AT + STALL_MS).state)).toBe(
      BRIEFED_AT + AGENT_TIMEOUT_MS,
    );
  });

  it("ignores agents that have reported", () => {
    const reported = onVerdict(briefedPatrol(), GRANITE, verdictFor("granite-chief"), 2000).state;
    expect(nextAlarm(reported)).toBe(KT_BRIEFED_AT + STALL_MS);
  });

  it("is null once a run is stopped", () =>
    expect(nextAlarm(stopRun(runningRun(), "PR closed", 1500).state)).toBeNull());

  it.each<RunStatus>(["swept", "stopped", "landed", "failed"])(
    "is null for a %s run, even with an agent still out",
    (status) => expect(nextAlarm({ ...runningRun(), status })).toBeNull(),
  );

  it("is null for a swept run", () => {
    expect(nextAlarm(onVerdict(runningRun(), ID, clearVerdict, 2000).state)).toBeNull();
    const noFiles: Triage = { ...t, panels: [] };
    expect(nextAlarm(createRun(pr, "r1", noFiles, config, CREATED_AT, counter()).state)).toBeNull();
  });

  it.each<[string, () => RunState]>([
    ["a queued agent", () => created().state],
    ["a queued agent beside a dispatched one", queuedBesideDispatched],
    ["a dispatched agent", dispatchedRun],
    ["a briefed agent", briefedRun],
    ["a running agent", runningRun],
    ["a stalled agent", stalledRun],
    ["two patrollers", patrolRun],
    ["two briefed patrollers", briefedPatrol],
  ])("for %s, nothing is due before the alarm and something is due at it", (_label, build) => {
    const s = build();
    const at = nextAlarm(s);
    if (at === null) throw new Error("expected an alarm");
    expectUnchanged(s, onTick(s, at - 1));
    const fired = onTick(s, at);
    expect(fired.state).not.toBe(s);
    const next = nextAlarm(fired.state);
    expect(next === null || next > at).toBe(true);
  });

  it.each<[string, () => RunState, number[]]>([
    [
      "two dispatched patrollers whose jobs never start",
      patrolRun,
      [DISPATCHED_AT + JOB_START_MS, KT_DISPATCHED_AT + JOB_START_MS],
    ],
    [
      "two briefed patrollers",
      briefedPatrol,
      [
        BRIEFED_AT + STALL_MS,
        KT_BRIEFED_AT + STALL_MS,
        BRIEFED_AT + AGENT_TIMEOUT_MS,
        KT_BRIEFED_AT + AGENT_TIMEOUT_MS,
      ],
    ],
    ["a run nobody dispatched", () => created().state, [CREATED_AT + STALL_MS]],
    [
      "a patroller never dispatched beside one that was",
      queuedBesideDispatched,
      [CREATED_AT + STALL_MS, KT_DISPATCHED_AT + JOB_START_MS],
    ],
  ])("alarms for %s always make progress and end with the run swept", (_label, build, expected) => {
    let s = build();
    const alarms: number[] = [];
    for (let at = nextAlarm(s); at !== null; at = nextAlarm(s)) {
      expect(alarms.length).toBeLessThan(10);
      alarms.push(at);
      const fired = onTick(s, at);
      expect(fired.state).not.toBe(s);
      s = fired.state;
    }
    expect(alarms).toEqual(expected);
    expect(s.status).toBe("swept");
  });
});

describe("snapshotOf", () => {
  const PRIVATE_FIELDS = [
    "installationId",
    "defaultBranch",
    "baseSha",
    "nonces",
    "agentNames",
    "stalledLogged",
    "checkRunId",
    "checkReposts",
    "jobRuns",
  ];

  it("snapshot hides nonces", () =>
    expect(snapshotOf(created().state)).not.toHaveProperty("nonces"));

  // The state's public fields, with the review outcome on the run and on its sweep step.
  const publicOf = (s: RunState, outcome: ReviewOutcome) => ({
    ...Object.fromEntries(Object.entries(s).filter(([key]) => !PRIVATE_FIELDS.includes(key))),
    outcome,
    steps: s.steps.map((step) => (step.id === "sweep" ? { ...step, outcome } : step)),
  });

  it("hides the check run id", () => {
    const s = onCheckCreated(runningRun(), 501).state;
    expect(snapshotOf(s)).not.toHaveProperty("checkRunId");
    expect(snapshotOf(s)).toEqual(publicOf(s, "pending"));
  });

  it("hides an owed repost of the check", () => {
    const s = askCheckRepost(runningRun()).state;
    expect(snapshotOf(s)).not.toHaveProperty("checkReposts");
    expect(snapshotOf(s)).toEqual(publicOf(s, "pending"));
  });

  it("carries exactly the run snapshot fields", () =>
    expect(Object.keys(snapshotOf(created().state)).sort()).toEqual([
      "agents",
      "branch",
      "createdAt",
      "goal",
      "headSha",
      "id",
      "outcome",
      "panels",
      "prNumber",
      "prTitle",
      "prUrl",
      "rating",
      "repo",
      "runName",
      "status",
      "steps",
      "updatedAt",
    ]));

  it("is the run state without its private fields, plus the review outcome", () => {
    const s = runningRun();
    expect(s.jobRuns).toEqual({ [ID]: "1" });
    expect(snapshotOf(s)).toEqual(publicOf(s, "pending"));
  });

  it("carries the merge commit once the run has landed", () => {
    const s = landedRun();
    expect(snapshotOf(s)).toMatchObject({ status: "landed", mergeSha: MERGE_SHA });
    expect(snapshotOf(s)).toEqual(publicOf(s, "clear"));
  });

  it.each<[string, () => RunState, ReviewOutcome]>([
    ["clear", () => sweptBy("clear", "clear"), "clear"],
    ["hazards", () => sweptBy("hazards", "clear"), "hazards"],
    ["failed", () => sweptBy("hazards", "failed"), "failed"],
    ["none", unpatrolled, "none"],
  ])("gives a %s run's outcome to the run and to its sweep step only", (_name, run, outcome) => {
    const s = run();
    expect(reviewOutcome(s)).toBe(outcome);
    expect(snapshotOf(s)).toEqual(publicOf(s, outcome));
  });

  it("does not leak a nonce into the serialized snapshot", () => {
    const sentinel = "nonce-sentinel-9f2c";
    const s = createRun(pr, "r1", t, config, CREATED_AT, () => sentinel).state;
    expect(JSON.stringify(snapshotOf(s))).not.toContain(sentinel);
  });
});

describe("the check run", () => {
  const PUBLIC = "https://b2b.example";
  const DETAILS = `${PUBLIC}/runs/r1`;
  const LINK = `[Open Red Dog Face on the dashboard](${DETAILS})`;
  const checkOf = (s: RunState) => checkRunOf(s, PUBLIC);
  const swept = sweptBy;

  it("is in progress while the run is on the hill", () =>
    expect(checkOf(patrolRun())).toEqual({
      name: "Base to Base",
      details_url: DETAILS,
      status: "in_progress",
      output: {
        title: "Red Dog Face · patrol sweep",
        summary: `0 of 2 patrollers in · 0 hazards · 0 failed\n\n${LINK}`,
      },
    }));

  it.each<[Outcome, Outcome, "success" | "failure", string]>([
    ["clear", "clear", "success", "All clear"],
    ["hazards", "clear", "failure", "2 hazards flagged"],
    ["hazards", "hazards", "failure", "4 hazards flagged"],
    ["failed", "clear", "failure", "Granite Chief failed: boom"],
    ["clear", "failed", "failure", "KT-22 failed: boom"],
    ["failed", "failed", "failure", "Granite Chief failed: boom"],
    // Hazards first: they are what the author has to answer.
    ["failed", "hazards", "failure", "2 hazards flagged · Granite Chief failed: boom"],
  ])("a sweep that ends %s, %s concludes %s: %s", (granite, kt, conclusion, title) => {
    const check = checkOf(swept(granite, kt));
    expect(check).toMatchObject({ status: "completed", conclusion, output: { title } });
    expect(check.details_url).toBe(DETAILS);
  });

  it("counts a single hazard in the singular", () => {
    const s = onVerdict(runningRun(), ID, verdictFor("mainline", 1), 2000).state;
    expect(checkOf(s).output.title).toBe("1 hazard flagged");
  });

  it("names a patroller that timed out", () => {
    expect(checkOf(timedOutRun())).toMatchObject({
      conclusion: "failure",
      output: { title: "Mainline failed: timed out" },
    });
  });

  it("fails a sweep that closed around a stopped patroller", () => {
    const closed = closedAroundStopped();
    expect(closed.status).toBe("swept");
    expect(checkOf(closed)).toMatchObject({
      conclusion: "failure",
      output: { title: "Granite Chief failed: stopped · lost" },
    });
  });

  it("is cancelled when the run is stopped", () =>
    expect(checkOf(stopRun(runningRun(), "PR closed", 1500).state)).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      output: { title: "Stopped" },
    }));

  it("is cancelled when the PR merged before the review finished", () =>
    expect(checkOf(landRun(runningRun(), MERGE_SHA, 1500).state)).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      output: { title: "Merged before the review finished" },
    }));

  it.each<[Outcome, Outcome, "success" | "failure", string]>([
    ["clear", "clear", "success", "All clear"],
    ["hazards", "clear", "failure", "2 hazards flagged"],
    ["clear", "failed", "failure", "KT-22 failed: boom"],
  ])("keeps a %s, %s sweep's %s once the run is stopped or has landed", (...sweep) => {
    const [granite, kt, conclusion, title] = sweep;
    const stopped = stopRun(swept(granite, kt), "PR closed", 3000).state;
    const landed = landRun(swept(granite, kt), MERGE_SHA, 3000).state;
    for (const s of [stopped, landed]) {
      expect(checkOf(s)).toEqual(checkOf(swept(granite, kt)));
      expect(checkOf(s)).toMatchObject({ status: "completed", conclusion, output: { title } });
    }
  });

  it("keeps a neutral review neutral once the run has landed", () =>
    expect(checkOf(landRun(unpatrolled(), MERGE_SHA, 3000).state)).toMatchObject({
      conclusion: "neutral",
    }));

  it("tallies each patroller's report while the sweep is open", () => {
    const s = onVerdict(patrolRun(), GRANITE, verdictFor("granite-chief", 1), 2000).state;
    expect(checkOf(s)).toEqual({
      name: "Base to Base",
      details_url: DETAILS,
      status: "in_progress",
      output: {
        title: "Red Dog Face · patrol sweep",
        summary: [
          "1 of 2 patrollers in · 1 hazard · 0 failed",
          "Granite Chief: 1 found.",
          "**GOAL-1** Hazard 1 — Granite Chief",
          LINK,
        ].join("\n\n"),
      },
    });
  });

  it("is neutral, never a success, for a run with no patroller to wait for", () =>
    expect(checkOf(unpatrolled())).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      output: { title: "No patrollers for this change" },
    }));

  it("fails a failed run", () =>
    expect(checkOf({ ...swept("clear", "clear"), status: "failed" })).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: { title: "Run failed" },
    }));

  it("concludes success exactly when the review outcome is clear", () => {
    const outcomes: Outcome[] = ["clear", "hazards", "failed"];
    const runs = [
      ...outcomes.flatMap((granite) => outcomes.map((kt) => swept(granite, kt))),
      patrolRun(),
      unpatrolled(),
      closedAroundStopped(),
      stopRun(runningRun(), "PR closed", 1500).state,
      timedOutRun(),
      { ...swept("clear", "clear"), status: "failed" as const },
      ...outcomes.map((kt) => stopRun(swept("clear", kt), "PR closed", 3000).state),
      ...outcomes.map((kt) => landRun(swept("clear", kt), MERGE_SHA, 3000).state),
      landRun(runningRun(), MERGE_SHA, 1500).state,
    ];
    for (const s of runs) {
      expect(checkOf(s).conclusion === "success").toBe(reviewOutcome(s) === "clear");
    }
  });

  it("summarizes the Conditions report, then each hazard, then links the dashboard", () =>
    expect(checkOf(swept("hazards", "failed")).output.summary).toBe(
      [
        "Review failed",
        "2 of 2 patrollers in · 2 hazards · 1 failed",
        "Granite Chief: 2 found.",
        "KT-22: boom",
        "**GOAL-1** Hazard 1 — Granite Chief",
        "**GOAL-2** Hazard 2 — Granite Chief",
        LINK,
      ].join("\n\n"),
    ));

  it("caps the summary at 60 000 characters, keeping the link", () => {
    const verdict = verdictFor("mainline", 1);
    const long = { ...verdict, hazards: [{ ...verdict.hazards[0]!, title: "x".repeat(70_000) }] };
    const { summary } = checkOf(onVerdict(runningRun(), ID, long, 2000).state).output;
    expect(summary.length).toBeLessThanOrEqual(60_000);
    expect(summary.endsWith(`…\n\n${LINK}`)).toBe(true);
  });

  // A finished sweep's conclusion stands, whatever becomes of the run.
  it("is mirrored whenever what it shows changes, and only then", () => {
    const mirrored = (transition: Transition) => effectTypes(transition.effects).includes("check");
    expect(mirrored(created())).toBe(true);
    expect(mirrored(onVerdict(runningRun(), ID, clearVerdict, 2000))).toBe(true);
    expect(mirrored(onFailure(runningRun(), ID, "boom", 2000))).toBe(true);
    expect(mirrored(onTick(briefedRun(), BRIEFED_AT + AGENT_TIMEOUT_MS))).toBe(true);
    expect(mirrored(stopRun(runningRun(), "PR closed", 1500))).toBe(true);
    expect(mirrored(landRun(runningRun(), MERGE_SHA, 1500))).toBe(true);
    expect(mirrored(onVerdict(patrolRun(), GRANITE, verdictFor("granite-chief"), 2000))).toBe(
      true,
    );
    expect(mirrored(onFailure(patrolRun(), GRANITE, "boom", 2000))).toBe(true);

    expect(mirrored(onDispatched(created().state, ID, DISPATCHED_AT))).toBe(false);
    expect(mirrored(onBriefed(dispatchedRun(), ID, BRIEFED_AT, JOB))).toBe(false);
    expect(mirrored(onEvents(briefedRun(), ID, 2, 1500, URL_1))).toBe(false);
    expect(mirrored(onTick(briefedRun(), BRIEFED_AT + STALL_MS))).toBe(false);
    expect(mirrored(onTranscript(runningRun(), ID))).toBe(false);
    expect(mirrored(onRetitled(runningRun(), "orders: cancel endpoint", 1600))).toBe(false);
    expect(mirrored(stopRun(sweptBy("clear", "clear"), "PR closed", 3000))).toBe(false);
    expect(mirrored(landRun(sweptBy("clear", "clear"), MERGE_SHA, 3000))).toBe(false);
  });

  describe("onCheckCreated", () => {
    it("keeps the id on the run, changing nothing else", () => {
      const before = runningRun();
      const { state, effects } = onCheckCreated(before, 501);
      expect(state).toEqual({ ...before, checkRunId: 501 });
      expect(effects).toEqual([]);
    });

    it("keeps the first id", () => {
      const s = onCheckCreated(runningRun(), 501).state;
      expectUnchanged(s, onCheckCreated(s, 502));
    });

    it("keeps the id of a run that has ended", () => {
      const stopped = stopRun(runningRun(), "PR closed", 1500).state;
      expect(onCheckCreated(stopped, 501).state.checkRunId).toBe(501);
    });

    // Its create may have been sent before the ask, so it is not the repost.
    it("leaves a repost owed", () => {
      const asked = askCheckRepost(runningRun()).state;
      expect(onCheckCreated(asked, 501).state).toEqual({ ...asked, checkRunId: 501 });
    });
  });

  // A run stopped on the head may have posted its check after this run's, and GitHub reads the
  // newest check run of a name.
  describe("askCheckRepost", () => {
    it("owes a fresh check run, taking no clock", () => {
      const before = onCheckCreated(runningRun(), 501).state;
      const { state, effects } = askCheckRepost(before);
      expect(state).toEqual({ ...before, checkReposts: 1 });
      expect(effects).toEqual([{ type: "check" }]);
    });

    it("counts an ask that comes while a repost is owed", () =>
      expect(askCheckRepost(askCheckRepost(runningRun()).state).state.checkReposts).toBe(2));

    it("asks for a swept run's", () =>
      expect(askCheckRepost(swept("clear", "clear")).effects).toEqual([{ type: "check" }]));

    it.each<[string, () => RunState]>([
      ["stopped", () => stopRun(runningRun(), "PR closed", 2000).state],
      ["landed", landedRun],
    ])("asks nothing of a %s run", (_label, build) => {
      const s = build();
      expectUnchanged(s, askCheckRepost(s));
    });
  });

  describe("onCheckReposted", () => {
    it("takes the new id and settles the repost it made", () => {
      const before = onCheckCreated(runningRun(), 501).state;
      const { state, effects } = onCheckReposted(askCheckRepost(before).state, 502, 1);
      expect(state).toEqual({ ...before, checkRunId: 502 });
      expect(effects).toEqual([]);
    });

    it("leaves owed an ask that came after the repost read the run", () => {
      const twice = askCheckRepost(askCheckRepost(runningRun()).state).state;
      expect(onCheckReposted(twice, 502, 1).state).toMatchObject({
        checkRunId: 502,
        checkReposts: 2,
      });
    });
  });

  // Created now, a cancelled check could be newer on the head than the check of the run that
  // replaced this one.
  describe("wantsCheck", () => {
    const stopped = (s: RunState) => stopRun(s, "superseded by 9f8e7d6", 2000).state;
    const withCheck = () => onCheckCreated(runningRun(), 501).state;
    it.each<[string, boolean, () => RunState]>([
      ["a run on the hill", true, runningRun],
      ["a review stopped after its check was created", true, () => stopped(withCheck())],
      ["a review stopped before its check was created", false, () => stopped(runningRun())],
      [
        "a review landed before its check was created",
        false,
        () => landRun(runningRun(), MERGE_SHA, 2000).state,
      ],
      [
        "a finished sweep stopped before its check was created",
        true,
        () => stopped(swept("clear", "clear")),
      ],
    ])("%s: %s", (_label, wanted, build) => expect(wantsCheck(build())).toBe(wanted));
  });

  it("marks a replaced check run skipped, linking the run", () =>
    expect(replacedCheckOf(runningRun(), PUBLIC)).toEqual({
      name: "Base to Base",
      details_url: DETAILS,
      status: "completed",
      conclusion: "skipped",
      output: {
        title: "Replaced by a newer check run",
        summary: `Red Dog Face posted its check again on this commit.\n\n${LINK}`,
      },
    }));
});

describe("briefOf", () => {
  it("gives the agent its roster identity, the goal and the commits", () => {
    const s = created().state;
    expect(briefOf(s, ID, config)).toEqual({
      role: "mainline",
      name: "Mainline",
      model: rosterEntry(config, "mainline").model,
      prefix: "FUN",
      goal: "orders: add cancel endpoint\n\nLet a customer cancel their own pending order.",
      prNumber: 58,
      baseSha: "base58",
      headSha: "head58",
    });
  });

  it("briefs each agent from its own roster entry", () => {
    const s = patrolRun();
    expect(briefOf(s, GRANITE, PATROL)).toMatchObject({ role: "granite-chief", prefix: "GOAL" });
    expect(briefOf(s, KT, PATROL)).toMatchObject({ role: "kt-22", name: "KT-22", prefix: "SEC" });
  });

  it("throws for an agent the run does not have", () =>
    expect(() => briefOf(created().state, "nobody-sweep-0", config)).toThrow(/nobody-sweep-0/));
});

describe("purity", () => {
  afterEach(() => vi.restoreAllMocks());

  const changing: [
    name: string,
    input: RunState,
    now: number,
    run: (s: RunState, now: number) => Transition,
  ][] = [
    ["onDispatched", created().state, 4000, (s, now) => onDispatched(s, ID, now)],
    ["onBriefed", dispatchedRun(), 4000, (s, now) => onBriefed(s, ID, now, JOB)],
    ["onBriefed again", runningRun(), 4000, (s, now) => onBriefed(s, ID, now, JOB)],
    ["onEvents", briefedRun(), 4000, (s, now) => onEvents(s, ID, 2, now, URL_1)],
    ["onVerdict", runningRun(), 4000, (s, now) => onVerdict(s, ID, hazardVerdict, now)],
    ["onFailure", runningRun(), 4000, (s, now) => onFailure(s, ID, "boom", now)],
    ["onTick stalling", briefedRun(), BRIEFED_AT + STALL_MS, (s, now) => onTick(s, now)],
    [
      "onTick timing out",
      stalledRun(),
      BRIEFED_AT + AGENT_TIMEOUT_MS,
      (s, now) => onTick(s, now),
    ],
    [
      "onTick failing a job that never started",
      dispatchedRun(),
      DISPATCHED_AT + JOB_START_MS,
      (s, now) => onTick(s, now),
    ],
    [
      "onTick failing an undispatched agent",
      created().state,
      CREATED_AT + STALL_MS,
      (s, now) => onTick(s, now),
    ],
    ["stopRun", runningRun(), 4000, (s, now) => stopRun(s, "PR closed", now)],
    [
      "stopRun with a queued agent",
      queuedBesideDispatched(),
      4000,
      (s, now) => stopRun(s, "PR closed", now),
    ],
    ["stopRun of a swept run", sweptBy("clear", "clear"), 4000, (s, now) => stopRun(s, "x", now)],
    ["landRun", runningRun(), 4000, (s, now) => landRun(s, MERGE_SHA, now)],
    [
      "landRun of a swept run",
      sweptBy("clear", "clear"),
      4000,
      (s, now) => landRun(s, MERGE_SHA, now),
    ],
    ["onRetitled", runningRun(), 4000, (s, now) => onRetitled(s, "orders: cancel", now)],
    [
      "retryAgents",
      sweptBy("failed", "clear"),
      4000,
      (s, now) => retryAgents(s, { step: "sweep" }, now, () => "fresh"),
    ],
  ];

  it.each(changing)("%s changes the state without touching its input", (_n, input, now, run) => {
    const frozen = deepFreeze(structuredClone(input));
    const before = structuredClone(frozen);
    const { state } = run(frozen, now);
    expect(frozen).toEqual(before);
    expect(state).not.toEqual(before);
  });

  it.each(changing)("%s stamps updatedAt with now", (_n, input, now, run) => {
    expect(run(input, now).state.updatedAt).toBe(now);
  });

  it("onTranscript changes the state without touching its input", () => {
    const frozen = deepFreeze(structuredClone(runningRun()));
    const before = structuredClone(frozen);
    const { state } = onTranscript(frozen, ID);
    expect(frozen).toEqual(before);
    expect(state).not.toEqual(before);
  });

  it("createRun leaves the pull request, triage and config untouched", () => {
    const frozenPr = deepFreeze(structuredClone(pr));
    const frozenTriage = deepFreeze(structuredClone(t));
    const frozenConfig = deepFreeze(structuredClone(config));
    const { state } = createRun(frozenPr, "r1", frozenTriage, frozenConfig, CREATED_AT, counter());
    expect(state.agents).toHaveLength(1);
  });

  it("neither reads the clock nor mints randomness, and repeats exactly", () => {
    const walk = (): unknown => {
      let s = createRun(pr, "r1", t, PATROL, CREATED_AT, counter()).state;
      s = onDispatched(onDispatched(s, GRANITE, DISPATCHED_AT).state, KT, KT_DISPATCHED_AT).state;
      s = onBriefed(onBriefed(s, GRANITE, BRIEFED_AT, JOB).state, KT, KT_BRIEFED_AT, KT_JOB).state;
      s = onEvents(s, GRANITE, 2, 1500, URL_1).state;
      s = onTick(s, KT_BRIEFED_AT + STALL_MS).state;
      s = onTranscript(s, KT).state;
      s = onRetitled(s, "orders: cancel", 1900).state;
      s = onVerdict(s, GRANITE, verdictFor("granite-chief", 1), 2000).state;
      nextAlarm(s);
      briefOf(s, KT, PATROL);
      checkRunOf(s, "https://b2b.example");
      const stopped = stopRun(s, "PR closed", 2200).state;
      const landed = landRun(s, MERGE_SHA, 2300).state;
      s = onFailure(s, KT, "boom", 2500).state;
      return [snapshotOf(s), snapshotOf(stopped), snapshotOf(landed)];
    };
    const clock = vi.spyOn(Date, "now");
    const uuid = vi.spyOn(crypto, "randomUUID");
    const random = vi.spyOn(Math, "random");
    const first = walk();
    const second = walk();
    expect([clock, uuid, random].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    expect(second).toEqual(first);
  });
});

describe("a whole run", () => {
  it("walks from lift line to swept", () => {
    let s = created().state;
    s = onDispatched(s, ID, DISPATCHED_AT).state;
    s = onBriefed(s, ID, BRIEFED_AT, JOB).state;
    s = onEvents(s, ID, 4, 1500, URL_1).state;
    s = onTick(s, 1500 + STALL_MS).state;
    s = onEvents(s, ID, 2, 1500 + STALL_MS + 1000, URL_2).state;
    s = onTranscript(s, ID).state;
    s = onVerdict(s, ID, hazardVerdict, 700_000).state;

    expect(snapshotOf(s)).toMatchObject({
      status: "swept",
      createdAt: CREATED_AT,
      updatedAt: 700_000,
    });
    expect(s.steps.map((step) => step.status)).toEqual([
      "done",
      "done",
      "done",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(agentOf(s)).toEqual({
      id: ID,
      role: "mainline",
      step: "sweep",
      round: 0,
      status: "hazards",
      dispatchedAt: DISPATCHED_AT,
      briefedAt: BRIEFED_AT,
      lastEventAt: 1500 + STALL_MS + 1000,
      finishedAt: 700_000,
      jobUrl: URL_1,
      hasTranscript: true,
      summary: "2 found.",
      hazards: hazardVerdict.hazards,
    });
    expect(nextAlarm(s)).toBeNull();
  });
});
