# Claude connector, hosted sign-in and deploy readiness — Design

- Size: full
- Status: in review
- From: https://claude.ai/code/session_012U8BKMDCPmZpReTXvAzVWm

## What we're building

Three additions to the framework module, for a developer (the owner, or a
Claude session) building an app on simplegoapp, and through them for the
person who adds that app to Claude as a custom connector. The first app is
thetraveler (`aghchan/thetraveler`).

1. **Deploy readiness.** An app takes its listen address and its secrets
   from environment variables and can require TLS to Postgres.
2. **Sign-in (`pkg/auth`).** An app registers one service and every route
   then requires a bearer token issued by a hosted sign-in service (WorkOS
   AuthKit). Handlers read the signed-in caller from the request context.
3. **Connector (`pkg/mcp`, `app.MCP`).** An app declares tools in `main.go`
   and the framework serves them to Claude as a remote MCP server.
4. **Reference tools.** This repo's app serves two order tools at `/mcp`,
   so the pattern has a reference implementation the patrol can call.

## Why

**Problem.** thetraveler's first slice is planning through Claude (owner):
Claude searches with the owner's Expedia and Booking.com connectors and
writes the pick into the trip through a thetraveler connector. Expedia has
paused new API applications, so the app cannot search by itself. Claude
accepts a connector that reads or writes one person's data only over a
public HTTPS URL with OAuth sign-in
(https://claude.com/docs/connectors/building/authentication). The
framework has none of the three:

- No MCP endpoint.
- No sign-in. `SetAuthMiddleware` (pkg/http/middleware.go:210) is an empty
  hook, and nothing verifies a token.
- No way to run on a public host. `main.go:62-63` hardcodes `localhost` and
  `8080`, config comes from YAML only (app/app.go:44-56), and the Postgres
  DSN has no TLS setting (pkg/postgres/service.go:124-131). The Base to
  Base design already lists these as prerequisites
  (docs/superpowers/specs/2026-10-20-base-to-base-design.md §13).

**Why now.** thetraveler cannot start without them, and building them in
the project would fork the framework into it, which the API standard
rejects (docs/superpowers/specs/2026-07-14-api-standard-design.md §1).

**Success**, each line proven by a committed test named under "How we'll
know it works":

- An app that registers `auth.NewService` and an `app.MCP` entry answers an
  MCP client: `tools/list` returns its tools, and `tools/call` with a valid
  token runs the handler with the caller's subject (M1, M2, M10).
- The same app answers a call with no token with `401` and a header that
  names a metadata document, and the document names the sign-in server
  (A2, A10).
- This repo's app serves `create_order` and `get_order` at `/mcp` (M14).
- An app reads `HOST` and `PORT`, takes a secret from the environment and
  sets `sslmode` on its Postgres connection (D1, D2, D3).
- An app that registers none of this behaves as it does today (C1).

## Goals, non-goals, anti-goals

**Goals**

1. `pkg/auth` verifies a bearer token's signature, issuer, audience and
   expiry, and puts the caller in the request context. Done: A1–A9, A12.
2. Default deny. Once `auth.NewService` is registered, every route needs a
   valid token except `/health`, the metadata document and paths the app
   declares with `app.Public`. Done: A2, A10.
3. Claude can find the sign-in server from a `401`. Done: A2, A10.
4. `pkg/mcp` serves tools declared in `main.go`, with injected services,
   validated input, required annotations and masked errors. Done: M1–M13.
5. Deploy readiness. Done: D1–D3.
6. A reference tool set in this repo's app. Done: M14.
7. Apps that use none of it are unchanged. Done: C1.

**Non-goals**

- An authorization server of our own: login pages, token issuing, client
  registration. The owner chose a hosted service.
- Sign-in for the Expo app (web and iOS). It belongs to part 2 of the
  standard. `pkg/auth` takes one issuer now; a second is new config keys.
- Users, roles, sharing and invitations. Each app owns those and keys them
  on the caller's subject.
- The first real connection from Claude. It needs a deployed app and a
  WorkOS account, so it is thetraveler's acceptance, in its design. This
  design is held to the documented requirements by tests.
- The deploy pipeline (Render, Neon, Base to Base's Send it). Part 3 and
  Base to Base M4.
- MCP resources, prompts, sampling, server-to-client requests, streaming
  responses and sessions. Tools over request and response cover the need.
- Rate limiting. The framework has none on any route today, and adding it
  is a change to every app's chain.
- Moving the Ticketmaster key out of `config.yml`. It is an owner task in
  the Base to Base design §16.
- New lens rules for connectors. They wait for a second design that needs
  them.

**Anti-goals**

- A request reaching a handler without a verified caller because a route
  was forgotten.
- A token issued for another app being accepted.
- A token, an `Authorization` header, a tool argument or a tool result in
  a log line or an error body.
- A panic in one tool call stopping the process.
- An existing consumer breaking on upgrade.
- App code importing the MCP SDK or the JWT library directly
  (docs/BEST_PRACTICES.md §6).
- A paid resource appearing without the owner opting in.

## Fit with existing features

**Not duplicates.** `pkg/gmail/authorize.go` obtains Google tokens for
this app's outbound calls; `pkg/auth` verifies tokens presented to this
app. `SetAuthMiddleware` (pkg/http/middleware.go:210) is the existing seam
and stays; `pkg/auth` runs after it.

**Changed**

| Thing | Change | What existing callers see |
|---|---|---|
| `app.NewApp` (app/app.go:33) | Signature unchanged. After `resolve`, it looks up `auth.Service` the way it looks up `postgres.Service` (app/app.go:86), but optionally. | No change when `auth.NewService` is not registered. |
| `App.Run` chain (app/app.go:110-118) | `pkghttp.Auth()` (line 117) stays. The `auth.Service` middleware, when registered, is appended after it, innermost. | Same order for today's apps. A `SetAuthMiddleware` hook still runs, before `pkg/auth`. |
| `app` interface (app/app.go:18) | Gains `Handler() http.Handler`, the chain `Run` serves. `Run` calls it. | Additive. Tests use it with `httptest`. |
| Config flattening (app/app.go:58-74) | For a field with an `env:` tag: when that environment variable is set and not empty at startup, its value replaces the YAML value in the struct and in the flat map. Otherwise the YAML value is exported as today (app/app.go:68). | Changes only when the variable is already set at startup: today YAML overwrites it; after, it wins. `main.go:23` (`TWILIO_PHONE_NUMBER`) is the one tag in this repo. |
| `newRouter` (app/router.go:76) | Understands two new entries in the routes slice, `app.MCP` and `app.Public`, beside `app.Spec` (app/router.go:27) and path pairs. | Additive. |
| `pkg/postgres` `connect` (pkg/postgres/service.go:120) | Reads optional `postgres_sslmode`. Present and not empty: the DSN ends `?sslmode=<value>`. Absent or empty: the DSN is byte-identical to today. | No change without the key. |
| `pkg/http/apierror` | Gains `Unavailable(detail)` (503, code `unavailable`) and `TooLarge(detail)` (413, code `payload_too_large`). | Additive. |
| `main.go` | `app.ListenAddr("localhost", 8080)` replaces the literals (lines 62-63). The Postgres fields gain `env:` tags `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DATABASE`. The routes slice gains the `app.MCP` entry. | Same address and config unless those variables are set. One new route, `/mcp`. |

`config.yml` and `.basetobase/ci/local.yml` are not changed: this repo's
app registers no sign-in and sets no `postgres_sslmode`.

**Unchanged and relied on**

- `TimeoutMW` buffers every response and cuts a request at 10 s
  (app/app.go:116, pkg/http/middleware.go:154). The connector answers with
  one JSON body, never a stream, so it works behind it. A throwaway test
  against go-sdk v1.8.0 confirmed this.
- `CORS` answers a preflight before the auth middleware runs
  (pkg/http/middleware.go:185), so preflights need no token.
- `RequestLogger` logs method, path, status, duration and request id only
  (pkg/http/middleware.go:99-116). No header reaches a log line.
- `/health` (app/router.go:81) stays public.

**New**

- `pkg/auth/` with `pkg/auth/authtest/` (a test issuer), `pkg/mcp/`, and
  `app/tool/<name>/`, the home of tool sets, beside `app/controller/`.
- A `CLAUDE.md` in `pkg/auth/`, `pkg/mcp/` and `app/tool/`. `app/CLAUDE.md`
  gains the two entry kinds. The root `CLAUDE.md` gains a third golden
  flow, "New connector tool". `docs/BEST_PRACTICES.md` gains sign-in,
  connector tools and the `env:` rule (§4).

**Consumer not checked.** The `recruiter` repo imports `pkg/...` (Base to
Base design §3) and is not attached to this session. Every change above is
additive except the `env:` rule.

## API contract

None to `api/v1/openapi.yml`. The connector endpoint and the metadata
document are out of contract, as `/health` and websockets are
(api/CLAUDE.md:21): their shape is fixed by the MCP specification and RFC
9728, not by this app's contract.

**Go surface**

```go
// package app
func ListenAddr(defaultHost string, defaultPort int) (string, int)
func MCP(path string, info mcp.Info, toolSets ...mcp.ToolSet) interface{}
func Public(paths ...string) interface{}

// package auth
type Service interface {
    Verify(ctx context.Context, token string) (Identity, error)
    Middleware(publicPaths []string) pkghttp.Middleware
    ResourceMetadata() ResourceMetadata
}
type Identity struct {
    Subject string         // the token's sub
    Scopes  []string       // the token's scope, split on spaces
    Claims  map[string]any // every claim of the verified token
}
type ResourceMetadata struct {
    Resource             string   `json:"resource"`
    AuthorizationServers []string `json:"authorization_servers"`
    BearerMethods        []string `json:"bearer_methods_supported"`
}
func NewService(config map[string]interface{}, logger logger.Logger) Service
func FromContext(ctx context.Context) (Identity, bool)
var ErrInvalidToken, ErrUnavailable error

// package mcp
type Info struct{ Name, Version string }
type Spec struct {
    Name        string // ^[a-z][a-z0-9_]{0,63}$
    Title       string // required
    Description string // required
    ReadOnly    bool
    Destructive bool // only with ReadOnly false
    Idempotent  bool // only with ReadOnly false
}
type Tool struct{ /* unexported */ }
type ToolSet interface{ Tools() []Tool }
func NewTool[In, Out any](spec Spec, handler func(ctx context.Context, in In) (Out, error)) Tool
func Errorf(format string, args ...any) error
func NewHandler(logger logger.Logger, info Info, tools []Tool) http.Handler
```

- `ListenAddr` returns `HOST` and `PORT` when set and not empty, else the
  defaults. A `PORT` that is not an integer from 1 to 65535 panics with
  `PORT must be a port number, got "<value>"`.
- A tool set is a pointer to a struct. `newRouter` injects its exported
  fields by type, as it does a controller's (app/router.go:42). A field
  with no provider panics with the existing message.
- `In` is a struct. Its JSON schema is inferred from the type; a `json`
  tag names a field and a `jsonschema` tag describes it. Unknown fields
  are refused. `Out` is a struct.
- `auth.NewService` returns one value, as the resolver requires
  (app/resolver.go:132). Bad config panics, naming the key.

**Registration mistakes**, each a startup panic with a named message, as
the router's are (app/CLAUDE.md): a second `app.MCP` entry; a path not
starting with `/`; no tool set; an empty `Info.Name` or `Info.Version`; a
tool set that is not a pointer to a struct; a tool name that breaks the
pattern or repeats; an empty `Title` or `Description`; `Destructive` or
`Idempotent` with `ReadOnly`; a nil handler; more than 64 tools; `In` or
`Out` that is not a struct; an `app.Public` path not starting with `/`.

**Routes**

| Route | Registered when | Caller |
|---|---|---|
| `POST <path>` | an `app.MCP` entry | signed-in user when `auth.Service` is registered, else anonymous |
| `GET /.well-known/oauth-protected-resource` | `auth.Service` is registered | anonymous |
| `GET /.well-known/oauth-protected-resource<P>` | same, and `P`, the path of `auth_resource`, is neither empty nor `/` | anonymous |

**Metadata document.** `200`, `Content-Type: application/json`, body
`{"resource":"<auth_resource>","authorization_servers":["<auth_issuer>"],"bearer_methods_supported":["header"]}`.
Another method gets the router's `405` problem (app/router.go:88).

**Connector endpoint.** MCP Streamable HTTP in the SDK's stateless mode
with JSON responses: no session id is read or set. Tool annotations sent:
`title`, `readOnlyHint`, `idempotentHint`, `destructiveHint` (always
present when `ReadOnly` is false), and `openWorldHint: false`.

| Request | Response |
|---|---|
| `initialize`, `ping`, `tools/list` | `200`, JSON-RPC result |
| `tools/call`, handler returns a value | `200`, result with `structuredContent` and the same JSON as text |
| `tools/call`, arguments fail the schema (missing, wrong type, unknown field) | `200`, result with `isError: true` and the validator's message. The handler does not run. |
| `tools/call`, handler returns `mcp.Errorf(...)` | `200`, `isError: true`, text is that message |
| `tools/call`, handler returns any other error, or panics | `200`, `isError: true`, text `internal error`. The error or panic is logged with the request id. |
| `tools/call`, result JSON over 1 MiB | `200`, `isError: true`, text `result too large` |
| `tools/call`, unknown tool | `200`, JSON-RPC error `-32602` |
| Any other MCP method | the SDK's default answer (an empty list for `resources/list`) |
| Body over 1 MiB | `413` problem, code `payload_too_large` |
| Body that is not a JSON-RPC message | `400`, the SDK's plain-text body |
| `GET` or `DELETE` | `405`, the SDK's body |
| Handler still running at 10 s | `504` problem, code `timeout` (pkg/http/apierror/apierror.go:30) |

**Sign-in failures**, on every path that is not public, when
`auth.Service` is registered:

| Case | Response |
|---|---|
| No `Authorization` header, or not `Bearer <token>`, or a token over 8 KiB | `401` problem, code `unauthorized`, detail `authentication required`, header `WWW-Authenticate: Bearer resource_metadata="<M>"` |
| A token that fails any check | `401` problem, code `unauthorized`, detail `invalid token`, header `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="<M>"` |
| No verification key available | `503` problem, code `unavailable`, detail `sign-in service unavailable` |

`<M>` is the origin of `auth_resource`, then
`/.well-known/oauth-protected-resource`, then `P`.

## Data model and migrations

None. `pkg/auth` keeps verification keys in memory and `pkg/mcp` keeps no
state between requests. Users and their data are each app's tables.

## Scaling

**Numbers.** thetraveler: 10 signed-in users, 100 tool calls an hour in a
planning session, a peak of 2 requests a second. The framework parts are
sized for 50 requests a second on one instance.

| Bound | Value |
|---|---|
| Connector request body | 1 MiB |
| Tool result | 1 MiB |
| Tools per endpoint | 64 |
| Bearer token | 8 KiB |
| Verification keys held | 16; a larger key set is refused and the keys held are kept |

**Hot path, per request.** Sign-in: one signature check and no outbound
call while keys are held. Connector: one JSON decode, one schema check,
the handler, one JSON encode. No query and no outbound call come from the
framework.

**Outbound calls.** One key-set fetch an hour; one more per unknown key
id, at most once every 5 minutes; with no key held, at most once every
10 s. Each fetch times out at 5 s. This holds at any request rate, so a
flood of bad tokens causes no fetches beyond these.

**Concurrency.** Services are singletons. The key set is replaced under a
lock, and one fetch runs at a time. The tool list is built at startup and
never written again. `pkg/mcp` holds no per-caller state, so instances
scale side by side with nothing shared.

**What breaks first.** At 50 requests a second and at 500, the framework
adds under a millisecond of CPU per request; the handlers and the host's
CPU give out first. At any rate, a handler slower than 10 s is cut
(app/app.go:116).

No cache, queue or table is added.

## Infrastructure and dependencies

**Libraries**, pinned in `go.mod`:

| Library | Version | For |
|---|---|---|
| `github.com/modelcontextprotocol/go-sdk` | v1.8.0 | the MCP server. Needs Go 1.25.0, which `go.mod` already states. |
| `github.com/golang-jwt/jwt/v5` | v5.3.1 | token parsing and checks. The SDK already requires it. |
| `github.com/MicahParks/keyfunc/v3` | v3.9.2 | fetching and caching the issuer's key set. Brings `github.com/MicahParks/jwkset` v0.11.4 and `golang.org/x/time` v0.15.0. |

**Service.** WorkOS AuthKit, the hosted sign-in service. This repo's tests
and reference app never call it: tests sign tokens with
`pkg/auth/authtest`. An app that registers sign-in needs a WorkOS
environment with Client ID Metadata Document enabled and a Resource
Indicator equal to its `auth_resource`
(https://workos.com/docs/authkit/mcp).

- Unit price: $0 for the first 1,000,000 monthly active users, then $2,500
  a month per further million. Staging environments are free
  (https://workos.com/pricing).
- Against "Scaling": 10 users is 0.001% of the free allowance.
- Not used: a custom domain ($99 a month). The issuer is the default
  AuthKit domain.
- Not stated on the pricing page: whether sign-up asks for a card.
- Monthly total at the stated numbers: $0.

**Config keys.** Read by `auth.NewService` from the flat config map; an
app declares them in its config struct with these `config:` names.

| Key | Required | Default | Meaning |
|---|---|---|---|
| `auth_provider` | yes | none | `workos`. Empty or unknown panics, as `llm_provider` errors (pkg/llm/service.go:68-79). |
| `auth_issuer` | yes | none | The AuthKit domain, `https://…`. The token's `iss` must equal it. |
| `auth_resource` | yes | none | The app's public connector URL exactly as entered in Claude. The token's `aud` must contain it. With `ENV=PRODUCTION` it must start `https://`, else a panic. |
| `auth_jwks_url` | no | `<auth_issuer>/oauth2/jwks` | The key set. The test seam. |
| `postgres_sslmode` | no | absent | Read by `pkg/postgres`. |

**Environment variables.** `HOST` and `PORT`, read by `app.ListenAddr`.
Any variable an app names in an `env:` tag.

**Secrets.** None added: verification uses the issuer's public keys. A
secret an app already has, the Postgres password first, leaves YAML
through its `env:` tag. Source: the host's environment settings. Holder:
the owner. Rotation: change the host's setting and restart.

**Nothing else to run.** No queue, cache, schedule, bucket or webhook.

**Switching off.** Remove `auth.NewService` and the `app.MCP` entry from
`main.go`. Nothing in this repo is left to tear down.

## Security

**Callers**

| Route | Caller |
|---|---|
| `/health`, the metadata document, `app.Public` paths | anonymous |
| every other route, the connector included, with `auth.Service` registered | a signed-in user: a valid AuthKit access token for this app |
| every route, without `auth.Service` | anonymous, as today. `NewApp` logs `auth: not registered, every route is public` once at startup. |

`app.Public` matches the request path exactly. It has no prefixes or
patterns, so a path is never public by accident.

**Token checks**, all required:

- Read from the `Authorization: Bearer` header only, never the query
  string. At most 8 KiB.
- Signed with RS256 or ES256 by a key in the issuer's key set. `none` and
  every symmetric algorithm are refused.
- `iss` equals `auth_issuer`. `aud` contains `auth_resource`, compared as
  exact strings.
- `exp` is present and not passed; `nbf`, when present, is reached. Both
  allow 30 s of clock skew.
- `sub` is not empty.
- Provider `workos`: a token whose `sub_profile` is `ai_agent` is refused,
  as WorkOS's guide requires.

**Who may touch what.** The caller's identity comes only from the verified
token. No header, query or tool argument can set it. Checking that a
caller owns a record is the app's job, with `Identity.Subject`.

**Input at the edge.** The connector body is capped at 1 MiB. Tool
arguments are checked against the schema inferred from `In`, with unknown
fields refused, before the handler runs. Length and range limits are the
tool set's job, as they are the controller's (api/CLAUDE.md). The key-set
URL comes from config, never from a request.

**Logs and errors.** Logged per tool call: tool name, caller subject,
outcome, duration and request id. Never logged: a token, a header, an
argument or a result. The subject is the sign-in service's opaque user id,
kept as long as the host keeps logs. A `401` body says one of two fixed
phrases and never which check failed. An unexpected error or a panic is
logged and the caller sees `internal error`.

**Unauthenticated routes.** `/health` and the metadata document do no I/O
and return a fixed body. A request with a bad token costs one signature
check at most, and causes no outbound call beyond the bounds in "Scaling".
There is no rate limit (non-goal).

**Secrets and personal data.** No secret is added and none is written to
`config.yml`. Token claims live in memory for one request. Nothing is
stored.

**Not checked.** Revocation: a revoked user's token works until it
expires, 5 minutes by AuthKit's default.

**Other.** No inbound callback: OAuth redirects go to Claude and to
AuthKit, never to the app. The app never forwards a caller's token. The
SDK's protection against DNS rebinding stays on.

## Failure and rollback

| Failure | Behaviour |
|---|---|
| Key set unreachable, keys held | The held keys keep verifying. Refresh is retried on the hourly schedule. |
| Key set unreachable, no key held | Protected routes answer `503`; public routes work. Startup never waits for the key set. A fetch is retried at most every 10 s. |
| Issuer rotates its keys | A token with an unknown key id triggers a fetch, at most once every 5 minutes. |
| AuthKit down for sign-in | Tokens already issued work until they expire. New sign-ins fail at AuthKit; the app does nothing. |
| A tool handler panics | The call returns `internal error`, the panic is logged, the process keeps running. `Recover` cannot catch it: the SDK runs handlers on its own goroutine. |
| A tool handler runs past 10 s | `504` from the existing chain. |
| A bad release of the framework | An app goes back to the previous module version. There is no data to undo. |

One limit on rollback: an app that takes a secret from the environment
cannot go back past the release that adds the `env:` rule without putting
that secret in YAML, because older versions read YAML only.

## How we'll know it works

All tests run in `go test ./... -count=1 -race`, which CI already runs
(.github/workflows/ci.yml). None needs a database, a network or a WorkOS
account. End-to-end tests build an app with `app.NewApp`, a fake
`postgres.Service` registered in the service slice, and a `local.yml`
written to `t.TempDir()` after `t.Chdir`, then call `Handler()` through
`httptest`. Tokens are signed by `authtest`, an in-process issuer that
serves a key set and counts fetches.

**Sign-in** (`pkg/auth`, and end to end in `app/`)

- A1. A valid token on a protected path: `200`, and the handler reads the
  token's `sub` from `auth.FromContext`.
- A2. No header on a protected path: `401`, `application/problem+json`,
  code `unauthorized`, detail `authentication required`, and the exact
  `WWW-Authenticate` value.
- A3. Expired by 40 s: `401`, detail `invalid token`. Expired by 20 s:
  `200`.
- A4. Wrong `iss`: `401`. A5. `aud` without `auth_resource`: `401`.
- A6. `alg: none`, and an HS256 token signed with the public key: `401`.
- A7. An unknown key id, sent 20 times: `401` each time and one fetch.
- A8. `sub_profile: ai_agent`: `401`. Empty `sub`: `401`.
- A9. A valid token in `?access_token=` with no header: `401`. A 9 KiB
  token: `401`.
- A10. With no token: `/health` is `200`; an `app.Public` path is `200`;
  both metadata paths return the exact document.
- A11. Key-set server down from the start: `503`, code `unavailable`.
  Server up and 10 s of the test's clock later: `200`.
- A12. Startup panics, by message: empty `auth_issuer`; unknown
  `auth_provider`; `ENV=PRODUCTION` with an `http://` `auth_resource`.
- A13. A `SetAuthMiddleware` hook and `auth.Service` together: the hook
  runs first, then the token check.

**Connector** (`pkg/mcp`, and end to end in `app/` with the SDK's client)

- M1. `initialize`, then `tools/list`: each tool's name, title,
  description, annotations and input schema.
- M2. `tools/call` with valid arguments: the handler's output as
  `structuredContent`.
- M3. Missing field, wrong type, unknown field: `isError: true`, and a
  counter shows the handler did not run.
- M4. `mcp.Errorf("order not found")`: that text. `errors.New("db
  password")`: text `internal error`, and the log holds the error.
- M5. A handler that panics: `isError: true`, and a second call succeeds.
- M6. Unknown tool: JSON-RPC error `-32602`.
- M7. `GET` and `DELETE`: `405`.
- M8. A 2 MiB body: `413`. A 2 MiB result: `isError: true`, `result too
  large`.
- M9. A handler that sleeps 11 s: `504`, code `timeout`.
- M10. With sign-in: no token is A2's response on the connector path; a
  valid token and the handler returns the caller's subject.
- M11. A raw `POST` with no session header: `200`, `application/json`, no
  `Mcp-Session-Id` in the response.
- M12. Fifty concurrent `tools/call` under `-race`: fifty results.
- M13. Each registration mistake in "API contract" panics with its
  message.
- M14. This repo's app: `create_order` then `get_order` returns the
  order; `get_order` for an unknown id returns `order not found`.

**Deploy readiness**

- D1. `ListenAddr`: unset returns the defaults; `HOST=0.0.0.0 PORT=9000`
  returns them; `PORT=abc` panics with the message.
- D2. Config: with the variable set, the struct field and the flat map
  hold its value; unset, they hold the YAML value and the variable is
  exported.
- D3. The DSN: with `postgres_sslmode: require` it ends
  `?sslmode=require`; without the key it equals today's string.

**Compatibility**

- C1. The existing tests pass unchanged, and an app with no `auth.Service`
  and no `app.MCP` entry answers `/health` and its routes with no token.

**Evidence a reviewer sees.** The test output naming A1–A13, M1–M14,
D1–D3 and C1, and from the running reference app the response to a
`tools/list` request at `/mcp`.

## Approaches

**Sign-in**

1. **A hosted sign-in service; the framework only verifies tokens**
   (picked, owner). Days of work and a small security surface. It depends
   on a vendor.
2. **An authorization server in the framework.** No vendor, but login,
   token issuing and client registration become the most security-
   sensitive code in the framework. Rejected by the owner.
3. **No sign-in, a secret in the connector URL.** Rejected: Claude's
   guide and the MCP specification forbid a token in a URL, and it names
   no user.

**The hosted service.** WorkOS AuthKit (picked): its guide covers MCP
directly, it supports Client ID Metadata Documents and dynamic
registration, it puts the connector URL in the token's `aud`, it
publishes a key set, and 1,000,000 users are free. Clerk has the best
Expo components and 50,000 free users, but its connector tokens are
verified differently from its session tokens. Auth0 supports MCP since
May 2026 with 25,000 free users and more setup.

**Serving the connector**

1. **The official Go SDK behind `pkg/mcp`** (picked). The protocol is the
   SDK's job; the framework adds registration, injection and error
   masking.
2. **A hand-written JSON-RPC endpoint.** One less dependency, and every
   protocol revision becomes our work.
3. **Tools generated from `openapi.yml`.** Spec-first, but a REST
   operation and a tool a model can use well are cut differently, and
   oapi-codegen has no such generator.
4. **A separate TypeScript connector calling the Go API.** A second
   deploy, and the caller's token must be passed on.

## Delivery

Three PRs, in this order. Each names this design and its part.

- **§1 Deploy readiness.** `app.ListenAddr`, the `env:` rule,
  `postgres_sslmode`, the `main.go` changes for address and tags, and
  `docs/BEST_PRACTICES.md` §4. Tests D1–D3.
- **§2 Sign-in.** `pkg/auth`, `pkg/auth/authtest`, `Handler()`,
  `app.Public`, the metadata routes, `apierror.Unavailable`, the two
  libraries, and the docs for sign-in. Tests A1–A13 and C1.
- **§3 Connector.** `pkg/mcp`, `app.MCP`, `apierror.TooLarge`, the SDK,
  `app/tool/orders` with its `main.go` entry, and the docs and golden
  flow. Tests M1–M14.

§2 does not need §1. §3 needs §2 for `Handler()` and `auth.FromContext`.

## Decisions

- Plan through Claude, with thetraveler as a connector **(owner)**.
- Shared pieces are built in the framework, not in the project
  **(owner)**.
- Sign-in is a hosted service, not built into the framework **(owner)**.
- Free hosting with no card (Base to Base design §3) **(owner)**.
- WorkOS AuthKit is the hosted service **(designer's call)**.
- One provider, named by a required `auth_provider`
  **(designer's call)**.
- Default deny, with exact-match public paths declared in `main.go`
  **(designer's call)**.
- `pkg/auth` runs after the `SetAuthMiddleware` hook, and both may be
  set **(designer's call)**.
- The `env:` rule: a variable already set wins over YAML
  **(designer's call)**.
- `postgres_sslmode` is optional and absent means today's DSN
  **(designer's call)**.
- The connector is stateless with JSON responses, tools only, one
  endpoint per app **(designer's call)**.
- Protocol errors on the connector path keep the SDK's bodies; only the
  framework's own `401`, `413`, `503` and `504` are problems
  **(designer's call)**.
- The bounds: 1 MiB body and result, 64 tools, 8 KiB token, 16 keys, 30 s
  skew, and the fetch limits **(designer's call)**.
- A tool's error is masked unless built with `mcp.Errorf`
  **(designer's call)**.
- Tool sets live in `app/tool/<name>/` **(designer's call)**.
- This repo's app serves the order tools with no sign-in, as it serves
  its REST routes **(designer's call)**.
- keyfunc for the key set, not hand-written code **(designer's call)**.
- The first real connection from Claude is thetraveler's acceptance
  **(designer's call)**.
- No release tag here; thetraveler pins the merge commit of §3
  **(designer's call)**.

## Left to the builder

- File names and unexported names inside `pkg/auth`, `pkg/mcp` and
  `app/tool/orders`.
- Whether the metadata handler is hand-written or the SDK's helper; the
  bytes are fixed above.
- How `app.MCP` and `app.Public` entries are represented inside the
  router.
- Log field names beyond the five listed under "Security".
- How `authtest` moves its clock for A3 and A11.
- The wording of the new `CLAUDE.md` files and doc sections.

## Design review

Panel: BLD, GOAL, QLT, SCL, INF, SEC, FUN. Why: full design with no screen.

Round 1:
- BLD-1 Reference order tools have no inputs, outputs, annotations or service mapping
- BLD-2 No clock seam in the public signature, yet A3 and A11 depend on one
- BLD-3 405 for GET/DELETE on the connector: SDK body or router problem
- BLD-4 Order of checks among 401 and 503 is open
- BLD-5 `env:` rule silent on non-string fields and where the override is applied
- GOAL-1 Goal 7 and the 'existing consumer' anti-goal contradict the env: rule
- GOAL-2 An app can serve MCP with no sign-in and still meet every goal
- GOAL-3 Success line does not check the problem: Claude accepting the connector
- GOAL-4 No-card and no-paid-resource constraints rest on an unanswered question
- GOAL-5 Identity.Scopes and Identity.Claims serve no goal
- GOAL-6 Order tools in the production app go beyond what the Why needs
- GOAL-7 Tests A11 and A13 are named by no goal's 'Done' line
- QLT-1 Reference order tools may duplicate OrdersController validation and error mapping; design does not say where it lives
- QLT-2 newRouter and NewApp must carry public paths and the MCP handler, but the Changed table lists no signature change and no caller outcome
- QLT-3 Claim that tool-set injection works "as it does a controller's" and covers "exported fields" does not match injectFields
- QLT-4 The env: rule is silent on non-string tagged fields and on the mandatory config file that env-only deploys still need
- QLT-5 pkg/auth is a second auth seam beside SetAuthMiddleware, with two ordering rules to remember
- SCL-1 Timed-out handlers keep running; in-flight work is unbounded
- SCL-2 Memory per request at the stated bounds is not worked
- SCL-3 Key-set download has no byte cap; only the key count is bounded
- SCL-4 Is the key-set lock held across the outbound fetch?
- SCL-5 Reference order tools: per-call cost and argument bounds not stated
- SCL-6 'Sized for 50 rps' and 'under a millisecond of CPU' have no number or test behind them
- INF-1 Public host and Postgres host are needed but not listed, so the $0 total is incomplete
- INF-2 auth_* config keys have no stated place where they are set
- INF-3 WorkOS free-tier limits and card requirement unstated, against an owner decision of no card
- INF-4 Pay-per-use WorkOS MAU has no cap, alert or owner opt-in
- INF-5 Switching off leaves the WorkOS environment and its settings in place
- INF-6 keyfunc/jwkset adds two modules for fetching a key set under custom bounds
- SEC-1 Any self-registered AuthKit user passes as the 'signed-in user'
- SEC-2 Reference /mcp order tools are anonymous, with no stated owner check on get_order
- SEC-3 A production deploy with no auth.Service silently serves every route anonymously
- SEC-4 No transport check on auth_issuer and auth_jwks_url in production
- SEC-5 What a logged handler error or panic may contain is not bounded
- SEC-6 A committed, real-looking API key stays in config.yml for a public deployment
- SEC-7 Input bounds for tool arguments are left to each tool set; none are stated for the order tools
- FUN-1 Anti-goal 'no token, header, argument or result in a log line' has no test
- FUN-2 Key-set behaviour in Scaling and Failure is mostly untested
- FUN-3 Token and header edge cases missing from A1-A9
- FUN-4 Public-path exactness and unknown-path behaviour untested and unspecified
- FUN-5 Rows of the connector response table have no test
- FUN-6 Missing Accept/Content-Type, protocol-version header and rebinding protection behaviour on POST
- FUN-7 Behaviour left open in tools and unauthenticated connector
- FUN-8 D1-D3 miss the boundaries of the env, PORT and sslmode rules
- FUN-9 Rollback and compatibility claims have no test that runs them
- FUN-10 A handler panic claim: 'Recover cannot catch it' is stated, not shown; M5 may pass for the wrong reason
- FUN-11 A11 and A3 depend on a test clock whose mechanism is left open; reviewer evidence for sign-in is missing
- FUN-12 Choosing 200 + isError for schema-invalid arguments and a stateless endpoint is not justified against the tests that prove it
