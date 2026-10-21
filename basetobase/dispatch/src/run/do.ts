import { DurableObject } from "cloudflare:workers";
import { config } from "../../../shared/src/config.ts";
import type { Triage } from "../../../shared/src/triage.ts";
import type {
  AgentBrief,
  AgentEvent,
  EventKind,
  LiveMessage,
  LogLine,
  RunSnapshot,
  Verdict,
} from "../../../shared/src/types.ts";
import { parseVerdict, VerdictError } from "../../../shared/src/verdict.ts";
import { createGitHubClient } from "../github/client.ts";
import type { PullRequestRef } from "../github/webhook.ts";
import { upsertRun } from "../runs/index.ts";
import {
  briefOf,
  createRun,
  nextAlarm,
  onDispatched,
  onEvents,
  onFailure,
  onTick,
  onTranscript,
  onVerdict,
  snapshotOf,
  stopRun,
  type Effect,
  type RunState,
  type Transition,
} from "./machine.ts";

const STATE_KEY = "state";
const INDEX_PENDING_KEY = "indexPending";
const INDEX_RETRY_MS = 60_000;
const LOG_TEXT_MAX = 2000;
const SNAPSHOT_LOG_LINES = 500;

// A mapped copy, because an interface does not satisfy the SQL row type's index signature.
type LogRow = Pick<LogLine, keyof LogLine>;

// What became of an agent's report. "gone": the run was stopped or the agent has already finished,
// so nothing more it sends will be used.
export type Report = "accepted" | "forbidden" | "gone";

