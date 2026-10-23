import { formatDuration } from "../../../shared/src/format.ts";
import { STEP_LABELS } from "../../../shared/src/labels.ts";
import type {
  AgentSnapshot,
  ReviewOutcome,
  StepId,
  StepSnapshot,
  StepStatus,
} from "../../../shared/src/types.ts";
import { Mark, type Tone } from "./Mark.tsx";

const STEP_TONES: Record<StepStatus, Tone> = {
  done: "ok",
  active: "busy",
  pending: "idle",
  stopped: "idle",
  skipped: "idle",
};

const STEP_STATUS_TEXT: Record<StepStatus, string> = {
  done: "Done",
  active: "On it",
  pending: "Waiting",
  stopped: "Stopped",
  skipped: "Skipped",
};

// A done step with a review outcome is green only when the review was clear.
const OUTCOME_TONES: Record<ReviewOutcome, Tone> = {
  clear: "ok",
  hazards: "hazard",
  failed: "bad",
  none: "idle",
  pending: "idle",
};

// An unfinished step is still counting; one that never started has taken no time.
export function timeOnStep(step: StepSnapshot, now: number): number {
  return step.startedAt === undefined ? 0 : (step.finishedAt ?? now) - step.startedAt;
}

// A done Drop in is the merge: the PR went all the way.
function toneOf(step: StepSnapshot): Tone {
  if (step.id === "drop_in" && step.status === "done") return "landed";
  if (step.status === "done" && step.outcome) return OUTCOME_TONES[step.outcome];
  return STEP_TONES[step.status];
}

// What a done step's review came to, unless it passed.
function outcomeText(step: StepSnapshot, agents: AgentSnapshot[]): string | undefined {
  if (step.status !== "done") return undefined;
  switch (step.outcome) {
    case "hazards":
      return "hazards flagged";
    case "failed": {
      const failed = agents.filter(
        (agent) =>
          agent.step === step.id && (agent.status === "error" || agent.status === "stopped"),
      );
      return `${failed.length} failed`;
    }
    case "none":
      return "no patrollers";
    default:
      return undefined;
  }
}

// A reached flag takes the tone of its step's review, if it has one, else stays navy.
function Flag({ reached, tone }: { reached: boolean; tone?: Tone }) {
  const className = reached ? `flag flag-reached${tone ? ` flag-${tone}` : ""}` : "flag";
  return (
    <svg
      className={className}
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
  agents: AgentSnapshot[];
  selected: boolean;
  now: number;
  onSelect: (id: StepId) => void;
}) {
  const { step, selected } = p;
  const label = STEP_LABELS[step.id];
  const outcome = outcomeText(step, p.agents);
  // A step that never ran has no time to show.
  const text =
    step.status === "pending" || step.status === "skipped"
      ? STEP_STATUS_TEXT[step.status]
      : [STEP_STATUS_TEXT[step.status], outcome, formatDuration(timeOnStep(step, p.now))]
          .filter((part) => part !== undefined)
          .join(" · ");
  return (
    <button
      type="button"
      className={`step step-${step.status}`}
      aria-pressed={selected}
      onClick={() => p.onSelect(step.id)}
    >
      <span className="step-name">
        <Mark tone={toneOf(step)} />
        {label.themed}
      </span>
      <span className="step-plain-name">{label.plain}</span>
      <span className="step-meta">{text}</span>
    </button>
  );
}

export function PipelineRow(p: {
  steps: StepSnapshot[];
  agents: AgentSnapshot[];
  selected: StepId;
  now: number;
  onSelect: (id: StepId) => void;
}) {
  return (
    <div className="pipeline" role="group" aria-label="Steps of the run">
      {p.steps.map((step) => {
        const milestone = STEP_LABELS[step.id].milestone;
        const reached = step.status === "done";
        const flagText = reached
          ? " reached"
          : step.status === "skipped"
            ? " skipped"
            : " not yet reached";
        return (
          <div key={step.id} className="pipeline-step">
            <StepButton
              step={step}
              agents={p.agents}
              selected={step.id === p.selected}
              now={p.now}
              onSelect={p.onSelect}
            />
            {milestone && (
              <span className={reached ? "milestone milestone-reached" : "milestone"}>
                <Flag reached={reached} tone={step.outcome ? toneOf(step) : undefined} />
                {milestone}
                <span className="sr-only">{flagText}</span>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
