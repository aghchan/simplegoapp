import { useState } from "react";
import { navigateTo, post, SIGN_IN_URL, SignedOutError } from "../api.ts";

type Phase =
  | { name: "idle" }
  | { name: "sending" }
  | { name: "sent" }
  | { name: "refused"; reason: string };

// Asks Dispatch to do something for the owner: run failed patrollers again, bypass the design
// finding. What follows comes over the run's socket, which takes the button away. A refusal reads
// `${failure} ${Dispatch's reason}`. Key the button by what it acts on, so that a change of that
// (an attempt that fails again) gets a fresh one.
export function ActionButton(p: {
  path: string;
  label: string;
  busyLabel: string;
  failure: string;
}) {
  const [phase, setPhase] = useState<Phase>({ name: "idle" });

  async function send() {
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
      <button type="button" className="btn" disabled={busy} onClick={send}>
        {busy ? p.busyLabel : p.label}
      </button>
      {phase.name === "refused" && (
        <p className="hint action-refused" role="alert">
          {p.failure} {phase.reason}
        </p>
      )}
    </>
  );
}
