import { Hono } from "hono";
import type { JWTVerifyGetKey } from "jose";
import type { AgentEvent, EventKind } from "../../../shared/src/types.ts";
import { verifyAgentToken } from "../auth/oidc.ts";
import { runStub } from "../runs/index.ts";
import { readBody, readJsonObject, reject } from "./request.ts";

type AgentEnv = { Bindings: Env; Variables: { githubRunId: string } };

const JSON_MAX_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_BYTES = 25 * 1024 * 1024;
const EVENTS_MAX = 500;
const FAILURE_REASON_MAX = 500;
const FORBIDDEN = "forbidden";
// A record rather than a list, so that the compiler checks it against EventKind.
const KNOWN_KINDS: Record<EventKind, true> = {
  system: true,
  say: true,
  tool: true,
  tool_result: true,
  done: true,
  error: true,
};
const EVENT_KINDS = new Set(Object.keys(KNOWN_KINDS));

// What the forwarder on a GitHub Actions runner sends. A caller needs a GitHub OIDC token for the
// agent workflow and the nonce of the agent it reports as. The run is never created from here: a
// run id the Durable Object does not know fails the nonce check like a wrong nonce.
export function agentRoutes(getKey: JWTVerifyGetKey): Hono<AgentEnv> {
  const routes = new Hono<AgentEnv>();

  routes.use(async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    try {
      const { githubRunId } = await verifyAgentToken(token, {
        audience: c.env.PUBLIC_URL,
        repo: c.env.REPO,
        workflow: c.env.AGENT_WORKFLOW,
        getKey,
      });
      c.set("githubRunId", githubRunId);
    } catch {
      // Nothing about which check failed.
      reject(401, "unauthorized");
    }
    await next();
  });

  routes.get("/brief", async (c) => {
    const { runId, agentId, nonce } = identify(c.req.query());
    const brief = await runStub(c.env, runId).brief(agentId, nonce);
    if (!brief) reject(403, FORBIDDEN);
    return c.json(brief);
  });

  routes.post("/events", async (c) => {
    const body = await readJsonObject(c.req.raw, JSON_MAX_BYTES);
    const { runId, agentId, nonce } = identify(body);
    const events = parseEvents(body.events);
    // From the verified token, so the dashboard never links to a page the agent chose.
    const jobUrl = `https://github.com/${c.env.REPO}/actions/runs/${c.get("githubRunId")}`;
    if (!(await runStub(c.env, runId).events(agentId, nonce, events, jobUrl))) {
      reject(403, FORBIDDEN);
    }
    return c.body(null, 204);
  });

  routes.post("/verdict", async (c) => {
    const body = await readJsonObject(c.req.raw, JSON_MAX_BYTES);
    const { runId, agentId, nonce } = identify(body);
    const run = runStub(c.env, runId);
    // A wrong nonce is 403 whatever the verdict says; only a verdict that fails validation is 422.
    if (!(await run.checkNonce(agentId, nonce))) reject(403, FORBIDDEN);
    const result = await run.verdict(agentId, nonce, body.verdict);
    return result.ok ? c.body(null, 204) : c.json({ error: result.error }, 422);
  });

  routes.post("/failure", async (c) => {
    const body = await readJsonObject(c.req.raw, JSON_MAX_BYTES);
    const { runId, agentId, nonce } = identify(body);
    if (typeof body.reason !== "string") reject(400, "reason must be a string");
    const reason = body.reason.slice(0, FAILURE_REASON_MAX);
    if (!(await runStub(c.env, runId).failure(agentId, nonce, reason))) reject(403, FORBIDDEN);
    return c.body(null, 204);
  });

  routes.put("/transcript", async (c) => {
    const { runId, agentId, nonce } = identify(c.req.query());
    const run = runStub(c.env, runId);
    // Before anything is stored, and without brief(): that refuses a stopped run or an agent that
    // has reported, whose transcript the owner most needs.
    if (!(await run.checkNonce(agentId, nonce))) reject(403, FORBIDDEN);
    const transcript = await readBody(c.req.raw, TRANSCRIPT_MAX_BYTES);
    await c.env.EVIDENCE.put(`runs/${runId}/${agentId}.jsonl`, transcript);
    if (!(await run.transcriptStored(agentId, nonce))) reject(403, FORBIDDEN);
    return c.body(null, 204);
  });

  return routes;
}

function identify(source: Record<string, unknown>) {
  return {
    runId: requiredString(source, "run_id"),
    agentId: requiredString(source, "agent_id"),
    nonce: requiredString(source, "nonce"),
  };
}

function requiredString(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  if (typeof value !== "string" || value === "") reject(400, `${name} must be a non-empty string`);
  return value;
}

function parseEvents(value: unknown): AgentEvent[] {
  if (!Array.isArray(value) || value.length > EVENTS_MAX) {
    reject(400, `events must be an array of at most ${EVENTS_MAX}`);
  }
  return value.map((item) => parseEvent(item));
}

// Copies the four fields, so nothing else the agent sends reaches the run.
function parseEvent(value: unknown): AgentEvent {
  const { seq, ts, kind, text } =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  if (
    typeof seq !== "number" ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    typeof ts !== "number" ||
    !Number.isFinite(ts) ||
    typeof kind !== "string" ||
    !EVENT_KINDS.has(kind) ||
    typeof text !== "string"
  ) {
    reject(
      400,
      "each event needs a non-negative integer seq, a numeric ts, a known kind and a text",
    );
  }
  return { seq, ts, kind: kind as EventKind, text };
}
