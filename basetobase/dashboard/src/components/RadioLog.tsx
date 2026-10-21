import { memo, useLayoutEffect, useRef } from "react";
import type { LogLine } from "../../../shared/src/types.ts";

const CLOCK = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

// How far from the bottom still counts as reading the newest line.
const AT_BOTTOM_PX = 24;

// `names` maps an agent id to its patroller's name; a line without an agent comes from Dispatch.
// The box follows new lines unless the reader has scrolled up. The list is the only live region,
// so a screen reader hears lines as they are added, not the ones the list started with.
export const RadioLog = memo(function RadioLog(p: {
  lines: LogLine[];
  agentId: string | null;
  names: Record<string, string>;
}) {
  const shown = p.agentId === null ? p.lines : p.lines.filter((l) => l.agentId === p.agentId);
  const box = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const newest = shown.at(-1)?.id;

  useLayoutEffect(() => {
    const element = box.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [newest]);

  const onScroll = () => {
    const element = box.current;
    if (!element) return;
    following.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_PX;
  };

  return (
    <div
      className="radio"
      ref={box}
      onScroll={onScroll}
      tabIndex={0}
      role="region"
      aria-label="Radio log · logs"
    >
      <ol className="radio-lines" aria-live="polite" aria-relevant="additions">
        {shown.map((line) => (
          <li key={line.id} className={`radio-line log-${line.kind}`}>
            <span className="radio-time">{CLOCK.format(line.ts)}</span>
            <span className={line.agentId === null ? "radio-who radio-dispatch" : "radio-who"}>
              {line.agentId === null ? "dispatch" : (p.names[line.agentId] ?? line.agentId)}
            </span>
            <span className="radio-text">
              {line.kind === "error" && <span className="sr-only">Error: </span>}
              {line.text}
            </span>
          </li>
        ))}
      </ol>
      {shown.length === 0 && <p className="log-empty">Quiet on the radio.</p>}
    </div>
  );
});
