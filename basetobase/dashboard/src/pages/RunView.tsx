import { useEffect, useState } from "react";
import type { Panel } from "../../../shared/src/config.ts";
import { RATING_LABELS, RUN_STATUS_LABELS } from "../../../shared/src/labels.ts";
import type { LogLine, RunSnapshot, StepId } from "../../../shared/src/types.ts";
import { getJson, navigateTo, NotFoundError, SIGN_IN_URL, SignedOutError } from "../api.ts";
import { GithubLink } from "../components/GithubLink.tsx";
import { Mark } from "../components/Mark.tsx";
import { PipelineRow } from "../components/PipelineRow.tsx";
import { StepDetail } from "../components/StepDetail.tsx";
import { TrailRating } from "../components/TrailRating.tsx";
import { useNow } from "../useNow.ts";
import { type Connection, type RunLive, useRunLive } from "../useRunLive.ts";

const PANEL_NAMES: Record<Panel, string> = { backend: "Backend", frontend: "Frontend" };

const CONNECTION_TEXT: Record<Connection, string> = {
  connecting: "Connecting…",
  live: "Dispatch live · connected",
  reconnecting: "Reconnecting…",
};

// The step the run is on; a stopped run is on the step it was stopped in. A landed run is on Drop
// in, even one merged mid-review whose sweep was stopped.
export function defaultStep(run: RunSnapshot): StepId {
  if (run.status === "landed") return "drop_in";
  const current = run.steps.find((s) => s.status === "active" || s.status === "stopped");
  return current?.id ?? run.steps.findLast((s) => s.status === "done")?.id ?? "lift_line";
}

export function RunView({ live }: { live: RunLive }) {
  const { run, log, connection } = live;
  const now = useNow(1000);
  const [picked, setPicked] = useState<StepId | null>(null);
  if (!run) {
    return (
      <p className="notice" role="status">
        Loading run…
      </p>
    );
  }

  const selected = picked ?? defaultStep(run);
  const step = run.steps.find((s) => s.id === selected);
  const done = run.steps.filter((s) => s.status === "done").length;
  const skipped = run.steps.filter((s) => s.status === "skipped").length;
  const panels = run.panels.map((panel) => PANEL_NAMES[panel]).join(" + ");
  const landed = run.status === "landed";

  return (
    <div className="run-view">
      <section
        className={landed ? "card pr-head pr-head-landed" : "card pr-head"}
        aria-label="Pull request"
      >
        <div className="pr-info">
          <div className="chips">
            <span className="mono pr-number">#{run.prNumber}</span>
            {landed && (
              <span className="chip chip-landed">
                <Mark tone="landed" />
                {RUN_STATUS_LABELS.landed}
                {run.mergeSha && ` as ${run.mergeSha.slice(0, 7)}`}
              </span>
            )}
            {run.designBypassedAt !== undefined && (
              <span className="chip chip-bypassed">Design bypassed (emergency)</span>
            )}
            <span className="chip">{panels} run</span>
            <span className="chip chip-rating">
              <TrailRating rating={run.rating} size={11} />
              {RATING_LABELS[run.rating]} · <span>{run.runName}</span>
            </span>
          </div>
          <h1 className="pr-title">{run.prTitle}</h1>
          <p className="pr-meta">{`${run.branch} → main · head ${run.headSha.slice(0, 7)}`}</p>
        </div>
        <div className="pr-actions">
          <p className={`connection connection-${connection}`} role="status">
            <span className="connection-dot" aria-hidden="true" />
            {CONNECTION_TEXT[connection]}
          </p>
          <GithubLink className="btn" href={run.prUrl}>
            View PR on GitHub
          </GithubLink>
        </div>
      </section>

      <section className="card" aria-label="The run">
        <div className="section-head">
          <h2 className="card-title">The run</h2>
          <span className="hint">
            {done} of {run.steps.length} done{skipped > 0 && ` · ${skipped} skipped`} · flags mark
            milestones
          </span>
        </div>
        <PipelineRow
          steps={run.steps}
          agents={run.agents}
          selected={selected}
          now={now}
          onSelect={setPicked}
        />
      </section>

      {step && <StepDetail key={step.id} run={run} log={log} step={step} now={now} />}
    </div>
  );
}

type FirstLoad =
  | { phase: "loading" }
  | { phase: "missing" }
  | { phase: "failed" }
  | { phase: "ready"; run: RunSnapshot; log: LogLine[] };

function LiveRun(p: { runId: string; initial: { run: RunSnapshot; log: LogLine[] } }) {
  const live = useRunLive(p.runId, { initial: p.initial });
  return <RunView live={live} />;
}

// Fetches the run once for a fast first paint, and only then opens the socket, whose snapshot
// follows.
export function RunPage({ runId }: { runId: string }) {
  const [load, setLoad] = useState<FirstLoad>({ phase: "loading" });

  useEffect(() => {
    let current = true;
    getJson<{ run: RunSnapshot; log: LogLine[] }>(`/api/runs/${runId}`).then(
      ({ run, log }) => {
        if (current) setLoad({ phase: "ready", run, log });
      },
      (error: unknown) => {
        if (!current) return;
        if (error instanceof SignedOutError) navigateTo(SIGN_IN_URL);
        else setLoad({ phase: error instanceof NotFoundError ? "missing" : "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [runId]);

  switch (load.phase) {
    case "loading":
      return (
        <p className="notice" role="status">
          Loading run…
        </p>
      );
    case "missing":
      return (
        <>
          <h1 className="page-title">Run not found</h1>
          <p>
            <a href="/">Back to the runs</a>
          </p>
        </>
      );
    case "failed":
      return (
        <p className="notice" role="alert">
          Could not load this run. Reload to try again.
        </p>
      );
    case "ready":
      return <LiveRun runId={runId} initial={load} />;
  }
}
