import { config, type RoleId } from "../../../shared/src/config.ts";
import { AGENT_STATUS_LABELS } from "../../../shared/src/labels.ts";
import type { AgentSnapshot, AgentStatus } from "../../../shared/src/types.ts";
import { Mark, type Tone } from "./Mark.tsx";

const AGENT_TONES: Record<AgentStatus, Tone> = {
  queued: "idle",
  dispatched: "busy",
  running: "busy",
  stalled: "warn",
  clear: "ok",
  hazards: "hazard",
  error: "bad",
  stopped: "idle",
};

// A run keeps the roles it was started with, so one dropped from the roster since still shows.
export function patroller(role: RoleId): { name: string; role: string } {
  const entry = config.roster.find((candidate) => candidate.id === role);
  return { name: entry?.name ?? role, role: entry?.role ?? "" };
}

export function PatrolCards(p: {
  agents: AgentSnapshot[];
  selected: string | null;
  onSelect: (agentId: string | null) => void;
}) {
  return (
    <div className="patrol-cards">
      {p.agents.map((agent) => {
        const { name, role } = patroller(agent.role);
        const tone = AGENT_TONES[agent.status];
        const on = agent.id === p.selected;
        return (
          <button
            key={agent.id}
            type="button"
            className="patrol-card"
            aria-pressed={on}
            onClick={() => p.onSelect(on ? null : agent.id)}
          >
            <span className="patrol-card-head">
              <span className="patrol-name">{name}</span>
              <Mark tone={tone} />
            </span>
            <span className="patrol-role">{role}</span>
            <span className={`patrol-status patrol-status-${tone}`}>
              {AGENT_STATUS_LABELS[agent.status]}
              {agent.retries ? ` · attempt ${agent.retries + 1}` : ""}
            </span>
            {agent.summary && <span className="patrol-summary">{agent.summary}</span>}
          </button>
        );
      })}
    </div>
  );
}
