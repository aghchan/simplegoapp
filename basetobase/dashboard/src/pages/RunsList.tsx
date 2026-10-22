import { useId, useState } from "react";
import { OUTCOME_LABELS, RUN_STATUS_LABELS, STEP_LABELS } from "../../../shared/src/labels.ts";
import type { RunSummary } from "../../../shared/src/types.ts";
import { TrailRating } from "../components/TrailRating.tsx";

type Group = "needs_you" | "on_the_hill" | "swept" | "landed" | "closed";

const GROUPS: { id: Group; title: string; urgent?: true }[] = [
  { id: "needs_you", title: "Wind hold · needs you", urgent: true },
  { id: "on_the_hill", title: RUN_STATUS_LABELS.on_the_hill },
  { id: "swept", title: RUN_STATUS_LABELS.swept },
  { id: "landed", title: RUN_STATUS_LABELS.landed },
  { id: "closed", title: "Closed" },
];

// A run that has ended needs nothing, whatever its review came to.
function groupOf(run: RunSummary): Group {
  switch (run.status) {
    case "landed":
      return "landed";
    case "stopped":
      return "closed";
    case "failed":
      return "needs_you";
    case "swept":
      return run.outcome === "hazards" || run.outcome === "failed" ? "needs_you" : "swept";
    case "on_the_hill":
      return "on_the_hill";
  }
}

// The run started last; on a tie, the one listed first.
export function newestRun(runs: RunSummary[]): RunSummary | undefined {
  return runs.reduce<RunSummary | undefined>(
    (newest, run) => (!newest || run.createdAt > newest.createdAt ? run : newest),
    undefined,
  );
}

interface Pr {
  latest: RunSummary;
  // Newest first.
  earlier: RunSummary[];
}

// A PR shows once, where its latest run is listed.
function prsOf(runs: RunSummary[]): Pr[] {
  const byPr = new Map<number, RunSummary[]>();
  for (const run of runs) byPr.set(run.prNumber, [...(byPr.get(run.prNumber) ?? []), run]);
  return runs.flatMap((run) => {
    const all = byPr.get(run.prNumber) ?? [];
    if (newestRun(all) !== run) return [];
    const earlier = all.filter((other) => other !== run).sort((a, b) => b.createdAt - a.createdAt);
    return [{ latest: run, earlier }];
  });
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

// Urgent: needs the owner. Quiet: ended without a pass, and needs nothing. A landed run's colour
// comes from its status class.
function toneOf(run: RunSummary, group: Group): string {
  if (group === "needs_you") return " run-urgent";
  if (group === "closed" || (group === "swept" && run.outcome !== "clear")) return " run-quiet";
  return "";
}

// An earlier run no longer speaks for its PR, so it is quiet and leaves out the PR it is under.
function RunLink(p: { run: RunSummary; tone: string; current: boolean; earlier?: true }) {
  const { run } = p;
  return (
    <a
      className={`run run-${run.status}${p.tone}`}
      href={`/runs/${run.id}`}
      aria-current={p.current ? "page" : undefined}
    >
      <span className="run-name">
        <TrailRating rating={run.rating} />
        {run.runName}
      </span>
      {!p.earlier && <span className="run-title">{`#${run.prNumber} ${run.prTitle}`}</span>}
      <span className="run-status">{statusText(run)}</span>
    </a>
  );
}

function PrItem(p: { pr: Pr; group: Group; activeRunId?: string }) {
  const { latest, earlier } = p.pr;
  const listId = useId();
  const holdsActive = earlier.some((run) => run.id === p.activeRunId);
  // Opens by itself whenever the page moves to one of the earlier runs; the viewer can close it.
  const [open, setOpen] = useState(holdsActive);
  const [heldActive, setHeldActive] = useState(holdsActive);
  if (holdsActive !== heldActive) {
    setHeldActive(holdsActive);
    if (holdsActive) setOpen(true);
  }
  const count = earlier.length;

  return (
    <li className="pr">
      <RunLink run={latest} tone={toneOf(latest, p.group)} current={latest.id === p.activeRunId} />
      {count > 0 && (
        <>
          <button
            type="button"
            className="btn btn-small earlier-toggle"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen(!open)}
          >
            <svg className="chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M3.5 1.5 L7 5 L3.5 8.5" />
            </svg>
            {count} earlier {count === 1 ? "run" : "runs"}
          </button>
          <ul id={listId} className="run-earlier" hidden={!open}>
            {earlier.map((run) => (
              <li key={run.id}>
                <RunLink run={run} tone=" run-quiet" current={run.id === p.activeRunId} earlier />
              </li>
            ))}
          </ul>
        </>
      )}
    </li>
  );
}

export function RunsList({ runs, activeRunId }: { runs: RunSummary[]; activeRunId?: string }) {
  if (runs.length === 0)
    return <p className="hint">No runs yet. They appear when you open a pull request.</p>;
  const prs = prsOf(runs);
  return (
    <div className="runs">
      {GROUPS.map(({ id, title, urgent }) => {
        const inGroup = prs.filter((pr) => groupOf(pr.latest) === id);
        if (inGroup.length === 0) return null;
        return (
          <section key={id} className="run-group">
            <h2 className={urgent ? "group-title group-title-urgent" : "group-title"}>{title}</h2>
            <ul className="run-items">
              {inGroup.map((pr) => (
                <PrItem key={pr.latest.prNumber} pr={pr} group={id} activeRunId={activeRunId} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
