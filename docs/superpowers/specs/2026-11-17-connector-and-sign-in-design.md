# Claude connector, hosted sign-in and deploy readiness — Design

- Size: full
- Status: in review
- From: https://claude.ai/code/session_012U8BKMDCPmZpReTXvAzVWm

## What we're building

Three additions to the framework module. They serve a developer (the
owner, or a Claude session) building an app on simplegoapp, and through
them the person who adds that app to Claude as a custom connector. The
first app is thetraveler (`aghchan/thetraveler`).

1. **Deploy readiness.** An app takes its listen address and its secrets
   from environment variables, and in production it connects to Postgres
   only over TLS. This repo's committed secrets leave `config.yml`.
2. **Sign-in (`pkg/auth`).** An app registers one service, and every route
   then requires a bearer token issued by a hosted sign-in service (WorkOS
   AuthKit), except `/health` and the sign-in discovery paths. Handlers read
   the signed-in caller from the request context.
3. **Connector (`pkg/mcp`, `app.MCP`).** An app declares tools in `main.go`
   and the framework serves them to Claude as a remote MCP server. An app
   that declares tools without sign-in does not start.

This repo's app serves no tools. A tool set defined in the tests proves the
pattern end to end (owner).

## Why

**Problem.** thetraveler's first slice is planning through Claude (owner).
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
  `8080`, and config comes from YAML only (app/app.go:44-56). The Postgres
  DSN has no TLS setting (pkg/postgres/service.go:124-131). The Base to
  Base design already lists these as prerequisites
  (docs/superpowers/specs/2026-10-20-base-to-base-design.md §13).

**Why now.** thetraveler cannot start without them. Building them in the
project would fork the framework into it, which the API standard rejects
(docs/superpowers/specs/2026-07-14-api-standard-design.md §1).

**Success.** This design is proven by tests written against the documented
requirements below. The first real connection from Claude is part of
thetraveler's acceptance, which deploys anyway (owner).

| Documented requirement | Source | Tests |
|---|---|---|
| An unauthenticated call gets `401` with `WWW-Authenticate: Bearer resource_metadata="…"` | Claude's connector authentication guide | A2 |
| The metadata `resource` equals the connector URL exactly; the first `authorization_servers` entry is the issuer | same | A11 |
| A token is read from the header, never the query string | same; MCP authorization spec | A10 |
| The token's `aud` matches the connector URL; agent tokens are refused | WorkOS AuthKit MCP guide | A7, A9 |
| `tools/list` and `tools/call` over Streamable HTTP | MCP 2025-11-25 transports | M1, M2, M12 |
| Tools carry annotations | Claude's connector guide | M1 |
| Input validation errors are tool execution errors; an unknown tool is a protocol error | MCP 2025-11-25 tools, "Error Handling" | M3, M6 |
| An app reads its listen address from `HOST` and `PORT` | Base to Base design §13 | D1, D5 |
| Secrets come from the host's environment, not a committed file | Base to Base design §13 | D2, D4 |
| In production, Postgres is reached over TLS with a real user and password | Base to Base design §13; owner | D3 |

## Goals, non-goals, anti-goals

**Goals**

1. `pkg/auth` verifies a bearer token's signature, issuer, audience, expiry
   and subject, and puts the caller in the request context. Done: A1, A3–A10,
   A13.
2. Default deny. Once `auth.NewService` is registered, every path needs a
   valid token except `/health` and the two metadata paths. Done: A2, A11,
   A12, A14.
3. Claude can find the sign-in server from a `401`. Done: A2, A11.
4. Sign-in degrades safely. Held keys keep verifying while the key set is
   unreachable. With no key held, protected paths answer `503` and recover
   once a fetch succeeds. At most one key fetch starts every 10 s per
   instance (owner), and a request that arrives while a fetch runs waits
   for it, up to 5 s (owner). Done: K1–K10, G1.
5. `pkg/mcp` serves tools declared in `main.go`, with injected services,
   validated input, annotations, bounded size, a per-caller share of the
   running calls and of the bodies being read, and masked errors. Done:
   M1–M13, M15, M16, R1.
6. A connector never runs without sign-in (owner). Done: M14.
7. Deploy readiness, with TLS to Postgres required in production (owner).
   Done: D1–D5.
8. Apps that use none of it are unchanged, with three exceptions (owner):
   - an environment variable already set for an `env:`-tagged field now
     wins over YAML
   - an app that constructs `postgres.Service` in production must set
     `postgres_sslmode` to a TLS mode, and a non-empty user and password
   - a Postgres user or password stored percent-encoded in config must now
     be stored raw, since `dsn` escapes it

   Done: C1, A15, D3.
9. No token, header, tool argument or tool result reaches a framework log
   line or error body. Done: L1, L2.

**Non-goals**

- An authorization server of our own: login pages, token issuing, client
  registration. The owner chose a hosted service.
- Sign-in for the Expo app (web and iOS). It belongs to part 2 of the
  standard. `pkg/auth` takes one issuer now; a second is new config keys.
- Gating who may sign up. Sign-up is open (owner). Users, roles, sharing
  and invitations belong to each app, keyed on the caller's subject.
- Public paths an app declares. None is needed yet (owner); a design adds
  them when an app needs one.
- The first real connection from Claude (owner). It needs a deployed app
  and a WorkOS account, so it is thetraveler's acceptance.
- Hosting: the host, the database and the deploy pipeline. Part 3, Base to
  Base M4 and thetraveler's design.
- MCP resources, prompts, sampling, server-to-client requests, streaming
  responses and sessions. Tools over request and response cover the need.
- Rate limiting per caller. The framework has none on any route today.
  `pkg/mcp` bounds running tool calls and each caller's share of them (see
  "Scaling"), but not how often a caller calls.
- A tool set served by this repo's app (owner).
- New lens rules for connectors. They wait for a second design that needs
  them.

**Anti-goals**

- A request reaching a handler without a verified caller, once sign-in is
  registered or a connector exists, because a line was forgotten.
- A token issued for another app being accepted.
- A token, an `Authorization` header, a tool argument or a tool result in
  a framework log line or error body.
- A panic in one tool call stopping the process.
- An existing consumer breaking on upgrade, beyond the three
  owner-accepted exceptions in goal 8.
- App code importing the MCP SDK or the JWT libraries directly
  (docs/BEST_PRACTICES.md §6).
- A paid resource appearing without the owner opting in.

The first anti-goal is narrowed to apps that use sign-in or a connector.
Requiring every app to declare "no sign-in" would change every existing
app, which goal 8 rules out. An app with no sign-in and no connector logs
`auth: not registered, every route is public` at startup, as A15 checks.

## Fit with existing features

**Not duplicates.** `pkg/gmail/authorize.go` obtains Google tokens for
this app's outbound calls; `pkg/auth` verifies tokens presented to this
app. `SetAuthMiddleware` (pkg/http/middleware.go:210) is the existing seam.
An app uses it or `pkg/auth`, never both (below).

**Changed**

| Thing | Change | What existing callers see |
|---|---|---|
| `app.NewApp` (app/app.go:33) | Signature unchanged. 1) It calls a new function in `router.go` that takes the `app.MCP` entry out of the routes slice and passes the rest to `newRouter` unchanged. 2) After `resolve`, it looks up `auth.Service` as it looks up `postgres.Service` (app/app.go:86), but optionally. 3) It calls `router.go` again to mount the metadata routes (when `auth.Service` is registered) and the connector (when an `app.MCP` entry exists) on the router `newRouter` returns. 4) It panics when `auth.Service` is registered while `pkghttp.HasAuthMiddleware()` is true. | No change without the new entry and service. |
| `app` package logger | `NewApp` gets its logger from an unexported package variable, `newLogger = logger.NewService` (owner). Only `app`'s own tests replace it. | No change: the same logger is built. |
| `App.Run` chain (app/app.go:110-118) | Built by the new `Handler()`. The auth slot (line 117) holds `pkghttp.Auth()` when no `auth.Service` is registered, and the service's middleware when one is. Only one of them can be set. | Same chain for today's apps. |
| `app` interface (app/app.go:18) | Gains `Handler() http.Handler`, the chain `Run` serves. `Run` calls it. | Additive. Tests use it with `httptest`. |
| `router.go` (app/router.go) | All parsing of the routes slice stays here. It gains the `app.MCP` entry kind, the function that takes it out of the slice, and the function that mounts the metadata routes and the connector, with every connector registration panic. `newRouter`'s signature is unchanged. `app/CLAUDE.md` "Router rules" lists the third entry kind. | Unchanged for `app.Spec` and path pairs. `router_test.go` calls `newRouter` as before. |
| `injectFields` (app/router.go:42) | Before injecting a field, it panics with `field <Name> of <Type> is unexported; injected fields must be exported` when the field cannot be set. Tool sets use it too. | Today an unexported field panics inside reflect; now the panic names it. Existing messages are unchanged (router_test.go:47-57). |
| Config flattening (app/app.go:58-74) | For a field with an `env:` tag, `os.LookupEnv` is read first. Set and not empty: its value replaces the YAML value in the struct and in the flat map. Otherwise: the YAML value is exported as today (app/app.go:68). `env:` is for string fields only. A tagged field of another type panics with `config: <Section>.<Field> has an env tag but is not a string`; today it panics on the type assertion at app/app.go:68. The config file stays required (app/app.go:50-53). | Changes only when a tagged variable is already set at startup: today YAML overwrites it; after, it wins (owner). `main.go:23` (`TWILIO_PHONE_NUMBER`) is this repo's one tag today. |
| `pkg/postgres` `connect` (pkg/postgres/service.go:120) | The DSN is built by a new unexported function, `dsn(config map[string]interface{}) (string, error)`, which `connect` calls; `connect` panics with its error before opening anything. `dsn` escapes the user and password with `url.UserPassword` (owner), so a credential containing `@`, `/`, `:`, `?` or `#` round-trips, and a DSN whose credentials need no escaping is byte-identical to today. When the connection fails, `connect` replaces the raw password, its escaped form and the whole DSN with `xxxxx` in the error's text before logging it, and in any panic text it raises (owner). An empty password skips the raw and escaped replacements, and the whole-DSN replacement always applies. A non-empty password is replaced wherever it appears, so a short development password such as `password` also hides that word in the error text (owner). `connect` opens the driver through an unexported variable, `open`, which tests replace. `dsn` reads `postgres_sslmode` with a checked type assertion. Absent or empty: the DSN is byte-identical to today. One of `disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full`: the DSN ends `?sslmode=<value>`. Anything else: `postgres: postgres_sslmode must be one of disable, allow, prefer, require, verify-ca, verify-full`. With `ENV=PRODUCTION` (owner): anything but `require`, `verify-ca` or `verify-full` gives `postgres: in production postgres_sslmode must be require, verify-ca or verify-full`; an empty `postgres_user` gives `postgres: in production postgres_user must be set`, and likewise for `postgres_password`. | Outside production, no change unless a credential was stored percent-encoded, which must now be stored raw (owner). In production, an app must set a TLS mode, a user and a password (owner). |
| `pkg/http` | Gains `HasAuthMiddleware() bool`, which returns whether the hook is non-nil, so `SetAuthMiddleware(nil)` clears it (owner). Gains `GetBytes(ctx context.Context, url string, maxBytes int64) (status int, body []byte, err error)`. It sends through the shared client's transport with the shared client's 10 s timeout (pkg/http/http.go:29), in a client that refuses redirects: a `3xx` comes back as its status, with no error, and is not followed. It honours `ctx`'s deadline, fails before reading when `Content-Length` passes `maxBytes`, and stops reading once the body passes it. | Additive. `GET` and `POST` are unchanged and still follow redirects. |
| `pkg/http/apierror` | Gains `Unavailable(detail)` (503, code `unavailable`) and `TooLarge(detail)` (413, code `payload_too_large`). | Additive. |
| `main.go` | `app.ListenAddr("localhost", 8080)` replaces the literals (lines 62-63). The Postgres fields gain `env:` tags `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DATABASE`; all five are strings today. A new field `SSLMode string`, with `yaml:"sslmode"`, `config:"postgres_sslmode"` and `env:"POSTGRES_SSLMODE"`, joins them. `Ticketmaster.APIKey` gains `env:"TICKETMASTER_API_KEY"`. No `app.MCP` entry. | Same address and config unless those variables are set. |
| `config.yml` | `ticketmaster.api_key` becomes empty (owner). `postgres.user` and `postgres.password` become empty (owner). `postgres.sslmode: require` is added. | Production reads them from the environment. A missing Postgres variable fails at connect instead of using a known password. Nothing in this repo calls Ticketmaster: `ticketmaster.Service` is resolved but no code uses it. |

