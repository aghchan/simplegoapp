import { DurableObject } from "cloudflare:workers";
import { config } from "../../../shared/src/config.ts";
import type { Triage } from "../../../shared/src/triage.ts";
import type {
  AgentBrief,
  AgentEvent,
  AgentStatus,
  EventKind,
  LiveMessage,
  LogLine,
  RunSnapshot,
  Verdict,
} from "../../../shared/src/types.ts";
import { parseVerdict, VerdictError } from "../../../shared/src/verdict.ts";
import { createGitHubClient, type GitHubClient } from "../github/client.ts";
import type { PullRequestRef } from "../github/webhook.ts";
import { announce } from "../lobby/do.ts";
import { summaryOf, upsertRun } from "../runs/index.ts";
import {
  askCheckRepost,
  briefOf,
  checkRunOf,
  createRun,
  landRun,
  nextAlarm,
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
  snapshotOf,
  stopRun,
  wantsCheck,
  type Effect,
  type RunState,
  type Transition,
} from "./machine.ts";

const STATE_KEY = "state";
// Marks for the index and check writes a commit owes, stored with its state. Each holds the
// commit's revision, so a write that lands after a newer commit leaves that commit's mark set.
const INDEX_PENDING_KEY = "indexPending";
const CHECK_PENDING_KEY = "checkPending";
const RETRY_MS = 60_000;
const LOG_TEXT_MAX = 2000;
const SNAPSHOT_LOG_LINES = 500;

// A mapped copy, because an interface does not satisfy the SQL row type's index signature.
type LogRow = Pick<LogLine, keyof LogLine>;

// The run was stopped or the agent has already finished, so nothing more it sends will be used.
// The agent's status decides the colour of its job.
export type Gone = { gone: AgentStatus };

// What became of an agent's report.
export type Report = "accepted" | "forbidden" | Gone;

// Owns one run: persists the machine's state, executes the effects it returns, and keeps the log.
export class RunDO extends DurableObject<Env> {
  // Check syncs run one at a time: two creates in flight together would post two check runs.
  private checkSyncs: Promise<void> = Promise.resolve();
  // Check syncs this instance has yet to finish: a commit's own, until its effects are done, and a
  // retry's. While one is owed a retry is not needed, and would wait on GitHub behind it.
  private checksOwed = 0;

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

  // The brief for a job GitHub has started, whose clocks start here; a refusal for a runner that
  // should not start, because it has the wrong nonce or the agent no longer matters.
  async brief(
    agentId: string,
    nonce: string,
    job: { githubRunId: string; jobUrl: string },
  ): Promise<AgentBrief | "forbidden" | Gone> {
    const admitted = await this.admit(agentId, nonce);
    if (admitted === "forbidden" || "gone" in admitted) return admitted;
    await this.step((s, now) => onBriefed(s, agentId, now, job));
    return briefOf(admitted, agentId, config);
  }

