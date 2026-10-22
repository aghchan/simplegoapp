import { Hono } from "hono";

// What the deploy job polls to see the version it shipped serving (scripts/src/ci-deploy.ts).
// Public: it names only the version and the commit it was tagged with, which the repo shows anyway.
export function healthRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get("/", async (c) => {
    c.header("Cache-Control", "no-store");
    const { id, tag } = c.env.CF_VERSION_METADATA;
    // A version deployed by hand (`npm run deploy`) carries no tag.
    const version = { version: id, tag: tag || null };
    try {
      // The binding a bad deploy is likeliest to break; the Durable Objects need no config to reach.
      await c.env.DB.prepare("SELECT 1").first();
    } catch {
      return c.json({ ok: false, ...version }, 503);
    }
    return c.json({ ok: true, ...version });
  });

  return routes;
}
