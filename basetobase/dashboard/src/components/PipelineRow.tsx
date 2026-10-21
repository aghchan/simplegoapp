import { formatDuration } from "../../../shared/src/format.ts";
import { STEP_LABELS } from "../../../shared/src/labels.ts";
import type { StepId, StepSnapshot, StepStatus } from "../../../shared/src/types.ts";
import { Mark, type Tone } from "./Mark.tsx";

const STEP_TONES: Record<StepStatus, Tone> = {
  done: "ok",
  active: "busy",
  pending: "idle",
  stopped: "idle",
};

const STEP_STATUS_TEXT: Record<StepStatus, string> = {
  done: "Done",
  active: "On it",
  pending: "Waiting",
  stopped: "Stopped",
};

// An unfinished step is still counting; one that never started has taken no time.
export function timeOnStep(step: StepSnapshot, now: number): number {
  return step.startedAt === undefined ? 0 : (step.finishedAt ?? now) - step.startedAt;
}

function Flag({ reached }: { reached: boolean }) {
  return (
    <svg
      className={reached ? "flag flag-reached" : "flag"}
      width="12"
      height="14"
      viewBox="0 0 12 14"
      aria-hidden="true"
    >
      <path d="M1.5 13.5 V0.5" className="flag-pole" />
      <path d="M2 1 L11 3.5 L2 6.5 Z" className="flag-cloth" />
    </svg>
  );
}

function StepButton(p: {
  step: StepSnapshot;
  selected: boolean;
  now: number;
  onSelect: (id: StepId) => void;
}) {
  const { step, selected } = p;
  const label = STEP_LABELS[step.id];
  const text =
    step.status === "pending"
      ? STEP_STATUS_TEXT.pending
      : `${STEP_STATUS_TEXT[step.status]} · ${formatDuration(timeOnStep(step, p.now))}`;
  return (
    <button
      type="button"
      className={`step step-${step.status}`}
      aria-pressed={selected}
      onClick={() => p.onSelect(step.id)}
    >
      <span className="step-name">
        <Mark tone={STEP_TONES[step.status]} />
        {label.themed}
      </span>
      <span className="step-plain-name">{label.plain}</span>
      <span className="step-meta">{text}</span>
    </button>
  );
}

export function PipelineRow(p: {
  steps: StepSnapshot[];
  selected: StepId;
  now: number;
  onSelect: (id: StepId) => void;
}) {
  return (
    <div className="pipeline" role="group" aria-label="Steps of the run">
      {p.steps.map((step) => {
        const milestone = STEP_LABELS[step.id].milestone;
        const reached = step.status === "done";
        return (
          <div key={step.id} className="pipeline-step">
            <StepButton
              step={step}
              selected={step.id === p.selected}
              now={p.now}
              onSelect={p.onSelect}
            />
            {milestone && (
              <span className={reached ? "milestone milestone-reached" : "milestone"}>
                <Flag reached={reached} />
                {milestone}
                <span className="sr-only">{reached ? " reached" : " not yet reached"}</span>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
