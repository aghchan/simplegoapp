import { RUN_STATUS_LABELS, STEP_LABELS } from "../../../shared/src/labels.ts";
import type { RunStatus, RunSummary } from "../../../shared/src/types.ts";
import { TrailRating } from "../components/TrailRating.tsx";

const GROUPS: { title: string; statuses: RunStatus[]; urgent?: true }[] = [
  { title: "Wind hold · needs you", statuses: ["failed"], urgent: true },
  { title: "On the hill", statuses: ["on_the_hill", "swept"] },
  { title: "Closed", statuses: ["stopped"] },
];

function statusText(run: RunSummary): string {
  if (run.status !== "on_the_hill") return RUN_STATUS_LABELS[run.status];
  const step = STEP_LABELS[run.currentStep];
  return `${step.themed} · ${step.plain}`;
}

export function RunsList({ runs, activeRunId }: { runs: RunSummary[]; activeRunId?: string }) {
  if (runs.length === 0)
    return <p className="hint">No runs yet. They appear when you open a pull request.</p>;
  return (
    <div className="runs">
      {GROUPS.map(({ title, statuses, urgent }) => {
        const inGroup = runs.filter((run) => statuses.includes(run.status));
        if (inGroup.length === 0) return null;
        return (
          <section key={title} className="run-group">
            <h2 className={urgent ? "group-title group-title-urgent" : "group-title"}>{title}</h2>
            <ul className="run-items">
              {inGroup.map((run) => (
                <li key={run.id}>
                  <a
                    className={`run run-${run.status}`}
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
