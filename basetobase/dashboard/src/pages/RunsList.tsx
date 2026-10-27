import { useCallback, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { OUTCOME_LABELS, RUN_STATUS_LABELS, STEP_LABELS } from "../../../shared/src/labels.ts";
import type { OwedDesign, RunSummary } from "../../../shared/src/types.ts";
import { TrailRating } from "../components/TrailRating.tsx";
import { useOwedDesigns } from "../useOwedDesigns.ts";

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

// The newest open run, else the newest landed, else the newest. Dispatch keeps the newest open run
// on the PR's head, so a run it stopped in a race can be newer than the one that is live or landed.
function speakingRun(runs: RunSummary[]): RunSummary | undefined {
  return (
    newestRun(runs.filter((run) => run.status === "on_the_hill" || run.status === "swept")) ??
    newestRun(runs.filter((run) => run.status === "landed")) ??
    newestRun(runs)
  );
}

interface Pr {
  speaking: RunSummary;
  // Newest first.
  earlier: RunSummary[];
}

// A PR shows once, where its speaking run is listed.
function prsOf(runs: RunSummary[]): Pr[] {
  const byPr = new Map<number, RunSummary[]>();
  for (const run of runs) byPr.set(run.prNumber, [...(byPr.get(run.prNumber) ?? []), run]);
  return runs.flatMap((run) => {
    const all = byPr.get(run.prNumber) ?? [];
    if (speakingRun(all) !== run) return [];
    const earlier = all.filter((other) => other !== run).sort((a, b) => b.createdAt - a.createdAt);
    return [{ speaking: run, earlier }];
  });
}

// The run "/" shows.
export function newestSpeakingRun(runs: RunSummary[]): RunSummary | undefined {
  return newestRun(prsOf(runs).map((pr) => pr.speaking));
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

// A PR whose design the owner bypassed and which has yet to land: the bypassed run is the way in.
function OwedItem(p: { owed: OwedDesign }) {
  return (
    <li className="pr">
      <a className="run run-urgent" href={`/runs/${p.owed.runId}`}>
        <span className="run-title">{`#${p.owed.prNumber} ${p.owed.prTitle}`}</span>
      </a>
    </li>
  );
}

function PrItem(p: {
  pr: Pr;
  group: Group;
  activeRunId?: string;
  open: boolean;
  onToggle: () => void;
  refocus: RefObject<number | undefined>;
}) {
  const { speaking, earlier } = p.pr;
  const { prNumber } = speaking;
  const { refocus } = p;
  const listId = useId();
  // A PR that changes group mounts afresh: its toggle takes back the focus the old one had.
  const keepFocus = useCallback(
    (toggle: HTMLButtonElement) => {
      if (refocus.current === prNumber) {
        toggle.focus();
        refocus.current = undefined;
      }
      return () => {
        if (document.activeElement === toggle) refocus.current = prNumber;
      };
    },
    [refocus, prNumber],
  );
  const count = earlier.length;

  return (
    <li className="pr">
      <RunLink
        run={speaking}
        tone={toneOf(speaking, p.group)}
        current={speaking.id === p.activeRunId}
      />
      {count > 0 && (
        <>
          <button
            ref={keepFocus}
            type="button"
            className="btn btn-small earlier-toggle"
            aria-expanded={p.open}
            aria-controls={listId}
            onClick={p.onToggle}
          >
            <svg className="chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M3.5 1.5 L7 5 L3.5 8.5" />
            </svg>
            {count} earlier {count === 1 ? "run" : "runs"}
          </button>
          <ul id={listId} className="run-earlier" hidden={!p.open}>
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
  const prs = prsOf(runs);
  const owed = useOwedDesigns(runs);
  // Kept here by PR number, not in PrItem: a PR that changes group mounts afresh.
  const [open, setOpen] = useState<ReadonlyMap<number, boolean>>(new Map());
  // Opens by itself whenever the page moves to one of a PR's earlier runs; the viewer can close it.
  const holder = prs.find((pr) => pr.earlier.some((run) => run.id === activeRunId))?.speaking;
  const [held, setHeld] = useState<number>();
  if (holder?.prNumber !== held) {
    setHeld(holder?.prNumber);
    if (holder) setOpen(new Map(open).set(holder.prNumber, true));
  }
  // Lives for one commit: a PR gone from the list must not take the focus when it comes back.
  const refocus = useRef<number>(undefined);
  useLayoutEffect(() => {
    refocus.current = undefined;
  });

  if (runs.length === 0)
    return <p className="hint">No runs yet. They appear when you open a pull request.</p>;
  return (
    <div className="runs">
      {owed.length > 0 && (
        <section className="run-group">
          <h2 className="group-title group-title-urgent">Designs owed</h2>
          <ul className="run-items">
            {owed.map((design) => (
              <OwedItem key={`${design.repo}#${design.prNumber}`} owed={design} />
            ))}
          </ul>
        </section>
      )}
      {GROUPS.map(({ id, title, urgent }) => {
        const inGroup = prs.filter((pr) => groupOf(pr.speaking) === id);
        if (inGroup.length === 0) return null;
        return (
          <section key={id} className="run-group">
            <h2 className={urgent ? "group-title group-title-urgent" : "group-title"}>{title}</h2>
            <ul className="run-items">
              {inGroup.map((pr) => {
                const n = pr.speaking.prNumber;
                return (
                  <PrItem
                    key={n}
                    pr={pr}
                    group={id}
                    activeRunId={activeRunId}
                    open={open.get(n) ?? false}
                    onToggle={() => setOpen(new Map(open).set(n, !open.get(n)))}
                    refocus={refocus}
                  />
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
