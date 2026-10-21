import { OUTCOME_LABELS, RUN_STATUS_LABELS, STEP_LABELS } from "../../../shared/src/labels.ts";
import type { RunSummary } from "../../../shared/src/types.ts";
import { TrailRating } from "../components/TrailRating.tsx";

type Group = "needs_you" | "on_the_hill" | "swept" | "closed";

const GROUPS: { id: Group; title: string; urgent?: true }[] = [
  { id: "needs_you", title: "Wind hold · needs you", urgent: true },
  { id: "on_the_hill", title: RUN_STATUS_LABELS.on_the_hill },
  { id: "swept", title: RUN_STATUS_LABELS.swept },
  { id: "closed", title: "Closed" },
];

function groupOf(run: RunSummary): Group {
  if (run.status === "failed" || run.outcome === "hazards" || run.outcome === "failed") {
    return "needs_you";
  }
  return run.status === "stopped" ? "closed" : run.status;
}

// Only a clear review reads as patrol done.
function statusText(run: RunSummary): string {
  if (run.status === "on_the_hill") {
    const step = STEP_LABELS[run.currentStep];
    return `${step.themed} · ${step.plain}`;
  }
  if (run.status === "swept" && run.outcome !== "clear") return OUTCOME_LABELS[run.outcome];
  return RUN_STATUS_LABELS[run.status];
}

// Urgent: needs the owner. Quiet: ended without a pass, and needs nothing.
function toneOf(run: RunSummary, group: Group): string {
  if (group === "needs_you") return " run-urgent";
  if (group === "closed" || (group === "swept" && run.outcome !== "clear")) return " run-quiet";
  return "";
}

export function RunsList({ runs, activeRunId }: { runs: RunSummary[]; activeRunId?: string }) {
  if (runs.length === 0)
    return <p className="hint">No runs yet. They appear when you open a pull request.</p>;
  return (
    <div className="runs">
      {GROUPS.map(({ id, title, urgent }) => {
        const inGroup = runs.filter((run) => groupOf(run) === id);
        if (inGroup.length === 0) return null;
        return (
          <section key={id} className="run-group">
            <h2 className={urgent ? "group-title group-title-urgent" : "group-title"}>{title}</h2>
            <ul className="run-items">
              {inGroup.map((run) => (
                <li key={run.id}>
                  <a
                    className={`run run-${run.status}${toneOf(run, id)}`}
                    href={`/runs/${run.id}`}
                    aria-current={run.id === activeRunId ? "page" : undefined}
                  >
                    <span className="run-name">
                      <TrailRating rating={run.rating} />
                      {run.runName}
                    </span>
                    <span className="run-title">{`#${run.prNumber} ${run.prTitle}`}</span>
                    <span className="run-status">{statusText(run)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