// Owns one run: persists the machine's state, executes the effects it returns, and keeps the log.
export class RunDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT,
           agent_seq INTEGER, ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
           UNIQUE(agent_id, agent_seq))`,
      );
    });
  }

  async start(pr: PullRequestRef, runId: string, t: Triage): Promise<RunSnapshot> {
    await this.commit(createRun(pr, runId, t, config, Date.now(), () => crypto.randomUUID()));
    return snapshotOf(await this.loaded());
  }

  // The nonce alone, with no state change and no regard for how the run or agent is doing: unlike
  // brief(), it still answers for a stopped run, whose agents may yet upload a transcript.
  async checkNonce(agentId: string, nonce: string): Promise<boolean> {
    return (await this.authorize(agentId, nonce)) !== undefined;
  }

  // Null for a runner that should not start: it has the wrong nonce or the agent no longer matters.
  async brief(agentId: string, nonce: string): Promise<AgentBrief | null> {
    const state = await this.admit(agentId, nonce);
    return typeof state === "string" ? null : briefOf(state, agentId, config);
  }

  async events(
    agentId: string,
    nonce: string,
    events: AgentEvent[],
    jobUrl: string,
  ): Promise<Report> {
    const admitted = await this.admit(agentId, nonce);
    if (typeof admitted === "string") return admitted;
    const lines = events.flatMap((event) => {
      const line = this.appendLog({
        agentId,
        agentSeq: event.seq,
        ts: event.ts,
        kind: event.kind,
        text: event.text,
      });
      return line ? [line] : [];
    });
    // Ahead of the broadcast: a retry would dedupe to nothing, so this transition cannot be redone.
    await this.step((s, now) => onEvents(s, agentId, lines.length, now, jobUrl));
    if (lines.length > 0) this.broadcast({ type: "log", lines });
    return "accepted";
  }

  // `invalid` carries why the verdict failed validation; the agent is failed with that reason.
  async verdict(
    agentId: string,
    nonce: string,
    raw: unknown,
  ): Promise<Report | { invalid: string }> {
    const state = await this.admit(agentId, nonce);
    if (typeof state === "string") return state;
    const { role, prefix, headSha } = briefOf(state, agentId, config);
    let verdict: Verdict;
    try {
      verdict = parseVerdict(raw, { role, prefix, headSha });
    } catch (error) {
      if (!(error instanceof VerdictError)) throw error;
      await this.step((s, now) => onFailure(s, agentId, `invalid verdict: ${error.message}`, now));
      return { invalid: error.message };
    }
    await this.step((s, now) => onVerdict(s, agentId, verdict, now));
    return "accepted";
  }

  async failure(agentId: string, nonce: string, reason: string): Promise<Report> {
    const admitted = await this.admit(agentId, nonce);
    if (typeof admitted === "string") return admitted;
    await this.step((s, now) => onFailure(s, agentId, reason, now));
    return "accepted";
  }

  async transcriptStored(agentId: string, nonce: string): Promise<boolean> {
    if (!(await this.authorize(agentId, nonce))) return false;
    await this.step((s) => onTranscript(s, agentId));
    return true;
  }

  async stop(reason: string): Promise<void> {
    await this.step((s, now) => stopRun(s, reason, now));
  }

  async view(): Promise<{ run: RunSnapshot; log: LogLine[] } | null> {
    await this.retryIndex();
    const state = await this.load();
    return state ? { run: snapshotOf(state), log: this.recentLog() } : null;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    await this.retryIndex();
    const state = await this.load();
    if (!state) return new Response("no such run", { status: 404 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const snapshot: LiveMessage = {
      type: "snapshot",
      run: snapshotOf(state),
      log: this.recentLog(),
    };
    server.send(JSON.stringify(snapshot));
    return new Response(null, { status: 101, webSocket: client });
  }

  // Dashboard sockets only listen: whatever a viewer sends is dropped.
  webSocketMessage(): void {}

  async alarm(): Promise<void> {
    await this.step(onTick);
  }

  private async load(): Promise<RunState | undefined> {
    return this.ctx.storage.get<RunState>(STATE_KEY);
  }

  private async loaded(): Promise<RunState> {
    const state = await this.load();
    if (!state) throw new Error("the run has not started");
    return state;
  }

  // The state if the nonce matches; the nonce is all that proves a caller is the agent.
  private async authorize(agentId: string, nonce: string): Promise<RunState | undefined> {
    const state = await this.load();
    if (!state) return undefined;
    const expected = Object.hasOwn(state.nonces, agentId) ? state.nonces[agentId] : undefined;
    // Compared even for an unknown agent, so timing does not tell which agent ids exist.
    const same = await sameSecret(expected ?? "", nonce);
    return expected !== undefined && same ? state : undefined;
  }

  // The run, if the caller is the agent and the run still wants its reports.
  private async admit(agentId: string, nonce: string): Promise<RunState | "forbidden" | "gone"> {
    if (!(await this.authorize(agentId, nonce))) return "forbidden";
    await this.retryIndex();
    // Reread: a stop may have landed while the nonce check or the index write awaited.
    const state = await this.loaded();
    return acceptsReports(state, agentId) ? state : "gone";
  }

  // Applies one machine step to the stored state. It rereads first: anything that awaited I/O
  // since the caller last looked (a dispatch call, a D1 write) may have changed the run.
  private async step(next: (state: RunState, now: number) => Transition): Promise<void> {
    await this.retryIndex();
    const state = await this.load();
    if (!state) return;
    const transition = next(state, Date.now());
    if (transition.state !== state) await this.commit(transition);
  }

  private async commit({ state, effects }: Transition): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
    // Before the effects: one may commit a newer state, whose alarm must be the one left set.
    await this.arm(state);
    for (const effect of effects) await this.execute(effect);
  }

  // The machine's next deadline, pulled in to the retry delay while an index write is outstanding.
  private async arm(state: RunState): Promise<void> {
    const retryAt = (await this.ctx.storage.get(INDEX_PENDING_KEY))
      ? Date.now() + INDEX_RETRY_MS
      : null;
    const times = [nextAlarm(state), retryAt].filter((time) => time !== null);
    if (times.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...times));
  }

  // Once a run is over nothing else would write its index row again, so a failed write is
  // remembered and retried by the alarm and by the next call into the run.
  private async index(): Promise<void> {
    const state = await this.loaded();
    // Cleared before the write and set again if it fails: a failure overlapping another write
    // is never forgotten.
    await this.ctx.storage.delete(INDEX_PENDING_KEY);
    try {
      await upsertRun(this.env.DB, snapshotOf(state));
    } catch (error) {
      console.error(`run index write failed: ${error instanceof Error ? error.message : error}`);
      await this.ctx.storage.put(INDEX_PENDING_KEY, true);
    }
    await this.arm(await this.loaded());
  }

  private async retryIndex(): Promise<void> {
    if (await this.ctx.storage.get(INDEX_PENDING_KEY)) await this.index();
  }

  private async execute(effect: Effect): Promise<void> {
    switch (effect.type) {
      case "dispatch":
        await this.dispatch(effect.agentId);
        return;
      case "log": {
        const line = this.appendLog({
          agentId: null,
          agentSeq: null,
          ts: Date.now(),
          kind: "system",
          text: effect.text,
        });
        if (line) this.broadcast({ type: "log", lines: [line] });
        return;
      }
      case "index":
        await this.index();
        return;
      case "broadcast":
        this.broadcast({ type: "run", run: snapshotOf(await this.loaded()) });
        return;
    }
  }

  private async dispatch(agentId: string): Promise<void> {
    const failure = await this.startWorkflow(await this.loaded(), agentId);
    await this.step((s, now) =>
      failure === undefined ? onDispatched(s, agentId, now) : onFailure(s, agentId, failure, now),
    );
  }

  // The failure reason, or undefined once GitHub accepted the dispatch.
  private async startWorkflow(state: RunState, agentId: string): Promise<string | undefined> {
    try {
      // Built here because the factory throws on a key it cannot use.
      const github = createGitHubClient({
        appId: this.env.GITHUB_APP_ID,
        privateKeyPem: this.env.GITHUB_APP_PRIVATE_KEY,
        installationId: state.installationId,
        fetch: (input, init) => fetch(input, init),
        apiBase: this.env.GITHUB_API,
      });
      await github.dispatchWorkflow(this.env.REPO, this.env.AGENT_WORKFLOW, state.defaultBranch, {
        run_id: state.id,
        agent_id: agentId,
        // createRun mints a nonce for every agent.
        nonce: state.nonces[agentId]!,
        sha: state.headSha,
      });
      return undefined;
    } catch (error) {
      return `dispatch failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // The stored line, or undefined when the agent's seq is already in the log.
  private appendLog(line: {
    agentId: string | null;
    agentSeq: number | null;
    ts: number;
    kind: EventKind;
    text: string;
  }): LogLine | undefined {
    const text = line.text.slice(0, LOG_TEXT_MAX);
    const [row] = this.ctx.storage.sql
      .exec<{ id: number }>(
        `INSERT OR IGNORE INTO log (agent_id, agent_seq, ts, kind, text)
         VALUES (?, ?, ?, ?, ?) RETURNING id`,
        line.agentId,
        line.agentSeq,
        line.ts,
        line.kind,
        text,
      )
      .toArray();
    return row && { id: row.id, agentId: line.agentId, ts: line.ts, kind: line.kind, text };
  }

  private recentLog(): LogLine[] {
    return this.ctx.storage.sql
      .exec<LogRow>(
        `SELECT id, agent_id AS agentId, ts, kind, text
         FROM (SELECT * FROM log ORDER BY id DESC LIMIT ?) ORDER BY id`,
        SNAPSHOT_LOG_LINES,
      )
      .toArray();
  }

  private broadcast(message: LiveMessage): void {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      try {
        socket.send(payload);
      } catch {
        // A viewer whose socket is closing must not fail the run's own work.
      }
    }
  }
}

// An agent still owes the run a report exactly when the machine would act on a failure from it.
function acceptsReports(state: RunState, agentId: string): boolean {
  return onFailure(state, agentId, "", 0).state !== state;
}

// HMACs both values under a throwaway key so the comparison covers equal-length digests whatever
// the lengths of the inputs, then compares them without an early exit.
async function sameSecret(a: string, b: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all(
    [a, b].map((value) => crypto.subtle.sign("HMAC", key, encoder.encode(value))),
  );
  return crypto.subtle.timingSafeEqual(x!, y!);
}
