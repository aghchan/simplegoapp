# Standardized API Structure — Design

**Goal:** a single standard for every API built from simplegoapp: one contract
format, one wire convention, one layout, one middleware chain — enforced by
code generation rather than discipline.

**Decisions made:** spec-first OpenAPI (contract is source of truth); JSON now
with encoding negotiation designed in (no protobuf — revisit via ConnectRPC
only if a protobuf consumer materializes); scope covers wire contract, OpenAPI
docs, and layout/middleware; handlers stay conventional Go (no third-party
handler framework). Amended after adversarial review (2026-07-14).

## 1. Delivery model: framework module + thin template

Two artifacts, not one:

- **Framework module** (this repo): `pkg/http`, `pkg/logger`, datastores, the
  DI container. Versioned; consumed as a normal Go dependency. Bug fixes and
  standard evolution propagate to every API via `go get -u`.
- **Template skeleton** (`gonew` target): only `main.go`, `api/`,
  `app/controller/`, `app/router.go`, `domain/`, `config.yml`, `Makefile`.
  It imports the framework module. What gets copied is the part each API is
  *supposed* to own; the standard itself is never forked.

This split exists because a pure template copy would fork the framework into
every API and strand fixes (adversarial-review finding).

## 2. Contract & layout

The contract lives at `api/v1/openapi.yml`, reviewed before implementation
code exists. `make api` runs `oapi-codegen` (pinned tool dependency) with
`gorilla-server` + `types` generation in **standard (non-strict) mode** into
`api/v1/gen.go` (package `apiv1`):

- typed request/response structs from the schemas
- a `ServerInterface` (one method per operation) and `HandlerWithOptions`
  registration for gorilla/mux

Standard vs strict mode is load-bearing: strict mode decodes bodies and writes
responses with hardcoded `encoding/json` in generated code, which would kill
content negotiation. In standard mode generated code binds path/query params
only; bodies and responses flow through the framework's codec helpers (§4).

Versioned directories from day one: a breaking change adds `api/v2/` beside
`api/v1/` — two specs, two generated packages, two mounts. `v1` is immutable
once published.

Shared shapes (pagination, problem schema) are **vendored into the template's
spec**, not `$ref`'d to a central URL: each API owns its contract copy, and
conformance is maintained by the template, the reference implementation, and
review — a central ref would silently break old copies when it evolved.

Standard tree (template skeleton):

```
api/v1/          openapi.yml + gen.go (generated; committed; CI-diff-checked)
app/controller/  one package per resource, implements apiv1.ServerInterface
app/router.go    app-local: DI injection + generated mount + socket routes
domain/          business logic, transport-agnostic (no api/ or http imports)
main.go          composition root
```

CI runs `make api && git diff --exit-code api/` so spec and code cannot drift.

## 3. Wire contract

- **Success:** plain resource JSON, no envelope. 200 (read/update), 201 with
  `Location` (create), 204 (delete/no body).
- **Errors:** RFC 9457 `application/problem+json`: `type`, `title`, `status`,
  `detail`, `instance`, plus a stable machine-readable `code` extension.
  New `pkg/http/apierror` package: typed constructors (`NotFound`, `Invalid`,
  `Conflict`, `Unauthorized`, `Internal`, …) with fixed status mappings and a
  `Write(w, err)` translator (supersedes the everything-is-500
  `InternalError`). Unknown errors never leak internals: generic 500 problem,
  full error logged with request ID.
- **Pagination:** one list shape — `items` array + `next_cursor` string
  (empty = end), `limit`/`cursor` query params — via the vendored components.
- **Out-of-contract routes, explicitly:** `/health` (framework-registered)
  and websocket endpoints (`SOCKET` convention) are declared exempt from the
  OpenAPI contract. Everything else must appear in the spec.

## 4. Encoding

`pkg/http` codec registry:

```go
type Codec interface {
    MediaType() string
    Encode(w io.Writer, v interface{}) error
    Decode(r io.Reader, v interface{}) error
}
```

Controllers use `Bind(r, &req)` / `Respond(w, r, status, v)`; negotiation is
inside those helpers. Bodies decode per `Content-Type` (unsupported ⇒ 415
problem); responses encode per `Accept` (unsupported ⇒ 406; absent ⇒ JSON).
JSON is the only codec at launch. Later binary codecs reuse the generated
types' `json` tags: `fxamacker/cbor` honors `json` tags natively (verified in
its docs); `vmihailenco/msgpack` does via `SetCustomStructTag("json")`.

## 5. Middleware chain

Applied once around the router (not `router.Use`, so unrouted requests are
still covered), outermost first. **The order is load-bearing** (revised during
implementation review; see `app/app.go`):

1. request ID — generate or propagate `X-Request-Id`
2. request logging — method, path, status, duration, request ID (outside
   recovery so panicking requests still emit a request line with status 500)
3. panic recovery — log stack + request ID, emit 500 problem; re-panics
   `http.ErrAbortHandler`; never rewrites an already-committed response
4. CORS — env-driven origin plus preflight short-circuit handled in the
   middleware itself (before timeout, so 504s carry CORS headers)
5. timeout — custom buffered-writer middleware (a timeout cannot race a
   half-written response), 504 problem, websocket upgrades bypass; single
   default deadline, per-route overrides deferred (YAGNI)
6. auth hook — no-op slot each app may replace; template ships no auth opinion

## 6. DI integration & routing

Controllers keep today's DI: structs with injected service interface fields,
registered in `main.go`. The framework exposes its field-injection as a helper
so `app/router.go` (app-local, skeleton-owned) can:

1. inject dependencies into each controller struct,
2. mount spec controllers via `apiv1.HandlerWithOptions(controller,
   GorillaServerOptions{BaseRouter: r})` under `/v1`,
3. keep verb-method/`SOCKET` reflection registration for out-of-contract
   routes only — the "must have a verb method" panic no longer applies to
   `ServerInterface` controllers.

## 7. Testing & reference implementation

- unit tests in `pkg/http` for the error model, codec negotiation, and
  middleware (request ID propagation, recovery, timeout)
- the template ships the example resource implemented spec-first end-to-end
  (spec → generated types → controller → httptest against the wired router)
  as the living reference every new API copies

**Out of scope (YAGNI):** protobuf/gRPC, enveloped successes, spec linting
gates, generated clients, auth implementation, per-route timeout overrides.

The template skeleton initially lives in this repo under `template/` as its
own module; extraction to a dedicated repo is a later step and does not change
the standard.

## Appendix: worked example (developer experience)

Creating an `orders` API:

1. `gonew <template> github.com/acme/orders-api` — skeleton with `api/v1/`,
   controllers, router, Makefile, importing the framework module.
2. Author `api/v1/openapi.yml` (operations `listOrders`, `createOrder`,
   `getOrder`; vendored Problem + pagination components). Contract reviewed
   before code exists.
3. `make api` → `api/v1/gen.go`: request/response types and
   `ServerInterface { ListOrders(...); CreateOrder(...); GetOrder(...) }`.
   Unimplemented operations are compile errors.
4. Controller implements the interface with injected services; bodies via
   `Bind`, responses via `Respond`, failures via `Problem` — encoding and
   error format never hand-rolled.
5. Wire results: 201 + `Location` on create; 400/404 as RFC 9457
   `application/problem+json` with stable `code`; lists as
   `{items, next_cursor}`; `Accept: application/cbor` → 406 until a codec is
   registered; every response carries `X-Request-Id` and one structured log
   line; panics become 500 problems.
