import { useEffect, useState } from "react";
import { mapStreamLine } from "../../../shared/src/stream.ts";
import type { EventKind } from "../../../shared/src/types.ts";
import { getText, navigateTo, NotFoundError, SIGN_IN_URL, SignedOutError } from "../api.ts";

type Entry = { kind: EventKind; text: string };
type State =
  | { phase: "loading" }
  | { phase: "missing" }
  | { phase: "failed" }
  | { phase: "ready"; entries: Entry[] };

export function Transcript({ runId, agentId }: { runId: string; agentId: string }) {
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    let current = true;
    getText(`/api/runs/${runId}/agents/${agentId}/transcript`).then(
      (text) => {
        if (!current) return;
        const entries = text.split("\n").flatMap((line) => mapStreamLine(line, { full: true }));
        setState({ phase: "ready", entries });
      },
      (error: unknown) => {
        if (!current) return;
        if (error instanceof SignedOutError) navigateTo(SIGN_IN_URL);
        else setState({ phase: error instanceof NotFoundError ? "missing" : "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [runId, agentId]);

  switch (state.phase) {
    case "loading":
      return (
        <p className="hint" role="status">
          Loading the transcript…
        </p>
      );
    case "missing":
      return <p className="hint">There is no transcript for this patroller.</p>;
    case "failed":
      return (
        <p className="hint" role="alert">
          Could not load the transcript. Try again in a moment.
        </p>
      );
    case "ready":
      return (
        <div className="transcript" tabIndex={0} role="region" aria-label="Full transcript">
          {state.entries.length === 0 ? (
            <p className="log-empty">The transcript is empty.</p>
          ) : (
            <ol className="transcript-entries">
              {state.entries.map((entry, index) => (
                <li key={index} className={`transcript-entry log-${entry.kind}`}>
                  <span className="transcript-kind">{entry.kind.replace("_", " ")}</span>
                  <pre className="transcript-text">{entry.text}</pre>
                </li>
              ))}
            </ol>
          )}
        </div>
      );
  }
}
