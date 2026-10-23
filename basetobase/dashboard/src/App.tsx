import { useCallback, useEffect, useState } from "react";
import type { RunSummary } from "../../shared/src/types.ts";
import { getJson, navigateTo, SIGN_IN_URL, SignedOutError } from "./api.ts";
import { RunPage } from "./pages/RunView.tsx";
import { newestSpeakingRun, RunsList } from "./pages/RunsList.tsx";
import { followInternalLink, useRoute, type Route } from "./router.ts";
import { useRunsLive } from "./useRunsLive.ts";

type Dashboard =
  | { phase: "loading" }
  | { phase: "failed" }
  | { phase: "ready"; login: string; runs: RunSummary[] };

function Header({ login }: { login?: string }) {
  return (
    <header className="header">
      <div className="header-bar">
        <a className="brand" href="/">
          <svg width="34" height="22" viewBox="0 0 34 22" aria-hidden="true">
            <path d="M1 21 L11 5 L16 12 L21 3 L33 21 Z" fill="#E8EEF5" />
            <path
              d="M11 5 L14 10 L12 9.5 L10 11 L8.6 9 Z M21 3 L24.5 8.5 L22 8 L20 9.5 L18.3 8 Z"
              fill="#0F1B2D"
              opacity="0.25"
            />
            <path d="M3 18 Q17 14 31 17" fill="none" stroke="#0F1B2D" strokeWidth="1.4" />
          </svg>
          <span className="brand-name">Base to Base</span>
        </a>
        {login && <span className="who">Signed in as {login}</span>}
      </div>
      <svg
        className="ridgeline"
        viewBox="0 0 1440 60"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          className="ridge-far"
          d="M0 60 L0 40 L90 30 L170 38 L260 14 L320 26 L380 18 L470 36 L560 22 L640 4 L700 20 L760 12 L850 34 L930 24 L1010 30 L1090 10 L1160 22 L1230 16 L1320 34 L1440 26 L1440 60 Z"
        />
        <path
          className="ridge-near"
          d="M0 60 L0 50 L120 44 L240 52 L380 40 L520 50 L660 38 L800 50 L960 42 L1100 52 L1260 44 L1440 50 L1440 60 Z"
        />
      </svg>
    </header>
  );
}

function Page({ route, newestRunId }: { route: Route; newestRunId?: string }) {
  switch (route.page) {
    // "/" follows the newest run: a newer one takes its place. /runs/:id pins one. Either way the
    // run on show keeps its key, so pinning it does not load it again.
    case "runs":
      return newestRunId ? <RunPage key={newestRunId} runId={newestRunId} /> : null;
    case "run":
      return <RunPage key={route.runId} runId={route.runId} />;
    case "notFound":
      return (
        <>
          <h1 className="page-title">Page not found</h1>
          <p>
            <a href="/">Back to the runs</a>
          </p>
        </>
      );
  }
}

export function App() {
  const [route, navigate] = useRoute();
  const [dashboard, setDashboard] = useState<Dashboard>({ phase: "loading" });

  useEffect(() => {
    let current = true;
    Promise.all([getJson<{ login: string }>("/api/me"), getJson<RunSummary[]>("/api/runs")]).then(
      ([me, runs]) => {
        if (current) setDashboard({ phase: "ready", login: me.login, runs });
      },
      (error: unknown) => {
        if (!current) return;
        if (error instanceof SignedOutError) navigateTo(SIGN_IN_URL);
        else setDashboard({ phase: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const updateRuns = useCallback((change: (runs: RunSummary[]) => RunSummary[]) => {
    setDashboard((current) =>
      current.phase === "ready" ? { ...current, runs: change(current.runs) } : current,
    );
  }, []);
  useRunsLive(dashboard.phase === "ready", updateRuns);
  const newestRunId =
    dashboard.phase === "ready" ? newestSpeakingRun(dashboard.runs)?.id : undefined;
  const shownRunId =
    route.page === "run" ? route.runId : route.page === "runs" ? newestRunId : undefined;

  return (
    <div onClick={(event) => followInternalLink(event, navigate)}>
      <Header login={dashboard.phase === "ready" ? dashboard.login : undefined} />
      {dashboard.phase === "loading" && (
        <p className="notice" role="status">
          Loading…
        </p>
      )}
      {dashboard.phase === "failed" && (
        <p className="notice" role="alert">
          Could not load the dashboard. Reload to try again.
        </p>
      )}
      {dashboard.phase === "ready" && (
        <div className="layout">
          <aside className="side" aria-label="Runs">
            <RunsList runs={dashboard.runs} activeRunId={shownRunId} />
          </aside>
          <main className="main">
            <Page route={route} newestRunId={newestRunId} />
          </main>
        </div>
      )}
    </div>
  );
}
