import { useState } from "react";
import { navigateTo, post, SIGN_IN_URL, SignedOutError } from "../api.ts";

type Phase =
  | { name: "idle" }
  | { name: "sending" }
  | { name: "sent" }
  | { name: "refused"; reason: string };

// Asks Dispatch to run failed patrollers again. What follows comes over the run's socket: the
// patrollers back in the queue, which takes the button away. Key it by the attempt it retries, so
// an attempt that fails again gets a fresh button.
export function RetryButton(p: { path: string; label: string }) {
  const [phase, setPhase] = useState<Phase>({ name: "idle" });

  async function retry() {
    setPhase({ name: "sending" });
    try {
      await post(p.path);
      setPhase({ name: "sent" });
    } catch (error) {
      if (error instanceof SignedOutError) navigateTo(SIGN_IN_URL);
      else setPhase({ name: "refused", reason: error instanceof Error ? error.message : "failed" });
    }
  }

  const busy = phase.name === "sending" || phase.name === "sent";
  return (
    <>
      <button type="button" className="btn" disabled={busy} onClick={retry}>
        {busy ? "Retrying…" : p.label}
      </button>
      {phase.name === "refused" && (
        <p className="hint retry-refused" role="alert">
          Could not retry: {phase.reason}
        </p>
      )}
    </>
  );
}
