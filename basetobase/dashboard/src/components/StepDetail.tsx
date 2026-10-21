import { useMemo, useState } from "react";
import { formatDuration } from "../../../shared/src/format.ts";
import { STEP_LABELS, STEP_ORDER } from "../../../shared/src/labels.ts";
import type {
  AgentSnapshot,
  LogLine,
  RunSnapshot,
  StepId,
  StepSnapshot,
} from "../../../shared/src/types.ts";
import { GithubLink } from "./GithubLink.tsx";
import { PatrolCards, patroller } from "./PatrolCards.tsx";
import { timeOnStep } from "./PipelineRow.tsx";
import { RadioLog } from "./RadioLog.tsx";
import { Transcript } from "./Transcript.tsx";

// A patroller's lines belong to its step. Dispatch's belong to the latest step that had begun by
// then; a line older than every step goes to the earliest, so none is left out of all of them.
function linesOfStep(run: RunSnapshot, log: LogLine[], stepId: StepId): LogLine[] {
  const stepOfAgent = new Map(run.agents.map((agent) => [agent.id, agent.step]));
  const begun = STEP_ORDER.flatMap((id) => {
    const startedAt = run.steps.find((s) => s.id === id)?.startedAt;
    return startedAt === undefined ? [] : [{ id, startedAt }];
  });
  const stepAt = (ts: number) => (begun.findLast((s) => s.startedAt <= ts) ?? begun[0])?.id;
  return log.filter((line) => {
    const own = line.agentId === null ? undefined : stepOfAgent.get(line.agentId);
    return (own ?? stepAt(line.ts)) === stepId;
  });
}

function TimeOnStep({ step, now }: { step: StepSnapshot; now: number }) {
  const took = <span className="mono">{formatDuration(timeOnStep(step, now))}</span>;
  switch (step.status) {
    case "pending":
      return <p className="step-time">Not started yet</p>;
    case "active":
      return (
        <p className="step-time">
          On this step for <strong className="mono">{formatDuration(timeOnStep(step, now))}</strong>
        </p>
      );
    case "done":
      return <p className="step-time">Done · took {took}</p>;
    case "stopped":
      return <p className="step-time">Stopped after {took}</p>;
  }
}

// Keyed by the agent it is about, so picking another patroller starts it closed.
function DebugPanel(p: { runId: string; agent: AgentSnapshot; canChoose: boolean }) {
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const { agent } = p;
  return (
    <div className="detail-block debug">
      <h3 className="section-title">Debug</h3>
      <p className="debug-target">
        <strong>{patroller(agent.role).name}</strong>
        {p.canChoose && " · select a patrol card to choose another"}
      </p>
      <div className="debug-actions">
        <button
          type="button"
          className="btn"
          disabled={!agent.hasTranscript}
          aria-expanded={transcriptOpen}
          aria-controls="transcript"
          onClick={() => setTranscriptOpen(!transcriptOpen)}
        >
          Full transcript
        </button>
        <GithubLink className="btn" href={agent.jobUrl}>
          GitHub Actions job
        </GithubLink>
      </div>
      {!agent.hasTranscript && <p className="hint">No transcript uploaded yet.</p>}
      <div id="transcript">
        {transcriptOpen && agent.hasTranscript && (
          <Transcript runId={p.runId} agentId={agent.id} />
        )}
      </div>
    </div>
  );
}

export function StepDetail(p: {
  run: RunSnapshot;
  log: LogLine[];
  step: StepSnapshot;
  now: number;
}) {
  const { run, step } = p;
  const [pickedId, setPickedId] = useState<string | null>(null);
  const label = STEP_LABELS[step.id];
  const agents = run.agents.filter((agent) => agent.step === step.id);
  const picked = agents.find((agent) => agent.id === pickedId);
  const debugAgent = picked ?? agents[0];
  const lines = useMemo(() => linesOfStep(run, p.log, step.id), [run, p.log, step.id]);
  const names = useMemo(
    () => Object.fromEntries(run.agents.map((agent) => [agent.id, patroller(agent.role).name])),
    [run.agents],
  );
  const scope = picked
    ? `${patroller(picked.role).name} only`
    : agents.length > 0
      ? "all patrol"
      : "dispatch";

  return (
    <section className="card step-detail" aria-label="Step detail">
      <div className="step-head">
        <h2 className="step-title">
          {label.themed}
          <span className="step-title-plain"> · {label.plain}</span>
        </h2>
        <TimeOnStep step={step} now={p.now} />
      </div>

      <div className="detail-block">
        <h3 className="section-title">
          Conditions report <span className="section-plain">· step notes</span>
        </h3>
        {step.notes.length === 0 ? (
          <p className="hint">Nothing to report yet.</p>
        ) : (
          step.notes.map((note) => (
            <p key={note} className="note">
              {note}
            </p>
          ))
        )}
      </div>

      {agents.length > 0 && (
        <div className="detail-block">
          <div className="section-head">
            <h3 className="section-title">
              Patrol on this step <span className="section-plain">· reviewers</span>
            </h3>
            <span className="hint">Select one to filter the radio log</span>
          </div>
          <PatrolCards agents={agents} selected={pickedId} onSelect={setPickedId} />
        </div>
      )}

      <div className="detail-block">
        <div className="section-head">
          <h3 className="section-title">
            Radio log <span className="section-plain">· logs</span>{" "}
            <span className="section-plain">· {scope}</span>
          </h3>
          {picked && (
            <button type="button" className="btn btn-small" onClick={() => setPickedId(null)}>
              Show all patrol
            </button>
          )}
        </div>
        {/* Keyed so a new scope starts a fresh list: screen readers announce only additions. */}
        <RadioLog key={pickedId ?? "all"} lines={lines} agentId={pickedId} names={names} />
      </div>

      {debugAgent && (
        <DebugPanel
          key={debugAgent.id}
          runId={run.id}
          agent={debugAgent}
          canChoose={agents.length > 1 && !picked}
        />
      )}
    </section>
  );
}