  async events(
    agentId: string,
    nonce: string,
    events: AgentEvent[],
    jobUrl: string,
  ): Promise<Report> {
    const admitted = await this.admit(agentId, nonce);
    if (admitted === "forbidden" || "gone" in admitted) return admitted;
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
    if (state === "forbidden" || "gone" in state) return state;
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

  // `jobUrl`: the job that reported it, which may never have asked for its brief.
  async failure(agentId: string, nonce: string, reason: string, jobUrl?: string): Promise<Report> {
    const admitted = await this.admit(agentId, nonce);
    if (admitted === "forbidden" || "gone" in admitted) return admitted;
    await this.step((s, now) => onFailure(s, agentId, reason, now, jobUrl));
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

  async land(mergeSha: string): Promise<void> {
    await this.step((s, now) => landRun(s, mergeSha, now));
  }

  async retitle(title: string): Promise<void> {
    await this.step((s, now) => onRetitled(s, title, now));
  }

  // For reconcilePr, once it has stopped a run on this run's head: this run's check must be the
  // newest there.
  async repostCheck(): Promise<void> {
    await this.step(askCheckRepost);
  }

  async view(): Promise<{ run: RunSnapshot; log: LogLine[] } | null> {
    await this.retryPending();
    const state = await this.load();
    return state ? { run: snapshotOf(state), log: this.recentLog() } : null;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    await this.retryPending();
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
  private async admit(agentId: string, nonce: string): Promise<RunState | "forbidden" | Gone> {
    if (!(await this.authorize(agentId, nonce))) return "forbidden";
    await this.retryPending();
    // Reread: a stop may have landed while the nonce check or the index write awaited.
    const state = await this.loaded();
    if (acceptsReports(state, agentId)) return state;
    // The nonce matched, so the run has the agent.
    return { gone: state.agents.find((agent) => agent.id === agentId)!.status };
  }

  // Applies one machine step to the stored state. It rereads first: anything that awaited I/O
  // since the caller last looked (a dispatch call, a D1 write) may have changed the run.
  private async step(next: (state: RunState, now: number) => Transition): Promise<void> {
    await this.retryPending();
    const state = await this.load();
    if (!state) return;
    const transition = next(state, Date.now());
    if (transition.state !== state) await this.commit(transition);
  }

  // The state goes in with the marks for the writes it owes, and the alarm is armed before any
  // is made, so a reset at any point leaves them to be retried.
  private async commit({ state, effects }: Transition): Promise<void> {
    const revision = crypto.randomUUID();
    const owes = (type: Effect["type"]) => effects.some((effect) => effect.type === type);
    const owesCheck = owes("check");
    if (owesCheck) this.checksOwed++;
    try {
      await this.ctx.storage.put({
        [STATE_KEY]: state,
        ...(owes("index") ? { [INDEX_PENDING_KEY]: revision } : {}),
        ...(owesCheck ? { [CHECK_PENDING_KEY]: revision } : {}),
      });
      // Before the effects: one may commit a newer state, whose alarm must be the one left set.
      await this.arm(state);
      for (const effect of effects) await this.execute(effect);
    } finally {
      if (owesCheck) this.checksOwed--;
    }
  }

  // The machine's next deadline, pulled in to the retry delay while an index or check write is
  // outstanding.
  private async arm(state: RunState): Promise<void> {
    const pending =
      (await this.ctx.storage.get(INDEX_PENDING_KEY)) ||
      (await this.ctx.storage.get(CHECK_PENDING_KEY));
    const retryAt = pending ? Date.now() + RETRY_MS : null;
    const times = [nextAlarm(state), retryAt].filter((time) => time !== null);
    if (times.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...times));
  }

  // Writes the run's index row while a mark says one is owed. Once a run is over nothing else
  // would write it again, so the mark stays until the row and the lobby's copy of it have gone
  // out; the alarm and the next call into the run retry it.
  private async index(): Promise<void> {
    // Read before the state: a commit after this read sets the mark again.
    const revision = await this.ctx.storage.get(INDEX_PENDING_KEY);
    if (revision === undefined) return;
    const snapshot = snapshotOf(await this.loaded());
    try {
      await upsertRun(this.env.DB, snapshot);
      // An open runs list hears of the run only from the lobby.
      if (await announce(this.env, summaryOf(snapshot))) {
        await this.settle(INDEX_PENDING_KEY, revision);
      }
    } catch (error) {
      console.error(`run index write failed: ${error instanceof Error ? error.message : error}`);
    }
    await this.arm(await this.loaded());
  }

  // Clears a mark once its write has gone out, unless a newer commit has set it since.
  private async settle(key: string, revision: unknown): Promise<void> {
    if ((await this.ctx.storage.get(key)) === revision) await this.ctx.storage.delete(key);
  }

  private async retryPending(): Promise<void> {
    await this.index();
    await this.retryCheck();
  }

  private async retryCheck(): Promise<void> {
    if ((await this.ctx.storage.get(CHECK_PENDING_KEY)) === undefined || this.checksOwed > 0) {
      return;
    }
    this.checksOwed++;
    try {
      await this.queueCheck(() => this.syncCheck());
    } finally {
      this.checksOwed--;
    }
  }

  private queueCheck(task: () => Promise<void>): Promise<void> {
    const done = this.checkSyncs.then(task);
    // A task that throws must not stall the ones queued behind it.
    this.checkSyncs = done.catch(() => {});
    return done;
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
      case "check":
        await this.queueCheck(() => this.syncCheck());
        return;
      case "cancel":
        await this.cancel(effect.agentId);
        return;
    }
  }

  // Sends the run's current state to its check run, creating it the first time, while a mark says
  // a sync is owed. Like the index, the mark stays until GitHub has taken the write, and the alarm
  // or the next call into the run retries it: the last change of a run has no later check effect
  // to send it.
  private async syncCheck(): Promise<void> {
    const revision = await this.ctx.storage.get(CHECK_PENDING_KEY);
    if (revision === undefined) return;
    try {
      const state = await this.loaded();
      if (wantsCheck(state)) await this.writeCheck(state);
      await this.settle(CHECK_PENDING_KEY, revision);
    } catch (error) {
      // The client's messages carry a status and path only, never a token or key.
      console.error(`check run: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.arm(await this.loaded());
  }

  // Updates the check run, or creates it: the first time, and afresh for a repost, after which the
  // old one is marked replaced.
  private async writeCheck(state: RunState): Promise<void> {
    const body = checkRunOf(state, this.env.PUBLIC_URL);
    const github = this.github(state);
    const { checkRunId: old, checkReposts: asked } = state;
    if (old !== undefined && asked === undefined) {
      await github.updateCheckRun(state.repo, old, body);
      return;
    }
    const id = await github.createCheckRun(state.repo, { ...body, head_sha: state.headSha });
    const current = await this.loaded();
    const created =
      asked === undefined ? onCheckCreated(current, id) : onCheckReposted(current, id, asked);
    // Stored as is: the id has no effects to run, and nothing a viewer sees changes.
    await this.ctx.storage.put(STATE_KEY, created.state);
    if (old === undefined) return;
    // Best effort, never retried: GitHub reads only the newest check run.
    try {
      await github.updateCheckRun(state.repo, old, replacedCheckOf(state, this.env.PUBLIC_URL));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      console.error(`replaced check run: ${why}`);
    }
  }

  // Best effort, never retried: a job the cancel misses stops on the 410 its next report gets.
  private async cancel(agentId: string): Promise<void> {
    const state = await this.loaded();
    const githubRunId = state.jobRuns?.[agentId];
    if (githubRunId === undefined) return;
    try {
      await this.github(state).cancelWorkflowRun(this.env.REPO, githubRunId);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      console.error(`cancelling ${agentId}'s job: ${why}`);
    }
  }

  // Built for each call, inside the caller's try: the factory throws on a key it cannot use.
  private github(state: RunState): GitHubClient {
    return createGitHubClient({
      appId: this.env.GITHUB_APP_ID,
      privateKeyPem: this.env.GITHUB_APP_PRIVATE_KEY,
      installationId: state.installationId,
      fetch: (input, init) => fetch(input, init),
      apiBase: this.env.GITHUB_API,
    });
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
      const github = this.github(state);
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
