import { Hono } from "hono";
import { isOwner, readSession } from "../auth/session.ts";
import { lobbyStub } from "../lobby/do.ts";
import { listRuns, runStub } from "../runs/index.ts";
import { reject } from "./request.ts";

type ApiEnv = { Bindings: Env; Variables: { login: string } };

const NOT_FOUND = "not found";

// What the dashboard reads. Every route needs the owner's session cookie, the websocket upgrade
// included: the browser sends it there too.
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
