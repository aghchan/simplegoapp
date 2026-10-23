import { Hono } from "hono";
import { STEP_ORDER } from "../../../shared/src/labels.ts";
import type { StepId } from "../../../shared/src/types.ts";
import { isOwner, readSession } from "../auth/session.ts";
import type { RetryTarget } from "../run/machine.ts";
import { lobbyStub } from "../lobby/do.ts";
import { listRuns, runStub } from "../runs/index.ts";
import { reject } from "./request.ts";

type ApiEnv = { Bindings: Env; Variables: { login: string } };

const NOT_FOUND = "not found";

// What the dashboard reads, and the retries it asks for. Every route needs the owner's session
// cookie, the websocket upgrade included: the browser sends it there too.
export function apiRoutes(): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.use(async (c, next) => {
    // Set ahead of the checks so that the error responses carry it too. Only the websocket's 101
    // goes out without it: Hono leaves a bare Response as it is, and rebuilding one drops the
    // socket.
    c.header("Cache-Control", "no-store");
    const login = await readSession(
      c.env.SESSION_SECRET,
      c.req.header("Cookie") ?? null,
      Date.now(),
    );
    if (login === null || !isOwner(c.env.OWNER_LOGIN, login)) reject(401, "signed out");
    // The cookie is SameSite=Lax, but every Worker on the owner's workers.dev subdomain is the same
    // site. A browser names the page behind any POST.
    if (c.req.method !== "GET" && c.req.header("Origin") !== new URL(c.env.PUBLIC_URL).origin) {
      reject(403, "cross-origin request");
    }
    c.set("login", login);
    await next();
  });

  routes.get("/me", (c) => c.json({ login: c.get("login") }));

  routes.get("/runs", async (c) => c.json(await listRuns(c.env.DB)));

  routes.get("/runs/:id", async (c) => {
    const view = await runStub(c.env, c.req.param("id")).view();
    if (!view) reject(404, NOT_FOUND);
    return c.json(view);
  });

  routes.get("/runs/:id/live", async (c) => {
    if (c.req.header("Upgrade") !== "websocket") reject(426, "expected a websocket upgrade");
    const res = await runStub(c.env, c.req.param("id")).fetch(c.req.raw);
    // For a run that never started the object answers 404 in plain text; the API says it in JSON.
    if (res.status === 404) reject(404, NOT_FOUND);
    return res;
  });

  // The runs list's socket: a summary each time a run's index row is written.
  routes.get("/live", async (c) => {
    if (c.req.header("Upgrade") !== "websocket") reject(426, "expected a websocket upgrade");
    return lobbyStub(c.env).fetch(c.req.raw);
  });

  // Runs failed agents again, every one on the step or the one named, and leaves the rest of the
  // run as it stands. The run's socket shows what follows.
  routes.post("/runs/:id/steps/:step/retry", async (c) => {
    const step = STEP_ORDER.find((id): id is StepId => id === c.req.param("step"));
    if (!step) reject(404, NOT_FOUND);
    return c.json({ retried: await retry(c.env, c.req.param("id"), { step }) }, 202);
  });

  routes.post("/runs/:id/agents/:agentId/retry", async (c) => {
    const target = { agentId: c.req.param("agentId") };
    return c.json({ retried: await retry(c.env, c.req.param("id"), target) }, 202);
  });

  routes.get("/runs/:id/agents/:agentId/transcript", async (c) => {
    // A stream, passed on as it is: a transcript can run to megabytes.
    const transcript = await c.env.TRANSCRIPTS.get(
      `runs/${c.req.param("id")}/${c.req.param("agentId")}.jsonl`,
      "stream",
    );
    if (!transcript) reject(404, NOT_FOUND);
    return c.body(transcript, 200, { "Content-Type": "application/x-ndjson" });
  });

  return routes;
}

// The agents run again.
async function retry(env: Env, runId: string, target: RetryTarget): Promise<string[]> {
  const retried = await runStub(env, runId).retry(target);
  if (retried === null) reject(404, NOT_FOUND);
  // Only a failed agent can be retried, and only while the run is open.
  if (retried.length === 0) reject(409, "nothing to retry");
  return retried;
}
