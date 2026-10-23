// "hazard": a red warning, for hazards flagged; "bad": a red cross, for a failure. "landed": a
// violet flag, for a PR merged: the run went all the way.
export type Tone = "ok" | "bad" | "hazard" | "warn" | "busy" | "idle" | "landed";

// Shape as well as colour tells the tones apart, and the text beside a mark always says the same.
export function Mark({ tone }: { tone: Tone }) {
  return (
    <svg
      className={`mark mark-${tone}`}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      {MARKS[tone]}
    </svg>
  );
}

const MARKS = {
  ok: (
    <>
      <circle cx="8" cy="8" r="8" className="mark-fill" />
      <path d="M4.5 8.2 L7 10.5 L11.5 5.8" className="mark-stroke" />
    </>
  ),
  bad: (
    <>
      <circle cx="8" cy="8" r="8" className="mark-fill" />
      <path d="M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5" className="mark-stroke" />
    </>
  ),
  hazard: (
    <>
      <path d="M8 1 L15.4 14.6 H0.6 Z" className="mark-fill" />
      <path d="M8 5.8 V9.6 M8 12 V12.1" className="mark-stroke" />
    </>
  ),
  warn: (
    <>
      <circle cx="8" cy="8" r="7" className="mark-ring" />
      <path d="M8 4.5 V8.5 M8 10.6 V11.2" className="mark-line" />
    </>
  ),
  busy: (
    <>
      <circle cx="8" cy="8" r="7" className="mark-ring" />
      <circle cx="8" cy="8" r="3.5" className="mark-fill" />
    </>
  ),
  idle: <circle cx="8" cy="8" r="7" className="mark-ring mark-dashed" />,
  landed: (
    <>
      <circle cx="8" cy="8" r="8" className="mark-fill" />
      <path d="M5.6 12 V4" className="mark-stroke" />
      <path d="M6.2 4.2 L11.6 6.1 L6.2 8 Z" className="mark-flag" />
    </>
  ),
};