`.basetobase/ci/local.yml` gains `postgres.sslmode: disable`. It must
track every key in `config.yml` (.basetobase/CLAUDE.md:14), and CI's
Postgres has no TLS. CI does not run with `ENV=PRODUCTION`, so `disable` is
allowed there. Its other keys already match `config.yml`'s.

**Unchanged and relied on**

- `TimeoutMW` buffers every response and cuts a request at 10 s
  (app/app.go:116, pkg/http/middleware.go:154). The connector answers with
  one JSON body, never a stream, so it works behind it. A throwaway test
  against go-sdk v1.8.0 confirmed this. The tool handler gets the
  request's context, so it sees the 10 s deadline.
- `CORS` answers a preflight before the auth slot (pkg/http/middleware.go:185),
  so preflights need no token.
- `RequestLogger` logs method, path, status, duration and request id only
  (pkg/http/middleware.go:99-116).
- `/health` (app/router.go:81) stays public.

**New**

- `pkg/auth/`, `pkg/auth/authtest/` (a test issuer: signs RS256 and ES256
  tokens, serves a key set, counts fetches, can be stopped and hung), and
  `pkg/mcp/`, each with a `CLAUDE.md`.
- The root `CLAUDE.md` gains a third golden flow, "New connector tool".
  `docs/BEST_PRACTICES.md` gains sign-in, connector tools and the
  ownership rule (see "Security"). §4 gains the `env:` rule and the rule
  that every host sets `ENV=PRODUCTION`; §7 gains the TLS and credential
  rules, including that credentials are stored raw, never percent-encoded.
- `app/tool/CLAUDE.md` (owner). Tool sets live in `app/tool/<name>/`, beside
  `app/controller/`. The guide's rules:
  - a tool set injects `domain/` services by field
  - it never imports `api/`, `pkg/http` or `apierror`
  - it checks argument lengths and ranges itself
  - it returns `mcp.Errorf` for a mistake in the caller's request, and a
    plain error for anything else
  - it checks that each record belongs to the caller (the ownership rule)

  The directory holds only this guide until an app adds a tool set;
  thetraveler adds the first.

**Consumers.** `aghchan/recruiter` at e1bd8d8 pins simplegoapp v0.3.1.
Checked in this session:

- Its `go.mod` says `go 1.25.0`.
- Its config struct has no `env:` tags (main.go:13-26).
- Nothing in it calls `SetAuthMiddleware`.
- Its deployed process is `cmd/agent` (Dockerfile), which never constructs
  `postgres.Service`; only its API server in `main.go` does.

Upgrading changes nothing it runs today. If its API server is ever run with
`ENV=PRODUCTION`, it must set `postgres_sslmode` (owner). Its binary gains
the seven modules listed under "Infrastructure and dependencies", because
`app` imports `pkg/auth` and `pkg/mcp` (owner).

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

