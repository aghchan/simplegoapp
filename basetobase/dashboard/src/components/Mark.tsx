export type Tone = "ok" | "bad" | "warn" | "busy" | "idle";

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
};
