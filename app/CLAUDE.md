# app/ — DI container + router

## Expected flow

Startup: main.go passes constructors → resolver.go topo-sorts (Kahn) and calls
each once → router.go injects singletons into controller fields by type →
Run() wraps the router in the middleware chain.

## Resolver rules (resolver.go)

- Constructors: non-variadic, exactly one interface/pointer return.
- `logger.Logger` and the config map are builtins — never register providers
  for them (startup error).
- Duplicate providers: last registered wins deterministically; the overridden
  constructor never runs (use to swap fakes in after defaults).
- Init order is registration order among independents — fully deterministic.
- postgres.NewService is mandatory (migrations run at startup).

## Router rules (router.go)

- Two registration styles in the routes slice: `app.Spec(ctrl, mount)` for
  generated APIs (exempt from the verb-method rule), and `"path", &Ctrl{}`
  pairs whose exported fields are injected and verb-named methods
  (GET/POST/PUT/DELETE/SOCKET) become routes.
- Pass the SAME controller pointer to Spec and to HandlerWithOptions inside
  the mount closure — injection targets the Spec argument.
- All registration mistakes panic at startup with named messages; keep it
  that way when editing.
- Middleware chain order in app.go Run() is load-bearing (logging outside
  recovery; CORS outside timeout) — do not reorder without reading the
  rationale in docs/superpowers/specs/2026-07-14-api-standard-design.md §5.