// package auth
type Service interface {
    Verify(ctx context.Context, token string) (Identity, error)
    Middleware() pkghttp.Middleware
    ResourceMetadata() ResourceMetadata
    MetadataPaths() []string
}
type Identity struct {
    Subject string // the token's sub
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
  defaults. `PORT` must be decimal digits only, from 1 to 65535. Anything
  else panics with `PORT must be a port number from 1 to 65535, got
  "<value>"`. `main.go` reads `host, port := app.ListenAddr("localhost",
  8080)` and passes `host` and `port` as `NewApp`'s first two arguments
  (owner).
- `Middleware()` leaves exactly `/health` and the paths `MetadataPaths()`
  returns public. It takes no list.
- A tool set is a pointer to a struct. `NewApp` injects its fields with
  `injectFields`, as it does a controller's. Every field must be exported
  and have a provider.
- `In` and `Out` are structs. `In`'s JSON schema is inferred from the type,
  nested structs included; a `json` tag names a field and a `jsonschema`
  tag describes it. Unknown fields are refused at every level. A pointer
  field is optional. The schema carries no length or range limits, so a
  handler checks them, as a controller does (api/CLAUDE.md), and returns
  `mcp.Errorf`.
- A tool handler gets the request's context, with the 10 s deadline. It
  must return when that context is done.
- `FromContext` returns the caller and `true` behind `pkg/auth`, and
  `false` anywhere else.
- `auth.NewService` returns one value, as the resolver requires
  (app/resolver.go:132). Bad config panics, naming the key.

**Registration mistakes.** Each is a startup panic with a named message,
raised in `router.go` as the router's are (app/CLAUDE.md):

- an `app.MCP` entry without `auth.NewService` in the service list:
  `app.MCP requires auth.NewService in the service list`
- `auth.NewService` with a `SetAuthMiddleware` hook set (raised in
  `NewApp`): `auth.NewService and SetAuthMiddleware are both set; use one`
- a second `app.MCP` entry
- a path not starting with `/`
- a connector path equal to `/health` or a metadata path, or matching a
  route already on the router (checked with the router's own matcher for
  `POST`)
- no tool set
- an empty `Info.Name` or `Info.Version`
- a tool set that is not a pointer to a struct
- an unexported tool-set field
- a tool name that breaks the pattern or repeats
- an empty `Title` or `Description`
- `Destructive` or `Idempotent` with `ReadOnly`
- a nil handler
- more than 64 tools
- `In` or `Out` that is not a struct

**Routes**

| Route | Registered when | Caller |
|---|---|---|
| `POST <path>` | an `app.MCP` entry (which requires `auth.Service`) | signed-in user |
| `GET /.well-known/oauth-protected-resource` | `auth.Service` is registered | anonymous |
| `GET /.well-known/oauth-protected-resource<P>` | same, and `P`, the path of `auth_resource`, is neither empty nor `/` | anonymous |

Another method on these paths gets the router's `405` problem
(app/router.go:88). On `<path>` that happens after the token check, so
without a token the answer is `401`.

**Metadata document.** `200`, `Content-Type: application/json`, body
`{"resource":"<auth_resource>","authorization_servers":["<auth_issuer>"],"bearer_methods_supported":["header"]}`.

**Connector endpoint.** It speaks MCP Streamable HTTP using the SDK's
stateless mode with JSON responses, so no session id is read or set. The
SDK's DNS-rebinding check is off (see "Security"). Every tool sends
`title`, `readOnlyHint` and `openWorldHint: false`. When `ReadOnly` is
false it also sends `idempotentHint` and `destructiveHint`.

`pkg/mcp` reads the whole body, up to 256 KiB, before the SDK sees it.

**Running tool calls** (owner):

- A running tool call holds a slot. Only `tools/call` takes one: the tool
  wrapper takes it after the arguments pass the schema, and releases it
  when the handler returns. If the response was already cut at 10 s, the
  slot is still held until the handler returns.
- There are 32 slots per instance, and one signed-in subject holds at most
  8 of them.
- `initialize`, `ping` and `tools/list` take none.
- The release is deferred, so it runs whether the handler returns, errors
  or panics. A subject's count is deleted when it reaches zero (owner).
- The subject is `auth.FromContext`'s. A request with no identity never
  reaches a tool: it is refused before its body is read (below) (owner).

**Bodies being read.** A connector request holds a reader place from when
the token check passes until its body read ends: 64 per instance, 8 per
subject. With none free, the request gets `503` problem, code
`unavailable`, detail `connector busy`, header `Retry-After: 1`, before any
of its body is read. Every connector request takes one, `initialize`,
`ping` and `tools/list` included (owner):

- The release is deferred, so it runs however the read ends: completed,
  over 256 KiB, a client that disconnects, the server's 15 s read timeout
  (app/app.go:121), or a panic. A place is held until the read ends, even
  when the response was already cut at 10 s.
- A subject's count is deleted when it reaches zero.
- A request with no identity is refused before its body is read: `500`
  problem, code `internal`, detail `internal server error`, logged as
  `mcp: request with no signed-in caller`. `app.MCP` always has sign-in in front, so only a handler wired
  by hand can see this.

| Request | Response |
|---|---|
| `initialize`, `ping`, `tools/list` | `200`, JSON-RPC result |
| `tools/call`, handler returns a value | `200`, result with `structuredContent` and the same JSON as text |
| `tools/call`, arguments fail the schema (missing, wrong type, unknown field at any level, `arguments` absent) | `200`, result with `isError: true` and the validator's message. The handler does not run and no slot is taken. |
| `tools/call`, no free slot, or the caller already holds 8 | `200`, `isError: true`, text `connector busy, try again`. The handler does not run. |
| `tools/call`, handler returns `mcp.Errorf(...)` | `200`, `isError: true`, text is that message, cut at 1 KiB |
| `tools/call`, handler returns any other error, its `Out` fails to marshal, or it panics | `200`, `isError: true`, text `internal error`. Logged as in "Security". |
| `tools/call`, handler returns a value and an error | the error's row |
| `tools/call`, the result's JSON over 256 KiB | `200`, `isError: true`, text `result too large` |
| `tools/call`, unknown tool | `200`, JSON-RPC error `-32602` |
| Any other MCP method | the SDK's default answer (an empty list for `resources/list`) |
| Body over 256 KiB, with or without `Content-Length` | `413` problem, code `payload_too_large`, detail `request body too large` |
| No reader place free, or the caller already holds 8 | `503` problem, code `unavailable`, detail `connector busy`, header `Retry-After: 1` |
| Any request with no identity in the context | `500` problem, code `internal`, detail `internal server error`, before the body is read. Logged as `mcp: request with no signed-in caller`. |
| Body that is not a JSON-RPC message | `400`, the SDK's plain-text body |
| `Accept` without both `application/json` and `text/event-stream` | `400`, the SDK's plain-text body |
| `Content-Type` other than `application/json` | `415`, the SDK's plain-text body |
| `MCP-Protocol-Version` the SDK does not support | `400`, the SDK's plain-text body |
| Handler still running at 10 s | `504` problem, code `timeout` (pkg/http/apierror/apierror.go:30) |

The SDK's plain-text rows were observed with go-sdk v1.8.0 in a throwaway
test. They are the transport's answers, not this app's contract.

**Sign-in.** When `auth.Service` is registered, these checks run in order
on every path except `/health` and the metadata paths. The first that
fails decides the response.

1. Exactly one `Authorization` header, in the form `<scheme> <token>`, with
   the scheme `Bearer` in any case. The token is not empty, contains no
   space, and is at most 8,192 bytes. Failure: `401` problem, code
   `unauthorized`, detail `authentication required`, header
   `WWW-Authenticate: Bearer resource_metadata="<M>"`.
2. Unverified checks on the token: three dot-separated segments with a
   JSON header and payload, an `alg` of `RS256` or `ES256`, a non-empty
   `kid`, and claims that pass the claim checks in "Security". Failure:
   `401` problem, detail `invalid token`, header
   `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="<M>"`.
3. The key for `kid`, by the key-set policy in "Scaling". There is no key
   held and none can be fetched now: `503` problem, code `unavailable`,
   detail `sign-in service unavailable`. Keys are held but none matches, or
   the key's type does not match `alg`: step 2's `401`.
4. The signature, then the claim checks again on the verified token.
   Failure: step 2's `401`.

`<M>` is the origin of `auth_resource`, then
`/.well-known/oauth-protected-resource`, then `P`. A request with no token
or a malformed token never gets `503`, so discovery works while the key
set is down. A path that matches no route is not public, so without a
token it gets `401`, not `404`.

## Data model and migrations

None. `pkg/auth` keeps verification keys in memory and `pkg/mcp` keeps no
state between requests. Users and their data are each app's tables.

## Scaling

**Load.** thetraveler: 10 signed-in users, 100 tool calls an hour in a
planning session, a peak of 2 requests a second. The framework parts are
held to 10 times that peak, 20 requests a second, on one instance. The
instance is assumed to have 512 MiB of memory.

| Bound | Value |
|---|---|
| Connector request body | 256 KiB |
| Tool result JSON | 256 KiB |
| Running tool calls | 32 per instance, 8 per subject |
| Connector bodies being read | 64 per instance, 8 per subject |
| Tools per endpoint | 64 |
| `mcp.Errorf` message | 1 KiB |
| Bearer token | 8 KiB |
| Key-set response | 64 KiB |
| Key fetches | 1 started per 10 s per instance |

**Hot path, per request.**

- Sign-in: parsing, one signature check, no outbound call while the key
  is held.
- Connector: one bounded body read, the SDK's per-request server session
  (stateless mode), one JSON decode, one schema check, the handler, and
  two encodes of the result (structured and text).
- The framework makes no query.
- Its cost per request is not measured. Benchmark B1 records it.

**Memory.** A running tool call holds at most 256 KiB of body and about
768 KiB of response: the result twice, once structured and once as text,
inside a buffered response. Thirty-two running calls hold about 32 MiB.

Requests still reading their body hold at most 256 KiB each, and at most
64 read at once: 16 MiB. The two together hold about 48 MiB at any request
rate, under the assumed 512 MiB.

**Concurrency.**

- Slots bound live tool-handler goroutines to 32. A handler that ignores
  its context keeps its slot until it returns.
- The per-subject limits of 8 keep one account from taking every slot or
  every reader place. Several accounts together still can, which follows
  from open sign-up (owner).
- Services are singletons, and the tool list is built at startup and never
  written again.
- The slot and reader counts are the only shared state in `pkg/mcp`: two
  counters and two maps from subject to count, under one mutex. A
  subject's entry is deleted at zero (owner), so the maps hold only
  subjects with a request in progress: at most 32 and 64 entries. They are
  per instance, so instances scale side by side.

**Key set** (`pkg/auth`, hand-written over jwkset's parser):

- **Fetch.** `pkghttp.GetBytes` of `auth_jwks_url`, with a 5 s deadline
  and a body of at most 64 KiB. The status must be `200`. Redirects are
  refused, so a `3xx` is a failed fetch.
- **A usable key.** RSA of at least 2,048 bits, or EC P-256. A non-empty
  `kid`. `use` absent or `sig`. `alg` absent, or `RS256` for RSA and `ES256`
  for EC. Other keys are ignored.
- **A failed fetch.** Too large, not `200`, malformed, or no usable key. On
  failure the held keys are kept.
- **When a fetch is wanted.**
  - No keys are held, on demand.
  - A token's `kid` is not held while other keys are, on demand.
  - The last success is more than an hour old: in the background, while the
    request is answered from the held keys.
- **When a fetch starts (owner).** At most one starts every 10 s per
  instance, whatever wants it, and every attempt counts, failed or not.
  When no fetch is running and the last one started under 10 s ago, a
  wanted fetch does not start: on demand, the request gets `503` with no
  keys held, or `401` for an unknown `kid`; in the background, it waits for
  a later request.
- **One fetch at a time.** A request that wants a fetch while one is
  running waits for it, at most 5 s (owner). When the fetch ends, or the
  request's own 5 s pass first, it is judged on the keys held then, as
  step 3 of "Sign-in" says (owner):
  - its `kid` is held: the signature is checked
  - no keys are held: `503`
  - keys are held but none matches: `401`

  At first startup, or just after a rotation, concurrent requests share
  one fetch and all succeed when it does.
- **Locking.** No lock is held during the HTTP call. The key map is swapped
  under a write lock held only for the swap, and verification reads under
  a read lock.
- **Startup** fetches nothing and never waits.
- **Testing.** Time comes from an unexported clock field, `time.Now` in
  production, which the package's own tests replace; the 10 s spacing and
  the hour run on it. The 5 s fetch deadline and the 5 s wait come from an
  unexported duration field, 5 s in production, which K5 and K10 set to
  200 ms. No K test waits for seconds.

So at any request rate, with any tokens, an instance makes at most 8,640
fetches a day. A forged token with a random `kid` can delay picking up a
rotated key by at most 10 s.

**What breaks first.** Slow handlers. At 20 requests a second, handlers
slower than 1.6 s fill the 32 slots, and further calls get `connector
busy`. With fewer than four subjects calling, the per-subject limit is
reached first. Memory does not run out first: running calls and bodies
being read are both capped, at about 48 MiB together. Callers that send
bodies slowly fill the 64 reader places, and further requests get `503
connector busy`; one subject can hold 8 of them.

No cache, queue or table is added.

## Infrastructure and dependencies

**Libraries**, pinned in `go.mod`:

| Library | Version | For |
|---|---|---|
| `github.com/modelcontextprotocol/go-sdk` | v1.8.0 | the MCP server. It needs Go 1.25.0, which `go.mod` already states. |
| `github.com/golang-jwt/jwt/v5` | v5.3.1 | token parsing and checks. Already in `go.mod` as an indirect dependency, and required by the SDK. |
| `github.com/MicahParks/jwkset` | v0.11.4 | parsing a key set into keys (`JWKSMarshal.JWKSlice`, `JWK.Key`). Fetching and caching are `pkg/auth`'s own code, over `pkghttp.GetBytes`. |
| `github.com/google/jsonschema-go` | v0.4.3 | required by go-sdk: inferring and checking tool schemas. |
| `github.com/segmentio/encoding` | v0.5.4 | required by go-sdk: JSON encoding. |
| `github.com/segmentio/asm` | v1.1.3 | required by segmentio/encoding. |
| `github.com/yosida95/uritemplate/v3` | v3.0.2 | required by go-sdk: resource templates, unused here. |

Every app built on the framework links all seven, because `app` imports
`pkg/auth` and `pkg/mcp` (owner). go-sdk's other requirements
(`golang.org/x/oauth2`, `x/sync`, `x/sys`, `x/time`, `x/tools`) are
already in `go.mod` at the same or newer versions.

**Service: WorkOS AuthKit**, the hosted sign-in service. This repo's tests
never call it; they sign tokens with `pkg/auth/authtest`. An app that
registers sign-in needs a WorkOS environment with three settings:

- Client ID Metadata Document enabled
- a Resource Indicator equal to its `auth_resource`
- public sign-up on (owner)

The setup steps are in https://workos.com/docs/authkit/mcp.

- **Unit price.** $0 for the first 1,000,000 monthly active users, then
  $2,500 a month for each further million. Staging environments are free
  (https://workos.com/pricing).
- **Total.** At 10 users the monthly total is $0, and the free allowance is
  100,000 times the expected use.
- **Not used.** A custom domain ($99 a month).
- **Limits.** Hosted AuthKit allows 1,000 reads per 10 s per environment
  (https://workos.com/docs/reference/rate-limits). Key-set fetches stay at
  or under 1 every 10 s per instance.
- **A card at sign-up.** WorkOS's pricing page doesn't say whether one is
  required. The owner checks when creating the account. If WorkOS asks for a
  card, this design switches to another hosted provider before any code
  (owner).

**Hosting.** This design adds no host and no database. The app's host and
Postgres are named, priced and limited in thetraveler's design, and the
database must accept TLS. A host that sleeps when idle starts up before the
app sees the request, so a cold start does not count against the 10 s
timeout.

**Config keys.** `auth.NewService` reads these from the flat config map.
An app declares them in its config struct under these `config:` names.
None of them is a secret, so they are committed in the app's `config.yml`
and set in its `local.yml`.

| Key | Required | Default | Meaning |
|---|---|---|---|
| `auth_provider` | yes | none | `workos`. Empty or unknown panics, as `llm_provider` errors (pkg/llm/service.go:68-79). |
| `auth_issuer` | yes | none | The AuthKit domain, with no trailing slash. The token's `iss` must equal it. |
| `auth_resource` | yes | none | The app's public connector URL as an absolute URL, exactly as entered in Claude. The token's `aud` must contain it. |
| `auth_jwks_url` | no | `<auth_issuer>/oauth2/jwks` | The key set. The test seam. |
| `postgres_sslmode` | outside production, no; in production, yes | absent | Read by `pkg/postgres`. In production it must be `require`, `verify-ca` or `verify-full` (owner). |

With `ENV=PRODUCTION`, `auth_issuer`, `auth_resource` and `auth_jwks_url`
must start with `https://`, else startup panics, naming the key. With
`ENV=PRODUCTION`, `postgres_user` and `postgres_password` must not be empty,
else startup panics, naming the key (owner).

**`ENV=PRODUCTION`.** Every production rule here applies only when `ENV` is
`PRODUCTION`. A host that leaves it out makes the app read `local.yml`
(app/app.go:44-47). That file is git-ignored and so absent from any deploy,
and startup panics with `loading config file` (app/app.go:50-53) (owner).
§1 adds to `docs/BEST_PRACTICES.md` §4 that every host sets
`ENV=PRODUCTION`.

**Environment variables.** `HOST` and `PORT` are read by `app.ListenAddr`.
Any variable an app names in an `env:` tag is read as well. This repo adds
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_HOST`, `POSTGRES_PORT`,
`POSTGRES_DATABASE`, `POSTGRES_SSLMODE` and `TICKETMASTER_API_KEY`.

**Secrets.**

- **The Ticketmaster key.** The owner creates a new key in their Ticketmaster
  developer account, because it needs their sign-in. They keep it in their
  git-ignored `local.yml` and in the host's environment as
  `TICKETMASTER_API_KEY`, then revoke the committed key (owner). The old
  value stays in git history, which is why it is revoked.
- **The Postgres user and password.** They leave `config.yml` (owner). The
  development values live only in the git-ignored `local.yml`; production
  takes them from `POSTGRES_USER` and `POSTGRES_PASSWORD`.
- **No new secret.** Verification uses the issuer's public keys.
- **Others.** A secret an app already has leaves YAML through its `env:` tag.
  Its source is the host's environment settings and its holder is the owner.
  To rotate it, change the host's setting and restart.

**Nothing else runs.** There is no queue, cache, schedule, bucket or
webhook.

**Switching off.** Remove the `app.MCP` entry and `auth.NewService` from
`main.go`, together, since the first requires the second. The WorkOS
environment holds the users' email addresses. The owner deletes it from
the WorkOS dashboard when the app is retired; until then it costs $0.

## Security

**Callers**

| Route | Caller |
|---|---|
| `/health` and the metadata document | anonymous |
| every other path, with `auth.Service` registered | a signed-in user, meaning anyone who registered with the app's WorkOS environment. Sign-up is open (owner). |
| every path, without `auth.Service` | anonymous, as today. `NewApp` logs `auth: not registered, every route is public` once at startup. A connector cannot exist in this case (M14). |

**Ownership rule.** Anyone can sign up, so a valid token only says who the
caller is. Every app checks that each record it reads or writes belongs to
`Identity.Subject`. `pkg/auth` cannot enforce this. The rule goes into
`pkg/auth/CLAUDE.md`, `docs/BEST_PRACTICES.md` and the root `CLAUDE.md`.
thetraveler's design must test that one user cannot read another's trip.

The public paths match the request path exactly: no prefixes, no case
folding, no trailing slash. The query string is ignored.

**Claim checks**, all required:

- `iss` equals `auth_issuer`.
- `aud`, a string or an array, contains `auth_resource` as an exact string.
- `exp` is present and not passed.
- `nbf`, when present, is reached.
- `sub` is present and not empty.
- Provider `workos`: a token whose `sub_profile` is `ai_agent` is refused, as
  WorkOS's guide requires.

`exp` and `nbf` allow 30 s of clock skew. Only `RS256` and `ES256` are
accepted, `none` and every symmetric algorithm are refused, and a token in
the query string is never read.

**Input at the edge.**

- The connector body is capped at 256 KiB.
- Tool arguments are checked against the schema inferred from `In`, with
  unknown fields refused, before the handler runs.
- Length and range limits are each handler's job (see "API contract").
- The key-set URL comes from config, never from a request, and is fetched
  with redirects refused, so the `https://` check holds for the bytes read.
- `postgres_sslmode` is checked against a fixed set before it reaches the
  DSN.

**Logs and errors.** For each tool call the framework logs the tool name,
the caller's subject, the outcome, the duration and the request id. It
never logs a token, a header, an argument or a result.

- **Handler errors.** The error's message is logged, cut at 512 bytes.
  `pkg/mcp/CLAUDE.md` states the handler contract: an error never carries
  an argument, a token or personal data.
- **Panics.** The log gets the tool name, the request id and the stack. It
  gets the panic value only when that value is a `runtime.Error`, whose
  text the runtime writes.
- **`mcp.Errorf`.** The message is returned to the caller unmasked, cut at
  1 KiB. It is for messages about the caller's own request.
- **`401` bodies.** One of two fixed phrases, never which check failed.
- **The subject.** The sign-in service's opaque user id, kept as long as the
  host keeps logs.

**Unauthenticated routes.** `/health` and the metadata document do no I/O
and return a fixed body. A bad token costs one parse and at most one
signature check, and starts no fetch beyond the 10 s limit. There is no
per-caller rate limit (non-goal).

**One caller's share.** One subject holds at most 8 of the 32 running tool
calls and 8 of the 64 reader places, so one account cannot lock the owner
out. Several accounts together
can, since sign-up is open (owner).

**DNS-rebinding check off.** The SDK refuses a request that arrives on a
loopback address with a non-loopback `Host`. It answered `403` to
`Host: thetraveler.example.com` in a throwaway test. That breaks a tunnel
or same-machine proxy in front of the app. The attack it stops needs a
local server that answers without credentials. Every connector requires a
bearer token (M14), which a rebinding page cannot obtain, so the check
adds nothing here.

**Secrets and personal data.**

- No secret is added.
- The committed Ticketmaster key is rotated, and the committed Postgres
  credentials leave `config.yml` (owner).
- In production the database link is encrypted (owner).
- The Postgres password is escaped in the DSN. A logged connection error
  and `connect`'s panic text replace it with `xxxxx` in its raw and escaped
  forms and as part of the whole DSN (owner).
- Token claims live in memory for one request, and nothing is stored.
- Users' email addresses live at WorkOS (see "Switching off").

**Not checked.** Revocation: a revoked user's token works until it expires,
5 minutes by AuthKit's default.

**Other.** There is no inbound callback: OAuth redirects go to Claude and
to AuthKit, never to the app. The app never forwards a caller's token.

## Failure and rollback

| Failure | Behaviour |
|---|---|
| Key set unreachable, keys held | The held keys keep verifying. A refresh is wanted once the last success is an hour old, and starts at most once every 10 s until one succeeds. |
| Key set unreachable, no key held | Protected paths answer `503` to a request with a well-formed token, and `401` to one without. Public paths work. A fetch starts at most once every 10 s. |
| Key set hangs | The fetch gives up at 5 s. Requests whose key is held are not held up. |
| Issuer rotates its keys | A token with an unknown `kid` starts a fetch, subject to the 10 s limit. |
| AuthKit down for sign-in | Tokens already issued work until they expire. New sign-ins fail at AuthKit; the app does nothing. |
| A tool handler panics | The call returns `internal error`, the panic is logged, and the process keeps running. `pkg/mcp` recovers inside the tool wrapper. `Recover` (pkg/http/middleware.go:48) cannot: go-sdk v1.8.0 runs each request on its own goroutine (internal/jsonrpc2/conn.go:684), and a panic there ended the process in a throwaway test. A goroutine the handler starts itself is the app's to guard. |
| A tool handler runs past 10 s | `504` from the existing chain. The handler's context is done and its slot is held until it returns. |
| Slow handlers fill the slots | `connector busy, try again` as a tool error. |
| Production config without TLS to Postgres | Startup panics with the `postgres_sslmode` message. |
| A production Postgres user or password not set | Startup panics, naming the key (owner). |
| A host without `ENV=PRODUCTION` | Startup panics with `loading config file`, since `local.yml` is not deployed (owner). |
| Callers sending bodies slowly fill the reader places | `503 connector busy` with `Retry-After: 1`. |
| A bad release of the framework | An app goes back to the previous tag. There is no data to undo. |

**Rollback limit.** An app that moved a secret to an `env:` tag cannot go
back past §1 without putting that secret in a committed file. Such an app
rolls forward with a fix instead.

## How we'll know it works

All tests run in `go test ./... -count=1 -race`, which CI already runs
(.github/workflows/ci.yml). None needs a database, a network or a WorkOS
account.

**Test setup.**

- End-to-end tests build an app with `app.NewApp`, register a fake
  `postgres.Service` in the service slice, and write a `local.yml` to
  `t.TempDir()` after `t.Chdir`. They set `newLogger` to a recording
  `logger.Logger` (owner) and call `Handler()`.
- Tokens are signed by `authtest`. Connector tests in `pkg/mcp` run behind
  `pkg/auth`'s middleware with `authtest` tokens, so each call has a
  subject (owner).
- Key-set tests (K) are in package `auth` and drive its clock.
- A test that sets a `SetAuthMiddleware` hook resets it with
  `SetAuthMiddleware(nil)` (owner).

**Sign-in**

- A1. A valid token on a protected path: `200`, and the handler reads the
  token's `sub` from `auth.FromContext`.
- A2. No header on a protected path: `401`, `application/problem+json`,
  code `unauthorized`, detail `authentication required`, and the exact
  `WWW-Authenticate` value. The test logs the response.
- A3. Header forms. `bearer <valid>` gives `200`. These give A2's response:
  `Bearer` with no token, `Basic abc`, `Bearer a b`, two `Authorization`
  headers, and a token of 8,193 bytes. A junk token of exactly 8,192 bytes
  gets `invalid token`, not `authentication required`.
- A4. `exp` 40 s past: `401`, detail `invalid token`, header with
  `error="invalid_token"`. `exp` 20 s past: `200`. `exp` absent: `401`.
- A5. `nbf` 40 s ahead: `401`. `nbf` 20 s ahead: `200`.
- A6. Wrong `iss`: `401`.
- A7. `aud` as a string equal to `auth_resource`: `200`. As an array
  containing it: `200`. With a trailing slash added, with different case,
  or absent: `401`.
- A8. Each of these gets `401`, with no fetch:
  - `alg` of `none`, `HS256` signed with the public key's bytes, `RS384`,
    `RS512`, `PS256` and `ES384`
  - no `kid`
  - a header or payload that is not JSON
  - two segments, or four

  These get `401` too:
  - an `ES256` token whose `kid` names a held RSA key, and the reverse
  - a held `kid` with a signature from another key

  RS256 and ES256 tokens get `200`.
- A9. `sub` absent or empty: `401`. `sub_profile: ai_agent`: `401`.
- A10. A valid token in `?access_token=` and no header: A2's response.
- A11. With no token, all `200`: `/health`, `/health?x=1`, and both metadata
  paths with the exact document. The test logs the document. With no
  token, all `401`: `/health/`, `/HEALTH`, `/healthz` and `/x/../health`.
  `POST` to a metadata path: `405` problem. With `auth_resource` set to
  `https://a.example`, `https://a.example/` and
  `https://a.example:8443/v1/mcp`, the app serves one, one and two
  metadata paths, and `<M>` in A2's header is exact for each. A metadata
  path with a trailing slash: `401`.
- A12. Without a token, all `401`: an `app.Spec` route, a path-pair route,
  an unknown path, and a wrong method on a protected path. With a token
  these are `200`, `200`, `404` and `405`. An `OPTIONS` preflight with
  `Access-Control-Request-Method: POST` to the `app.Spec` route without a
  token: `204`.
- A13. Startup panics, by message: empty `auth_issuer`, an `auth_issuer`
  ending in `/`, empty `auth_resource`, an `auth_resource` that is not an
  absolute URL, unknown `auth_provider`, and, with `ENV=PRODUCTION`, an
  `http://` value in `auth_issuer`, `auth_resource` or `auth_jwks_url`.
- A14. A `SetAuthMiddleware` hook with `auth.Service`: startup panic with
  its message. A hook without `auth.Service`: the app starts and the hook
  runs, as today. After `SetAuthMiddleware(nil)`, `HasAuthMiddleware`
  returns `false` and an app with `auth.Service` starts.
- A15. No `auth.Service` and no connector: routes answer with no token,
  `FromContext` returns `false`, and the recording logger holds the startup
  line once.

**Key set** (package `auth`, test clock, `authtest` server)

- K1. No keys and the server down. A well-formed token: `503`, code
  `unavailable`. No header, or an A8 token: `401`, never `503`. 9 s later:
  `503` and no new fetch. 10 s later: one fetch. Server up, 10 s after
  that: `200`.
- K2. Keys held, then the server goes down: tokens with held `kid`s get
  `200`, and no fetch starts before the hour.
- K3. Unknown `kid` while keys are held:
  - 20 concurrent requests start one fetch.
  - A different unknown `kid` at 9 s: `401` and no fetch.
  - At 10 s: one fetch.
  - A rotated-in key then verifies with `200`.
- K4. At 59 min: no fetch. At 60 min: a verification answers `200` from the
  held keys without waiting, and starts one background fetch.
- K5. A server that never answers, with the deadline set to 200 ms. A
  held-`kid` token answers within 100 ms while the fetch is pending. The
  fetch gives up at the deadline. A request with no key held gets `503`
  within 300 ms.
- K6. Each of these sets is refused, and the held keys keep verifying:
  - no usable key
  - a body of 64 KiB + 1 byte
  - status `500`
  - malformed JSON

  A 1,024-bit RSA key and a key whose `alg` does not match its type are
  ignored. A body of exactly 64 KiB is accepted. A `302` to an `http://`
  copy of the set is a failed fetch, and the copy is never requested.
- K7. 100 goroutines verify while the set is swapped 50 times, under
  `-race`. Every held-`kid` verification succeeds.
- K8. A token with a wrong `iss` and an unknown `kid`: `401` and no fetch.
- K9. A failed refresh past the hour:
  - The server goes down at 61 min, and 100 valid requests follow over
    60 s. All get `200` from the held keys, and at most 6 fetches start.
  - The server comes back. The next fetch succeeds, and no fetch starts
    for the next 59 min.
- K10. Waiting on a running fetch (owner), with the wait set to 200 ms:
  - At first startup, with the server taking 100 ms to answer, 20
    concurrent valid tokens start one fetch, and all get `200`.
  - After a rotation, 20 concurrent tokens with the new `kid` start one
    fetch, and all get `200`.
  - No keys held and the server hung: the waiters get `503` within 300 ms.
  - Keys held, the server hung, and a token with a new `kid`: `401` within
    300 ms. A token with a held `kid` meanwhile gets `200` at once.
  - The fetch fails with `500` while keys are held: waiters with a new
    `kid` get `401`, and waiters with a held `kid` get `200`.

**Shared HTTP** (package `http`)

- G1. `GetBytes`, against a test server:
  - A body of exactly `maxBytes` is returned. `maxBytes` + 1 fails, and the
    server sees the read stop.
  - A `Content-Length` over `maxBytes` fails before the body is read.
  - A `500` returns its status and no error.
  - A `302` returns `302`, and its target is never requested.
  - A context deadline of 100 ms ends the call within 200 ms, though the
    client's timeout is 10 s.
  - `GET` still follows a redirect, as today.

**Connector** (`pkg/mcp` with a recording logger; end to end in `app/` with
the SDK's client)

- M1. `initialize`, `ping`, then `tools/list`: each tool's name, title,
  description, annotations and input schema, exactly.
- M2. `tools/call` with valid arguments: the handler's output as
  `structuredContent`, and text equal to its JSON.
- M3. A missing field, a wrong type, an unknown field at the top and in a
  nested struct, and `arguments` absent: each gives `isError: true`. A
  counter shows the handler did not run, and no slot was taken.
- M4. `mcp.Errorf("trip not found")`: that text. A 1,500-byte `Errorf`:
  its first 1,024 bytes. `errors.New` of a 2,000-byte message: text
  `internal error`, and the log holds the first 512 bytes.
- M5. `panic("x")`, `panic(errors.New("x"))` and `panic(nil)`: `isError:
  true`, `internal error`, and the next call succeeds. The log has the
  tool name and stack, and the value `x` does not appear. An index out of
  range: the runtime's message is logged. The slot counters and maps are
  empty afterwards.
- M6. An unknown tool: JSON-RPC error `-32602`. A body that is not JSON-RPC:
  `400`. `resources/list`: an empty list.
- M7. `GET` and `DELETE` with a valid token: `405` problem, code
  `method_not_allowed`.
- M8. Size limits:
  - A body of exactly 256 KiB is handled; 256 KiB + 1 byte gives `413`,
    detail `request body too large`, both with `Content-Length` and
    chunked.
  - A result of exactly 256 KiB is returned; 1 byte more gives `isError:
    true`, `result too large`.
- M9. A handler that waits on its context, chained behind
  `pkghttp.TimeoutMW(100ms)`: `504` problem, code `timeout`. A counter shows
  the handler saw its context end and returned.
- M10. Slots:
  - Subject A starts 8 blocked calls. A's 9th call is `connector busy`.
    Subject B's call gets `200`.
  - Subjects B, C and D fill the slots to 32, and subject E's call is
    `connector busy`.
  - One call is released, and E's next call gets `200`.
  - `initialize`, `ping` and `tools/list` get `200` while all slots are
    full.
  - A request with no identity, through `NewHandler` with no sign-in in
    front: `500` problem, code `internal`, detail `internal server error`,
    and the log line.
  - After every call has returned, errored or panicked, the counters are
    zero and the maps are empty.
- M11. A slot outlives the cut. Behind `pkghttp.TimeoutMW(100ms)`, subject
  A's 8 handlers ignore their context, and each request gets `504`. A's
  next call is still `connector busy` until the handlers are released;
  after that it gets `200`.
- M12. Through a real loopback listener (`httptest.NewServer`):
  - No `Accept`: `400`.
  - `Content-Type: text/plain`: `415`.
  - `MCP-Protocol-Version: 1999-01-01`: `400`; `2025-11-25`: `200`.
  - `Host: thetraveler.example.com`: `200`. The control is the same request
    to an SDK handler built with the check on, which gets `403`.
  - `Origin: https://claude.ai`: `200`.
  - A raw `POST` returns `200`, `application/json`, and no
    `Mcp-Session-Id`.
- M13. Under `-race`:
  - Thirty concurrent `tools/call`, three from each of ten subjects, all
    return the handler's output.
  - Fifty concurrent calls, five from each of ten subjects, each return the
    handler's output or `connector busy`, and the number of handler runs
    equals the number of outputs.
- M14. Each registration mistake in "API contract" panics with its message:
  - `app.MCP` without `auth.NewService`
  - a connector path of `/health`, a metadata path, or a path an `app.Spec`
    route already serves
  - an unexported tool-set field
- M15. End to end in `app/` with a tool set defined in the test. No token:
  A2's response on the connector path. A valid token: the handler returns
  the caller's subject. An `OPTIONS` preflight with
  `Access-Control-Request-Method: POST` to the connector without a token:
  `204`.
- M16. Reader places, with bodies sent slowly:
  - Subject A's 9th slow request gets `503 connector busy` with
    `Retry-After: 1`, and subject B's is read.
  - With 64 slow requests from 8 subjects, a 65th from a 9th subject gets
    `503`.
  - Once a body completes, the next request is read.
  - Each of these frees its place, and afterwards the reader counters are
    zero and the maps empty: a body over 256 KiB (`413`), a client that
    disconnects mid-body, a body that hits a 100 ms read timeout, a body
    that is not JSON-RPC (`400`), and `initialize`, `ping` and
    `tools/list`.
  - A slow body still being read when the response is cut at 100 ms
    (behind `pkghttp.TimeoutMW(100ms)`) holds its place until the read
    ends.
  - A request with no identity takes no place.
- R1. In `router_test.go`: a controller with an unexported field panics
  with `field <Name> of <Type> is unexported; injected fields must be
  exported`.

**Deploy readiness**

- D1. `ListenAddr`:
  - Unset: the defaults. `HOST=0.0.0.0 PORT=9000`: those values.
  - `HOST=` or `PORT=` empty: the defaults.
  - `PORT` of `abc`, `0`, `65536`, `-1`, ` 80` or `80.5`: a panic with the
    message.
- D2. The `env:` rule:
  - Set: the struct field and the flat map hold the variable's value.
  - Unset, and set but empty: both hold the YAML value, and the variable
    is exported.
  - A tagged non-string field: a panic with its message.
  - This repo's config with `TWILIO_PHONE_NUMBER` set: the map holds the
    variable.
- D3. `dsn`, called directly, with no database:
  - Outside production, each of the six `sslmode` values ends
    `?sslmode=<value>`, and without the key the DSN equals today's string.
  - `require&x=y` and `bogus`: the error with its message.
  - With `ENV=PRODUCTION`: absent, `disable`, `allow` and `prefer` each give
    the production error; `require`, `verify-ca` and `verify-full` give a
    DSN ending `?sslmode=<value>`.
  - With `ENV=PRODUCTION`: an empty `postgres_user`, and an empty
    `postgres_password`, each give its error (owner).
  - `connect` panics with the error `dsn` returns.
  - A user `app@x` and a password `p@ss/w:rd?#1` give a DSN that `net/url`
    parses back to the same user and password (owner).
  - With a recording logger, and `open` replaced by a stub whose error
    quotes the raw password, its escaped form and the DSN: the control
    shows the stub's error holds all three, and the logged line holds none
    of them, with `xxxxx` in their place (owner).
  - A password stored percent-encoded, `p%40ss`, gives a DSN that decodes
    to the literal `p%40ss`, as `docs/BEST_PRACTICES.md` §7 documents
    (owner).
  - Outside production, with an empty password and a stub error that
    quotes the DSN: the logged line equals the stub's text with only the
    DSN replaced (owner).
  - With the password `password` and a stub error containing `password
    authentication failed`: the logged line reads `xxxxx authentication
    failed` (owner).
- D4. This repo's `config.yml`:
  - `ticketmaster.api_key`, `postgres.user` and `postgres.password` are
    empty, and `postgres.sslmode` is `require`.
  - With `TICKETMASTER_API_KEY` set, the map holds it.
  - Every key in `config.yml` is in `.basetobase/ci/local.yml` and the
    reverse, and the latter's `postgres.sslmode` is `disable`.
- D5. In package `main`:
  - Reflection on the config struct finds the seven tag names: the five
    Postgres ones, `POSTGRES_SSLMODE` and `TICKETMASTER_API_KEY`.
  - `go/ast` on `main.go` finds `host, port := app.ListenAddr("localhost",
    8080)`, and `app.NewApp` called with `host` and `port` as its first two
    arguments (owner).

**Logs**

- L1. Through `Handler()` with sign-in, using the recording logger. A token
  and an `Authorization` header carry marker strings, on a `200`, a `401`
  and a `503`. No marker appears in any log line or error body.
- L2. Through `Handler()` with a connector. A tool argument and a tool
  result carry markers, on a success, a schema failure, a handler error
  and a panic. No marker appears in any log line or error body.

**Compatibility**

- C1. The existing tests pass unchanged. An app with no `auth.Service` and
  no `app.MCP` entry answers `/health` and its routes with no token.

**Evidence, not gates**

- B1. `BenchmarkToolCall` runs a verified `tools/call` with RS256 and ES256
  tokens. Its output goes in the PR.
- C2. After each tag, recruiter is bumped to it, following its upstream
  flow (recruiter CLAUDE.md, "Where code lives"). Its CI result on the bump
  commit is reported. It does not gate the next part (owner).

**Evidence a reviewer sees.**

- The test output naming every A, K, G, M, R, D, L and C1 test.
- The `401` response and the metadata document that A2 and A11 log.
- The `tools/list` response from M1.
- B1's output.
- Recruiter's CI result on each bump.

## Approaches

**Sign-in**

1. **A hosted sign-in service, with the framework only verifying tokens**
   (picked, owner). Days of work and a small security surface. It depends
   on a vendor.
2. **An authorization server in the framework.** No vendor, but login,
   token issuing and client registration become the most security-
   sensitive code in the framework. Rejected by the owner.
3. **No sign-in, with a secret in the connector URL.** Rejected: Claude's
   guide and the MCP specification forbid a token in a URL, and it names
   no user.

**The hosted service.** WorkOS AuthKit (picked):

- its guide covers MCP directly
- it supports Client ID Metadata Documents and dynamic registration
- it puts the connector URL in the token's `aud`
- it publishes a key set
- 1,000,000 users are free

The alternatives: Clerk has the best Expo components and 50,000 free users,
but its connector tokens are verified differently from its session tokens.
Auth0 has supported MCP since May 2026, with 25,000 free users and more
setup.

**The key set**

1. **Fetch and cache policy in `pkg/auth`, over `pkghttp.GetBytes`, keys
   parsed by jwkset** (picked). One limit, one fetch at a time and a byte
   cap, which reviewers asked for, with the 10 s limit and the waiting rule
   ruled by the owner. The spacing and the hour run on a test clock and the
   5 s deadline is shortened in tests, so K1–K10 run in milliseconds.
2. **keyfunc v3.9.2.** It gives an hourly refresh, a timeout and an
   unknown-`kid` limiter. It has no byte cap and no single limit across
   every kind of fetch. Its limiter and refresh run on the real clock, so
   K1, K3, K4 and K9 would wait up to an hour for real.
3. **A hand-written JWK parser.** One less dependency, but parsing keys by
   hand is where verification goes wrong.

**Serving the connector**

1. **The official Go SDK behind `pkg/mcp`** (picked). The protocol is the
   SDK's job; the framework adds registration, injection, bounds and error
   masking.
2. **A hand-written JSON-RPC endpoint.** One less dependency, and every
   protocol revision becomes our work.
3. **Tools generated from `openapi.yml`.** Spec-first, but a REST operation
   and a tool a model can use well are cut differently, and oapi-codegen
   has no such generator.
4. **A separate TypeScript connector calling the Go API.** A second deploy,
   and the caller's token must be passed on.

## Delivery

Three PRs, in this order. Each names this design and its part. After each
merges, the merge commit is tagged and recruiter is bumped to the tag (C2,
evidence only).

- **§1 Deploy readiness**, tagged v0.4.0.
  - `app.ListenAddr` and the `env:` rule.
  - `dsn` with `postgres_sslmode`, the production rules and credential
    escaping, and `connect`'s redaction through the `open` variable.
  - The `main.go` changes: the address, the tags and `SSLMode`.
  - `config.yml` without the Ticketmaster key or the Postgres user and
    password, and with `sslmode: require`.
  - `.basetobase/ci/local.yml` with `sslmode: disable`.
  - `docs/BEST_PRACTICES.md` §4 and §7.
  - Tests D1–D5.
  - After it merges, the owner rotates the Ticketmaster key.
- **§2 Sign-in**, tagged v0.5.0.
  - `pkg/auth` and `pkg/auth/authtest`.
  - `Handler()`, the `newLogger` variable, and in `router.go` the function
    that mounts the metadata routes.
  - `pkghttp.HasAuthMiddleware`, `pkghttp.GetBytes` and
    `apierror.Unavailable`.
  - jwt and jwkset.
  - The sign-in docs and the ownership rule.
  - Tests A1–A15, K1–K10, G1, L1 and C1.
- **§3 Connector**, tagged v0.6.0.
  - `pkg/mcp`, and in `router.go` the `app.MCP` entry kind, the function
    that takes it out of the slice, the connector added to the mount
    function, and the connector registration panics.
  - `apierror.TooLarge`.
  - The named panic in `injectFields`.
  - The SDK.
  - The docs, `app/CLAUDE.md`, `app/tool/CLAUDE.md` and the golden flow.
  - Tests M1–M16, R1, L2 and B1.

§2 does not need §1. §3 needs §2 for `Handler()`, `auth.FromContext` and
the sign-in requirement. thetraveler requires v0.6.0.

## Decisions

- Plan through Claude, with thetraveler as a connector **(owner)**.
- Shared pieces are built in the framework, not in the project
  **(owner)**.
- Sign-in is a hosted service, not built into the framework **(owner)**.
- Free hosting with no card (Base to Base design §3) **(owner)**.
- The committed Ticketmaster key is rotated: the owner creates a new key,
  which replaces it before the old one is revoked **(owner)**.
- Sign-up is open, with no gate and no spend cap. Each app checks
  ownership by subject **(owner)**.
- The owner checks at WorkOS sign-up whether a card is asked for. If it
  is, the design switches provider before any code **(owner)**.
- An app that declares a connector without sign-in does not start. This
  repo's app serves no tools; a test fixture proves the pattern
  **(owner)**.
- A variable already set for an `env:`-tagged field wins over YAML.
  Claude checked recruiter in this session **(owner)**.
- This design is proven by tests against the documented requirements. The
  first real connection is thetraveler's acceptance **(owner)**.
- In production, startup refuses a Postgres connection without TLS
  (`require`, `verify-ca` or `verify-full`) **(owner)**.
- The Postgres user and password leave `config.yml` **(owner)**.
- At most one key fetch starts every 10 s per instance, whatever wants it,
  and every attempt counts **(owner)**.
- Slots count running tool calls only: 32 per instance and 8 per subject.
  A slot is held until the handler returns, and a call with no slot gets
  `connector busy, try again` **(owner)**.
- No `app.Public`. Only `/health` and the metadata paths are public, and a
  clashing connector path stops startup **(owner)**.
- Tests replace `NewApp`'s logger through an unexported variable
  **(owner)**.
- `HasAuthMiddleware` returns whether the hook is non-nil, so
  `SetAuthMiddleware(nil)` clears it **(owner)**.
- The recruiter bump is evidence, not a gate **(owner)**.
- In production, an empty Postgres user or password stops startup
  **(owner)**.
- A host without `ENV=PRODUCTION` already fails to start, and §1's docs
  tell every host to set it **(owner)**.
- `app/tool/CLAUDE.md` ships in this repo with the tool-set rules
  **(owner)**.
- The seven new modules are accepted on every app's build **(owner)**.
- A slot's release is deferred, and a subject's count is deleted at zero
  **(owner)**.
- Connector tests run behind real sign-in, and a request with no
  identity is refused before its body is read **(owner)**.
- `main.go` uses `host, port := app.ListenAddr(...)` **(owner)**.
- Requests wait for a running key fetch, up to 5 s, and are then judged on
  the keys held **(owner)**.
- Reader places are freed however the read ends, a subject's count is
  dropped at zero, and every connector request takes one **(owner)**.
- The Postgres user and password are escaped in the DSN, and a logged
  connection error never shows the password **(owner)**.
- Deploy readiness has success rows, from the Base to Base prerequisites
  **(owner)**.
- Credentials are always given raw. A password stored percent-encoded must
  be stored decoded, which is goal 8's third exception **(owner)**.
- The new `413` and no-identity `500` bodies read `request body too large`
  and `internal server error` **(owner)**.
- WorkOS AuthKit is the hosted service **(designer's call)**.
- One provider, named by a required `auth_provider`
  **(designer's call)**.
- Default deny. An unknown path gets `401` without a token
  **(designer's call)**.
- The first anti-goal applies once sign-in or a connector exists
  **(designer's call)**.
- `pkg/auth` and `SetAuthMiddleware` cannot both be set
  **(designer's call)**.
- The order of the sign-in checks. A request without a token never gets
  `503` **(designer's call)**.
- The `Bearer` scheme in any case, with exactly one `Authorization` header
  **(designer's call)**.
- `Identity` carries only `Subject` **(designer's call)**.
- `env:` is for string fields only **(designer's call)**.
- `postgres_sslmode` is checked against libpq's six values
  **(designer's call)**.
- `app.ListenAddr` reads `HOST` and `PORT` **(designer's call)**.
- All parsing of the routes slice stays in `router.go`
  **(designer's call)**.
- The key set is fetched through a new `pkghttp.GetBytes` on the shared
  client's transport, with redirects refused **(designer's call)**.
- Reader places: 64 per instance and 8 per subject. The per-subject half
  keeps the owner's slot ruling true, that one account cannot lock the
  owner out; a reader pool without it would reopen that lockout
  **(designer's call)**.
- `.basetobase/ci/local.yml` sets `sslmode: disable` **(designer's call)**.
- The DSN is built by an unexported `dsn` that tests call directly
  **(designer's call)**.
- Redaction covers the raw password, its escaped form and the whole DSN,
  and is tested through an unexported `open` variable **(designer's call)**.
- Redaction skips an empty password, and otherwise hides every occurrence
  of the password **(owner)**.
- `auth_issuer` has no trailing slash, and `auth_resource` is an absolute
  URL **(designer's call)**.
- The connector is stateless with JSON responses, tools only, and one
  endpoint per app **(designer's call)**.
- Protocol errors keep the SDK's bodies. Only the framework's own `401`,
  `405`, `413`, `500` (no identity), `503` and `504` are problems
  **(designer's call)**.
- Argument errors are tool errors and an unknown tool is a protocol
  error, as the MCP specification's tool error handling says
  **(designer's call)**.
- The other bounds: 256 KiB body and result, 64 tools, 1 KiB `Errorf`,
  8 KiB token, 64 KiB key set, 30 s skew and a 5 s fetch deadline
  **(designer's call)**.
- A tool's error is masked unless built with `mcp.Errorf`. Logged errors
  are cut at 512 bytes, and a panic's value is logged only for a
  `runtime.Error` **(designer's call)**.
- The SDK's DNS-rebinding check is off **(designer's call)**.
- The key set's fetch policy is our own code, with jwkset parsing
  **(designer's call)**.
- `injectFields` names an unexported field **(designer's call)**.
- Tool sets live in `app/tool/<name>/`, created first by thetraveler
  **(designer's call)**.
- Each part is tagged and recruiter is bumped, following recruiter's
  upstream flow **(designer's call)**.

## Left to the builder

- File names and unexported names inside `pkg/auth`, `pkg/auth/authtest`
  and `pkg/mcp`.
- Whether the metadata handler is hand-written or the SDK's helper; the
  bytes are fixed above.
- How the `app.MCP` entry is represented inside `router.go`.
- Log field names beyond the five listed under "Security".
- The wording of the new `CLAUDE.md` files and doc sections.
- The shape of B1.

## Design review

Panel: BLD, GOAL, QLT, SCL, INF, SEC, FUN. Why: full design with no screen.

Round 1:
- BLD-1 Reference order tools have no inputs, outputs, annotations or service mapping: revised What we're building
- BLD-2 No clock seam in the public signature, yet A3 and A11 depend on one: revised Scaling
- BLD-3 405 for GET/DELETE on the connector: SDK body or router problem: revised API contract
- BLD-4 Order of checks among 401 and 503 is open: revised API contract
- BLD-5 `env:` rule silent on non-string fields and where the override is applied: revised Fit with existing features
- GOAL-1 Goal 7 and the 'existing consumer' anti-goal contradict the env: rule: owner: accepted as a deliberate change; Claude checked recruiter, which has no env: tags
- GOAL-2 An app can serve MCP with no sign-in and still meet every goal: owner: an app with a connector and no sign-in does not start
- GOAL-3 Success line does not check the problem: Claude accepting the connector: owner: tests against the documented requirements now; the first real connection is thetraveler's acceptance
- GOAL-4 No-card and no-paid-resource constraints rest on an unanswered question: owner: the owner checks at WorkOS sign-up; a card means switching provider before code
- GOAL-5 Identity.Scopes and Identity.Claims serve no goal: revised API contract
- GOAL-6 Order tools in the production app go beyond what the Why needs: owner: this repo's app serves no tools; a test fixture proves the pattern
- GOAL-7 Tests A11 and A13 are named by no goal's 'Done' line: revised Goals, non-goals, anti-goals
- QLT-1 Reference order tools may duplicate OrdersController validation and error mapping; design does not say where it lives: revised What we're building
- QLT-2 newRouter and NewApp must carry public paths and the MCP handler, but the Changed table lists no signature change and no caller outcome: revised Fit with existing features
- QLT-3 Claim that tool-set injection works "as it does a controller's" and covers "exported fields" does not match injectFields: revised Fit with existing features
- QLT-4 The env: rule is silent on non-string tagged fields and on the mandatory config file that env-only deploys still need: revised Fit with existing features
- QLT-5 pkg/auth is a second auth seam beside SetAuthMiddleware, with two ordering rules to remember: revised Fit with existing features
- SCL-1 Timed-out handlers keep running; in-flight work is unbounded: revised Scaling
- SCL-2 Memory per request at the stated bounds is not worked: revised Scaling
- SCL-3 Key-set download has no byte cap; only the key count is bounded: revised Scaling
- SCL-4 Is the key-set lock held across the outbound fetch?: revised Scaling
- SCL-5 Reference order tools: per-call cost and argument bounds not stated: revised API contract
- SCL-6 'Sized for 50 rps' and 'under a millisecond of CPU' have no number or test behind them: revised Scaling
- INF-1 Public host and Postgres host are needed but not listed, so the $0 total is incomplete: revised Infrastructure and dependencies
- INF-2 auth_* config keys have no stated place where they are set: revised Infrastructure and dependencies
- INF-3 WorkOS free-tier limits and card requirement unstated, against an owner decision of no card: owner: the owner checks at WorkOS sign-up; a card means switching provider before code
- INF-4 Pay-per-use WorkOS MAU has no cap, alert or owner opt-in: owner: sign-up stays open, with no gate and no spend cap
- INF-5 Switching off leaves the WorkOS environment and its settings in place: revised Infrastructure and dependencies
- INF-6 keyfunc/jwkset adds two modules for fetching a key set under custom bounds: revised Approaches
- SEC-1 Any self-registered AuthKit user passes as the 'signed-in user': owner: sign-up is open; each app checks ownership by subject
- SEC-2 Reference /mcp order tools are anonymous, with no stated owner check on get_order: owner: this repo's app serves no tools
- SEC-3 A production deploy with no auth.Service silently serves every route anonymously: owner: an app with a connector and no sign-in does not start
- SEC-4 No transport check on auth_issuer and auth_jwks_url in production: revised Infrastructure and dependencies
- SEC-5 What a logged handler error or panic may contain is not bounded: revised Security
- SEC-6 A committed, real-looking API key stays in config.yml for a public deployment: owner: the key is rotated; the owner creates a new key before the old one is revoked
- SEC-7 Input bounds for tool arguments are left to each tool set; none are stated for the order tools: revised API contract
- FUN-1 Anti-goal 'no token, header, argument or result in a log line' has no test: revised How we'll know it works
- FUN-2 Key-set behaviour in Scaling and Failure is mostly untested: revised How we'll know it works
- FUN-3 Token and header edge cases missing from A1-A9: revised How we'll know it works
- FUN-4 Public-path exactness and unknown-path behaviour untested and unspecified: revised How we'll know it works
- FUN-5 Rows of the connector response table have no test: revised How we'll know it works
- FUN-6 Missing Accept/Content-Type, protocol-version header and rebinding protection behaviour on POST: revised API contract
- FUN-7 Behaviour left open in tools and unauthenticated connector: revised API contract
- FUN-8 D1-D3 miss the boundaries of the env, PORT and sslmode rules: revised How we'll know it works
- FUN-9 Rollback and compatibility claims have no test that runs them: defended: no state to roll back; switching off removes two lines together, recruiter was checked and is bumped per tag, and the framework registers nothing on its own
- FUN-10 A handler panic claim: 'Recover cannot catch it' is stated, not shown; M5 may pass for the wrong reason: revised Failure and rollback
- FUN-11 A11 and A3 depend on a test clock whose mechanism is left open; reviewer evidence for sign-in is missing: revised How we'll know it works
- FUN-12 Choosing 200 + isError for schema-invalid arguments and a stateless endpoint is not justified against the tests that prove it: defended: the MCP 2025-11-25 tools specification makes input validation errors tool execution errors and unknown tools protocol errors

Round 2:
- SEC-8 Production Postgres connection may be unencrypted: postgres_sslmode is optional with no production floor: owner: in production, startup refuses a connection without TLS
- SEC-9 An unset env: secret silently falls back to the committed dev credential: owner: the Postgres user and password leave config.yml
- QLT-6 Key-set fetch is hand-written outbound HTTP; design does not say why pkg/http's helper is not used or extended: revised Fit with existing features
- QLT-7 Route-slice parsing, MCP mounting and registration panics now live in NewApp, which router.go and app/CLAUDE.md give to the router: revised Fit with existing features
- QLT-8 HasAuthMiddleware is defined as true "once SetAuthMiddleware has set a hook", which is ambiguous for SetAuthMiddleware(nil) and for tests: owner: the hook counts as set while non-nil; SetAuthMiddleware(nil) clears it
- GOAL-8 §2 ships the injectFields panic with no goal or test; L1 tests §2's middleware but ships in §3: revised Delivery
- GOAL-9 Goal 8's measure of done, C2, happens after merge in another repo: owner: the recruiter bump is evidence, not a gate
- GOAL-10 Goal 4's key-set bounds are the designer's, and cost hand-written security code over keyfunc: defended: the bounds trace to the owner's 10 s ruling, and keyfunc's timers run on the real clock
- GOAL-11 app.Public has no need named in the Why: owner: app.Public is dropped
- GOAL-12 The 'forgotten line' anti-goal still holds for an app with no connector: revised Goals, non-goals, anti-goals
- BLD-6 Retry rate after a failed hourly refresh is open, so the stated fetch bound can break: owner: at most one key fetch starts every 10 s per instance, and every attempt counts
- BLD-7 Which requests take one of the 32 slots, and what the slot spans, are left open: owner: only running tool calls hold slots, until the handler returns; 8 per subject
- BLD-8 Who adds /health and the metadata paths to the public list passed to Middleware: owner: app.Public is dropped; pkg/auth leaves only /health and its metadata paths public
- SCL-7 Stale-key refresh has no rate limit once a refresh fails, so the fetch bound is false: owner: at most one key fetch starts every 10 s per instance, and every attempt counts
- SCL-8 One signed-up user can fill all 32 in-flight slots, and slow bodies hold a slot: owner: only running tool calls hold slots, until the handler returns; 8 per subject
- SCL-9 The 5-minute unknown-kid limiter lets a forged token delay a key rotation by 5 minutes: owner: at most one key fetch starts every 10 s per instance, and every attempt counts
- FUN-13 No retry spacing after a failed hourly refresh; the stated fetch bound can be exceeded and no test catches it: owner: at most one key fetch starts every 10 s per instance, and every attempt counts
- FUN-14 'A slot is released when the handler returns, not at the 10 s cut' has no test: owner: only running tool calls hold slots, until the handler returns; 8 per subject
- FUN-15 M11's 'Host over loopback: 200' cannot fail when run through httptest with Handler(): revised How we'll know it works
- FUN-16 Sign-in step 2 rules have no test: missing kid and algorithms other than RS256/ES256: revised How we'll know it works
- FUN-17 An app.Public path equal to the connector path leaves the connector anonymous; not a registration mistake: owner: app.Public is dropped; a clashing connector path stops startup
- FUN-18 NewApp creates its own logger, so A15's startup line and end-to-end L1 have no capture point: owner: tests replace NewApp's logger through an unexported variable
- FUN-19 main.go wiring and the controller-side injectFields panic are covered by no test: revised How we'll know it works
- FUN-20 A14 depends on a package global the design gives no way to reset: owner: the hook counts as set while non-nil; SetAuthMiddleware(nil) clears it

Round 3:
- INF-7 go-sdk adds four unlisted modules; Libraries and Consumers name only three: owner: the seven modules are accepted on every app's build and listed
- GOAL-13 §1 adds a config.yml key but ships no matching change to .basetobase/ci/local.yml: revised Fit with existing features
- SEC-10 GetBytes on the shared client follows redirects, so the https floor on auth_jwks_url can be bypassed: revised Fit with existing features
- SEC-11 'A missing Postgres variable fails at connect' is asserted and untested; empty credentials may be accepted: owner: in production an empty Postgres user or password stops startup
- SEC-12 Every production floor depends on ENV=PRODUCTION, and a host that omits it fails open: owner: rely on the missing local.yml stopping startup, and document that hosts set ENV=PRODUCTION
- QLT-9 Claim that .basetobase/ci/local.yml is unchanged breaks the rule that it tracks every config.yml key: revised Fit with existing features
- QLT-10 app/tool/ is a new pattern whose CLAUDE.md is left to thetraveler, while this repo ships a golden flow that points at it: owner: app/tool/CLAUDE.md ships in this repo with the tool-set rules
- SCL-10 Body-reading memory is bounded only by request rate; at 10x it passes 512 MiB, and a caller sets the rate: revised API contract
- SCL-11 Slot counter map: cleanup and release on panic are not stated: owner: the release is deferred, and a subject's count is deleted at zero
- BLD-9 D3 says TLS modes 'connect' in a suite that needs no database; connect() has no seam to test: revised Fit with existing features
- BLD-10 How pkg/mcp learns the caller's subject is unspecified, and so is the no-identity case: owner: connector tests run behind real sign-in; a tool call with no identity is refused
- BLD-11 `app.ListenAddr` returns two values, so it cannot replace the first two NewApp arguments as written; D5's check has no stated shape: owner: main.go uses host, port := app.ListenAddr(...)
- FUN-21 D3 needs a DSN seam and, for production cases, a database; neither is named: revised How we'll know it works
- FUN-22 'A production Postgres variable not set: the connection fails at startup' is untested and not guaranteed: owner: in production an empty Postgres user or password stops startup
- FUN-23 Callers that arrive while a key fetch is already running: wait for it, or get 503/401 at once?: owner: requests wait for a running fetch, up to 5 s
- FUN-24 M13 sends 50 concurrent calls at a 32-slot limit and expects fifty results: revised How we'll know it works
- FUN-25 A12, shipped in §2, needs the connector that ships in §3: revised How we'll know it works
- FUN-26 Which subject owns a call when no identity is in the context: owner: connector tests run behind real sign-in; a tool call with no identity is refused
- FUN-27 Auth config edges and the metadata path cases are untested: revised How we'll know it works
- FUN-28 pkghttp.GetBytes has no test; the 64 KiB boundary is tested on one side only: revised How we'll know it works

Round 4:
- SCL-12 Reader places: release on a failed or aborted body read is not stated or tested: owner: reader places are freed however the read ends, and a subject's count is dropped at zero
- SEC-13 The DSN is built from environment credentials with no stated escaping, and a connect error is logged: owner: the user and password are escaped, and a logged connection error never shows the password
- GOAL-14 Success covers connector and sign-in only; deploy readiness, the Why's third gap, has no success line: owner: success rows added for deploy readiness, from the Base to Base prerequisites
- GOAL-15 Per-subject reader places and a 64-place pool are scope the Why's load does not justify: defended: the per-subject half keeps the owner's slot ruling true, that one account cannot lock the owner out
- GOAL-16 §2 ships the metadata routes but the mounting function is listed in §3: revised Delivery
- BLD-12 Claims BEST_PRACTICES §7 already says every host sets ENV=PRODUCTION; the repo's §7 does not: revised Infrastructure and dependencies
- BLD-13 Approaches says K1-K9 run in milliseconds under a test clock; K10 exists and K5 and K10 use real time: revised Scaling
- FUN-29 Reader-place release and the no-identity reader case are untested and open: owner: reader places are freed however the read ends, and a request with no identity is refused before its body is read
- FUN-30 What a waiting request gets when the fetch it waited for fails, hangs or lacks its key: owner: a waiting request is judged on the keys held when its wait ends

Round 5:
- QLT-11 url.UserPassword changes the DSN for existing credentials that contain reserved or percent characters; callers' outcome stated as unchanged: owner: credentials are given raw; a password stored percent-encoded must be stored decoded
- SEC-14 Password redaction in the logged connect error covers the raw password, not its escaped form or the DSN: revised Fit with existing features
- GOAL-17 DSN escaping and error redaction are a third consumer-visible change; goal 8 lists two: owner: accepted as goal 8's third exception; credentials are given raw
- FUN-31 D3's password-redaction test cannot fail, and the redaction rule is ambiguous about escaping: revised How we'll know it works
- BLD-14 Decision says only 401, 413, 503 and 504 are problems; the design also returns 405 and 500 problems: revised Decisions
- BLD-15 Detail text of the new 413 and no-identity 500 problem bodies is not stated: owner: 'request body too large' and 'internal server error'

Round 6:
- BLD-16 Redaction with an empty password outside production is unspecified and a literal replace would corrupt the log: owner: an empty password skips the raw and escaped replacements; otherwise every occurrence is hidden
- FUN-32 Redaction with an empty password corrupts the logged error outside production, and no test covers it: owner: an empty password skips the raw and escaped replacements; otherwise every occurrence is hidden

Round 7:

Quorum: BLD, GOAL, QLT, SCL, INF, SEC, FUN clear on revision 7
