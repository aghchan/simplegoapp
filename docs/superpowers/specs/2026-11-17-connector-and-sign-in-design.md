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
   from environment variables and can require TLS to Postgres. This
   repo's Ticketmaster key leaves `config.yml`.
2. **Sign-in (`pkg/auth`).** An app registers one service, and every route
   then requires a bearer token issued by a hosted sign-in service (WorkOS
   AuthKit). Handlers read the signed-in caller from the request context.
3. **Connector (`pkg/mcp`, `app.MCP`).** An app declares tools in `main.go`
   and the framework serves them to Claude as a remote MCP server. An app
   that declares tools without sign-in does not start.

This repo's app serves no tools. A tool set in the tests proves the
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

## Goals, non-goals, anti-goals

**Goals**

1. `pkg/auth` verifies a bearer token's signature, issuer, audience, expiry
   and subject, and puts the caller in the request context. Done: A1, A3–A10,
   A13.
2. Default deny. Once `auth.NewService` is registered, every path needs a
   valid token except `/health`, the metadata document and the paths the app
   declares with `app.Public`. Done: A2, A11, A12, A14.
3. Claude can find the sign-in server from a `401`. Done: A2, A11.
4. Sign-in degrades safely. Held keys keep verifying while the key set is
   unreachable. With no key held, protected paths answer `503` and recover
   once a fetch succeeds. Fetches stay within the bounds in "Scaling". Done:
   K1–K8.
5. `pkg/mcp` serves tools declared in `main.go`, with injected services,
   validated input, annotations, bounded size and concurrency, and masked
   errors. Done: M1–M13, M15.
6. A connector never runs without sign-in (owner). Done: M14.
7. Deploy readiness. Done: D1–D4.
8. Apps that use none of it are unchanged, except that an environment
   variable already set for an `env:`-tagged field now wins over YAML
   (owner). Done: C1, C2.
9. No token, header, tool argument or tool result reaches a framework log
   line or error body. Done: L1.

**Non-goals**

- An authorization server of our own: login pages, token issuing, client
  registration. The owner chose a hosted service.
- Sign-in for the Expo app (web and iOS). It belongs to part 2 of the
  standard. `pkg/auth` takes one issuer now; a second is new config keys.
- Gating who may sign up. Sign-up is open (owner). Users, roles, sharing
  and invitations belong to each app, keyed on the caller's subject.
- The first real connection from Claude (owner). It needs a deployed app
  and a WorkOS account, so it is thetraveler's acceptance.
- Hosting: the host, the database and the deploy pipeline. Part 3, Base to
  Base M4 and thetraveler's design.
- MCP resources, prompts, sampling, server-to-client requests, streaming
  responses and sessions. Tools over request and response cover the need.
- Rate limiting per caller. The framework has none on any route today.
  `pkg/mcp` caps concurrent calls (see "Scaling"), which bounds load but
  not any one caller's share.
- A tool set served by this repo's app (owner).
- New lens rules for connectors. They wait for a second design that needs
  them.

**Anti-goals**

- A request reaching a handler without a verified caller because a line
  was forgotten.
- A token issued for another app being accepted.
- A token, an `Authorization` header, a tool argument or a tool result in
  a framework log line or error body.
- A panic in one tool call stopping the process.
- An existing consumer breaking on upgrade.
- App code importing the MCP SDK or the JWT libraries directly
  (docs/BEST_PRACTICES.md §6).
- A paid resource appearing without the owner opting in.

## Fit with existing features

**Not duplicates.** `pkg/gmail/authorize.go` obtains Google tokens for
this app's outbound calls; `pkg/auth` verifies tokens presented to this
app. `SetAuthMiddleware` (pkg/http/middleware.go:210) is the existing seam.
An app uses it or `pkg/auth`, never both (below).

**Changed**

| Thing | Change | What existing callers see |
|---|---|---|
| `app.NewApp` (app/app.go:33) | Signature unchanged. 1) Before `newRouter`, it takes the `app.Public` and `app.MCP` entries out of the routes slice and passes the rest on unchanged. 2) After `resolve`, it looks up `auth.Service` as it looks up `postgres.Service` (app/app.go:86), but optionally. 3) On the router `newRouter` returns, it mounts the metadata routes (when `auth.Service` is registered) and the connector (when an `app.MCP` entry exists). 4) It panics when an `app.MCP` entry exists without `auth.Service`, and when `auth.Service` is registered while a `SetAuthMiddleware` hook is set. | No change without the new entries and service. |
| `App.Run` chain (app/app.go:110-118) | Built by the new `Handler()`. The auth slot (line 117) holds `pkghttp.Auth()` when no `auth.Service` is registered, and the service's middleware when one is. Only one of them can be set. | Same chain for today's apps. |
| `app` interface (app/app.go:18) | Gains `Handler() http.Handler`, the chain `Run` serves. `Run` calls it. | Additive. Tests use it with `httptest`. |
| Config flattening (app/app.go:58-74) | For a field with an `env:` tag, `os.LookupEnv` is read first. Set and not empty: its value replaces the YAML value in the struct and in the flat map. Otherwise: the YAML value is exported as today (app/app.go:68). `env:` is for string fields only. A tagged field of another type panics with `config: <Section>.<Field> has an env tag but is not a string`; today it panics on the type assertion at app/app.go:68. The config file stays required (app/app.go:50-53). | Changes only when a tagged variable is already set at startup: today YAML overwrites it; after, it wins (owner). `main.go:23` (`TWILIO_PHONE_NUMBER`) is this repo's one tag today. |
| `newRouter` (app/router.go:76) | Signature unchanged. | Unchanged; `router_test.go` calls it as before. |
| `injectFields` (app/router.go:42) | Before injecting a field, it panics with `field <Name> of <Type> is unexported; injected fields must be exported` when the field cannot be set. Tool sets use it too. | Today an unexported field panics inside reflect; now the panic names it. Existing messages are unchanged (router_test.go:47-57). |
| `pkg/postgres` `connect` (pkg/postgres/service.go:120) | Reads `postgres_sslmode` with a checked type assertion. Absent or empty: the DSN is byte-identical to today. One of `disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full`: the DSN ends `?sslmode=<value>`. Anything else panics with `postgres: postgres_sslmode must be one of disable, allow, prefer, require, verify-ca, verify-full`. | No change without the key. |
| `pkg/http` | Gains `HasAuthMiddleware() bool`, true once `SetAuthMiddleware` has set a hook. | Additive. |
| `pkg/http/apierror` | Gains `Unavailable(detail)` (503, code `unavailable`) and `TooLarge(detail)` (413, code `payload_too_large`). | Additive. |
| `main.go` | `app.ListenAddr("localhost", 8080)` replaces the literals (lines 62-63). The Postgres fields gain `env:` tags `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DATABASE`; all five are strings today. `Ticketmaster.APIKey` gains `env:"TICKETMASTER_API_KEY"`. No `app.MCP` entry. | Same address and config unless those variables are set. |
| `config.yml` | `ticketmaster.api_key` becomes empty (owner). | Production reads the key from `TICKETMASTER_API_KEY`. Nothing in this repo calls Ticketmaster: `ticketmaster.Service` is resolved but no code uses it. |

`.basetobase/ci/local.yml` is unchanged; it already holds a placeholder.

**Unchanged and relied on**

- `TimeoutMW` buffers every response and cuts a request at 10 s
  (app/app.go:116, pkg/http/middleware.go:154). The connector answers with
  one JSON body, never a stream, so it works behind it. A throwaway test
  against go-sdk v1.8.0 confirmed this. The handler gets the request's
  context, so a tool handler sees the 10 s deadline.
- `CORS` answers a preflight before the auth slot (pkg/http/middleware.go:185),
  so preflights need no token.
- `RequestLogger` logs method, path, status, duration and request id only
  (pkg/http/middleware.go:99-116).
- `/health` (app/router.go:81) stays public.

**New**

- `pkg/auth/`, `pkg/auth/authtest/` (a test issuer: signs RS256 and ES256
  tokens, serves a key set, counts fetches, can be stopped and hung), and
  `pkg/mcp/`, each with a `CLAUDE.md`.
- `app/CLAUDE.md` gains the two entry kinds. The root `CLAUDE.md` gains a
  third golden flow, "New connector tool". `docs/BEST_PRACTICES.md` gains
  sign-in, connector tools, the ownership rule (see "Security") and the
  `env:` rule (§4).
- Tool sets live in `app/tool/<name>/`, beside `app/controller/`. The docs
  state this. thetraveler creates the first such directory, with its
  `CLAUDE.md`.

**Consumers.** `aghchan/recruiter` at e1bd8d8 pins simplegoapp v0.3.1. Checked
in this session: its `go.mod` says `go 1.25.0`, its config struct has no
`env:` tags (main.go:13-26), and nothing in it calls `SetAuthMiddleware`. It
uses `app.NewApp`, `app.Spec`, `pkg/http`, `apierror`, `pkg/postgres`,
`pkg/linear`, `pkg/gmail`, `pkg/llm` and `pkg/logger`. Upgrading changes
nothing it uses. Its binary gains go-sdk, jwt and jwkset, because `app`
imports `pkg/auth` and `pkg/mcp`.

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
  "<value>"`.
- A tool set is a pointer to a struct. `NewApp` injects its fields with
  `injectFields`, as it does a controller's. Every field must be exported
  and have a provider.
- `In` and `Out` are structs. `In`'s JSON schema is inferred from the type,
  nested structs included; a `json` tag names a field and a `jsonschema`
  tag describes it. Unknown fields are refused at every level. A pointer
  field is optional. The schema carries no length or range limits, so a
  handler checks them, as a controller does (api/CLAUDE.md), and returns
  `mcp.Errorf`.
- A handler gets the request's context, with the 10 s deadline. It must
  return when that context is done.
- `FromContext` returns the caller and `true` behind `pkg/auth`, and
  `false` anywhere else.
- `auth.NewService` returns one value, as the resolver requires
  (app/resolver.go:132). Bad config panics, naming the key.

**Registration mistakes.** Each is a startup panic with a named message,
as the router's are (app/CLAUDE.md):

- an `app.MCP` entry without `auth.NewService` in the service list:
  `app.MCP requires auth.NewService in the service list`
- `auth.NewService` with a `SetAuthMiddleware` hook set:
  `auth.NewService and SetAuthMiddleware are both set; use one`
- a second `app.MCP` entry
- a path not starting with `/`
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
- an `app.Public` path not starting with `/`

`app.Public` without `auth.Service` is allowed and has no effect.

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

`pkg/mcp` reads the whole body, up to 256 KiB, before the SDK sees it. A
concurrency limit of 32 calls in flight applies before the body is read.

| Request | Response |
|---|---|
| `initialize`, `ping`, `tools/list` | `200`, JSON-RPC result |
| `tools/call`, handler returns a value | `200`, result with `structuredContent` and the same JSON as text |
| `tools/call`, arguments fail the schema (missing, wrong type, unknown field at any level, `arguments` absent) | `200`, result with `isError: true` and the validator's message. The handler does not run. |
| `tools/call`, handler returns `mcp.Errorf(...)` | `200`, `isError: true`, text is that message, cut at 1 KiB |
| `tools/call`, handler returns any other error, its `Out` fails to marshal, or it panics | `200`, `isError: true`, text `internal error`. Logged as in "Security". |
| `tools/call`, handler returns a value and an error | the error's row |
| `tools/call`, the result's JSON over 256 KiB | `200`, `isError: true`, text `result too large` |
| `tools/call`, unknown tool | `200`, JSON-RPC error `-32602` |
| Any other MCP method | the SDK's default answer (an empty list for `resources/list`) |
| Body over 256 KiB, with or without `Content-Length` | `413` problem, code `payload_too_large` |
| 32 calls already in flight | `503` problem, code `unavailable`, detail `connector busy`, header `Retry-After: 1` |
| Body that is not a JSON-RPC message | `400`, the SDK's plain-text body |
| `Accept` without both `application/json` and `text/event-stream` | `400`, the SDK's plain-text body |
| `Content-Type` other than `application/json` | `415`, the SDK's plain-text body |
| `MCP-Protocol-Version` the SDK does not support | `400`, the SDK's plain-text body |
| Handler still running at 10 s | `504` problem, code `timeout` (pkg/http/apierror/apierror.go:30) |

The SDK's plain-text rows were observed with go-sdk v1.8.0 in a throwaway
test. They are the transport's answers, not this app's contract.

**Sign-in.** When `auth.Service` is registered, these checks run in order
on every path that is not public. The first that fails decides the
response.

1. Exactly one `Authorization` header, in the form `<scheme> <token>`, with
   the scheme `Bearer` in any case. The token is not empty, contains no
   space, and is at most 8,192 bytes. Failure: `401` problem, code
   `unauthorized`, detail `authentication required`, header
   `WWW-Authenticate: Bearer resource_metadata="<M>"`.
2. Unverified checks on the token: it is a JWT, its `alg` is `RS256` or
   `ES256`, it has a `kid`, and its claims pass the claim checks in
   "Security". Failure: `401` problem, detail `invalid token`, header
   `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="<M>"`.
3. The key for `kid`, by the key-set policy in "Scaling". There is no key
   held and none can be fetched now: `503` problem, code `unavailable`,
   detail `sign-in service unavailable`. Keys are held but none matches:
   step 2's `401`.
4. The signature, then the claim checks again on the verified token.
   Failure: step 2's `401`.

`<M>` is the origin of `auth_resource`, then
`/.well-known/oauth-protected-resource`, then `P`. A request with no token
never gets `503`, so discovery works while the key set is down. A path
that matches no route is not public, so without a token it gets `401`,
not `404`.

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
| Tool calls in flight | 32 per instance |
| Tools per endpoint | 64 |
| `mcp.Errorf` message | 1 KiB |
| Bearer token | 8 KiB |
| Key-set response | 64 KiB |
| Usable keys in a set | 16 |

**Hot path, per request.**

- Sign-in: parsing, one signature check, no outbound call while the key
  is held.
- Connector: one bounded body read, the SDK's per-request server session
  (stateless mode), one JSON decode, one schema check, the handler, and
  two encodes of the result (structured and text).
- The framework makes no query.
- Its cost per request is not measured. Benchmark B1 records it.

**Memory.** A call in flight holds at most 256 KiB of body and about
768 KiB of response: the result twice, once structured and once as text,
inside a buffered response. Thirty-two calls hold at most about 32 MiB.

**Concurrency.** A call takes one of the 32 slots before its body is read
and releases it when its handler returns, not when the response is cut at
10 s. Live tool-handler goroutines therefore never pass 32. Services are
singletons. The tool list is built at startup and never written again.
`pkg/mcp` holds no per-caller state, so instances scale side by side with
nothing shared.

**Key set** (`pkg/auth`, hand-written over jwkset's parser):

- **Fetch.** `GET auth_jwks_url`, with a 5 s timeout and a body of at most
  64 KiB. The status must be `200`.
- **A usable key.** RSA of at least 2,048 bits, or EC P-256. A non-empty
  `kid`. `use` absent or `sig`. `alg` absent, or `RS256` for RSA and `ES256`
  for EC. Other keys are ignored.
- **A failed fetch.** Too large, not `200`, malformed, no usable key, or more
  than 16 usable keys. On failure the held keys are kept.
- **When a fetch happens.**
  - No keys held: on demand, at most once every 10 s.
  - A token's `kid` is not held while other keys are: on demand, at most once
    every 5 minutes.
  - The last success is more than an hour old: the next verification starts
    a refresh in the background and is answered from the held keys.
- **One fetch at a time.** Callers that need its result wait for it, at most
  5 s.
- **Locking.** No lock is held during the HTTP call. The key map is swapped
  under a write lock held only for the swap, and verification reads under
  a read lock.
- **Startup** fetches nothing and never waits.
- **Testing.** Time comes from an unexported clock field, `time.Now` in
  production, which the package's own tests replace.

These bounds hold at any request rate. A flood of bad tokens causes at
most 1 fetch every 10 s with no keys held, and 1 every 5 minutes with
keys held.

**What breaks first.** Slow handlers. At 20 requests a second, handlers
slower than 1.6 s fill the 32 slots, and further calls get `503 connector
busy` until a slot frees. A handler that ignores its context holds a slot
until it returns.

No cache, queue or table is added.

## Infrastructure and dependencies

**Libraries**, pinned in `go.mod`:

| Library | Version | For |
|---|---|---|
| `github.com/modelcontextprotocol/go-sdk` | v1.8.0 | the MCP server. It needs Go 1.25.0, which `go.mod` already states. |
| `github.com/golang-jwt/jwt/v5` | v5.3.1 | token parsing and checks. Already in `go.mod` as an indirect dependency, and required by the SDK. |
| `github.com/MicahParks/jwkset` | v0.11.4 | parsing a key set into keys (`JWKSMarshal.JWKSlice`, `JWK.Key`). Fetching and caching are `pkg/auth`'s own code. |

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
  (https://workos.com/docs/reference/rate-limits). The key-set fetches stay
  under 1 every 10 s per instance in the worst case.
- **A card at sign-up.** WorkOS's pricing page doesn't say whether one is
  required. The owner checks when creating the account. If WorkOS asks for a
  card, this design switches to another hosted provider before any code
  (owner).

**Hosting.** This design adds no host and no database. The app's host and
Postgres are named, priced and limited in thetraveler's design. A host
that sleeps when idle starts up before the app sees the request, so a cold
start does not count against the 10 s timeout.

**Config keys.** `auth.NewService` reads these from the flat config map.
An app declares them in its config struct under these `config:` names.
None of them is a secret, so they are committed in the app's `config.yml`
and set in its `local.yml`.

| Key | Required | Default | Meaning |
|---|---|---|---|
| `auth_provider` | yes | none | `workos`. Empty or unknown panics, as `llm_provider` errors (pkg/llm/service.go:68-79). |
| `auth_issuer` | yes | none | The AuthKit domain. The token's `iss` must equal it. |
| `auth_resource` | yes | none | The app's public connector URL, exactly as entered in Claude. The token's `aud` must contain it. |
| `auth_jwks_url` | no | `<auth_issuer>/oauth2/jwks` | The key set. The test seam. |
| `postgres_sslmode` | no | absent | Read by `pkg/postgres`. |

With `ENV=PRODUCTION`, `auth_issuer`, `auth_resource` and `auth_jwks_url`
must start with `https://`, else startup panics, naming the key.

**Environment variables.** `HOST` and `PORT` are read by `app.ListenAddr`.
Any variable an app names in an `env:` tag is read as well. This repo adds
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_HOST`, `POSTGRES_PORT`,
`POSTGRES_DATABASE` and `TICKETMASTER_API_KEY`.

**Secrets.**

- **The Ticketmaster key.** The owner creates a new key in their Ticketmaster
  developer account, because it needs their sign-in. They keep it in their
  git-ignored `local.yml` and in the host's environment as
  `TICKETMASTER_API_KEY`, then revoke the committed key (owner). The old
  value stays in git history, which is why it is revoked.
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
| `/health`, the metadata document, `app.Public` paths | anonymous |
| every other path, with `auth.Service` registered | a signed-in user, meaning anyone who registered with the app's WorkOS environment. Sign-up is open (owner). |
| every path, without `auth.Service` | anonymous, as today. `NewApp` logs `auth: not registered, every route is public` once at startup. A connector cannot exist in this case (M14). |

**Ownership rule.** Anyone can sign up, so a valid token only says who the
caller is. Every app checks that each record it reads or writes belongs to
`Identity.Subject`. `pkg/auth` cannot enforce this. The rule goes into
`pkg/auth/CLAUDE.md`, `docs/BEST_PRACTICES.md` and the root `CLAUDE.md`.
thetraveler's design must test that one user cannot read another's trip.

`app.Public` matches the request path exactly: no prefixes, no patterns,
no case folding, no trailing slash. The query string is ignored.

**Claim checks**, all required:

- `iss` equals `auth_issuer`.
- `aud`, a string or an array, contains `auth_resource` as an exact string.
- `exp` is present and not passed.
- `nbf`, when present, is reached.
- `sub` is present and not empty.
- Provider `workos`: a token whose `sub_profile` is `ai_agent` is refused, as
  WorkOS's guide requires.

`exp` and `nbf` allow 30 s of clock skew. `none` and every symmetric
algorithm are refused, and a token in the query string is never read.

**Input at the edge.**

- The connector body is capped at 256 KiB.
- Tool arguments are checked against the schema inferred from `In`, with
  unknown fields refused, before the handler runs.
- Length and range limits are each handler's job (see "API contract").
- The key-set URL comes from config, never from a request.
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
signature check, and triggers no fetch beyond the bounds in "Scaling".
There is no per-caller rate limit (non-goal).

**DNS-rebinding check off.** The SDK refuses a request that arrives on a
loopback address with a non-loopback `Host`. It answered `403` to
`Host: thetraveler.example.com` in a throwaway test. That breaks a tunnel
or same-machine proxy in front of the app. The attack it stops needs a
local server that answers without credentials. Every connector requires a
bearer token (M14), which a rebinding page cannot obtain, so the check
adds nothing here.

**Secrets and personal data.**

- No secret is added.
- The committed Ticketmaster key is rotated (owner).
- Token claims live in memory for one request, and nothing is stored.
- Users' email addresses live at WorkOS (see "Switching off").

**Not checked.** Revocation: a revoked user's token works until it expires,
5 minutes by AuthKit's default.

**Other.** There is no inbound callback: OAuth redirects go to Claude and
to AuthKit, never to the app. The app never forwards a caller's token.

## Failure and rollback

| Failure | Behaviour |
|---|---|
| Key set unreachable, keys held | The held keys keep verifying. A refresh is tried again an hour after the last success. |
| Key set unreachable, no key held | Protected paths answer `503` to a request with a token, and `401` to one without. Public paths work. A fetch is tried at most once every 10 s. |
| Key set hangs | The fetch gives up at 5 s. Requests whose key is held are not held up. |
| Issuer rotates its keys | A token with an unknown `kid` triggers a fetch, at most once every 5 minutes. |
| AuthKit down for sign-in | Tokens already issued work until they expire. New sign-ins fail at AuthKit; the app does nothing. |
| A tool handler panics | The call returns `internal error`, the panic is logged, and the process keeps running. `pkg/mcp` recovers inside the tool wrapper. `Recover` (pkg/http/middleware.go:48) cannot: go-sdk v1.8.0 runs each request on its own goroutine (internal/jsonrpc2/conn.go:684), and a panic there ended the process in a throwaway test. A goroutine the handler starts itself is the app's to guard. |
| A tool handler runs past 10 s | `504` from the existing chain. The handler's context is done and its slot is held until it returns. |
| Slow handlers fill 32 slots | `503 connector busy` with `Retry-After: 1`. |
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
  `t.TempDir()` after `t.Chdir`. They call `Handler()` through `httptest`.
- Tokens are signed by `authtest`.
- Key-set tests (K) are in package `auth` and drive its clock.
- Log tests use a recording `logger.Logger`.

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
- A8. `alg: none`: `401`. HS256 signed with the public key's bytes: `401`.
  RS256 and ES256 tokens: `200`. A held `kid` with a signature from
  another key: `401`.
- A9. `sub` absent or empty: `401`. `sub_profile: ai_agent`: `401`.
- A10. A valid token in `?access_token=` and no header: A2's response.
- A11. With no token, all `200`: `/health`, `/health?x=1`, an `app.Public`
  path, and both metadata paths with the exact document. The test logs
  the document. With no token, all `401`: `/health/`, `/HEALTH`, a prefix
  of a public path, and `/x/../health`. `POST` to a metadata path: `405`
  problem.
- A12. Without a token, all `401`: an `app.Spec` route, a path-pair route,
  an unknown path, and a wrong method on a protected path. With a token
  these are `200`, `200`, `404` and `405`. An `OPTIONS` preflight to the
  connector without a token: `204`.
- A13. Startup panics, by message: empty `auth_issuer`, unknown
  `auth_provider`, and, with `ENV=PRODUCTION`, an `http://` value in
  `auth_issuer`, `auth_resource` or `auth_jwks_url`.
- A14. A `SetAuthMiddleware` hook with `auth.Service`: startup panic with
  its message.
- A15. No `auth.Service`: routes answer with no token, `FromContext`
  returns `false`, and the startup log line is written once.

**Key set** (package `auth`, test clock, `authtest` server)

- K1. No keys and the server down. A well-formed token: `503`, code
  `unavailable`. No header: `401`. 9 s later: `503` and no new fetch. 10 s
  later: one fetch. Server up, 10 s later: `200`.
- K2. Keys held, then the server goes down: tokens with held `kid`s get
  `200`, and the fetch count does not change.
- K3. Unknown `kid` while keys are held:
  - 20 concurrent requests make one fetch.
  - At 4 min 59 s: `401` and no fetch.
  - At 5 min: one fetch.
  - A rotated-in key then verifies with `200`.
- K4. At 59 min: no fetch. At 60 min: a verification answers `200` from the
  held keys without waiting, and starts one background fetch.
- K5. A server that never answers. A held-`kid` token answers within
  100 ms while the fetch is pending. The fetch gives up at 5 s. A request
  with no key held gets `503` within 6 s.
- K6. Each of these sets is refused, and the held keys keep verifying:
  - 17 usable keys
  - no usable key
  - a body of 64 KiB + 1 byte
  - status `500`
  - malformed JSON

  A 1,024-bit RSA key and a key whose `alg` does not match its type are
  ignored.
- K7. 100 goroutines verify while the set is swapped 50 times, under
  `-race`. Every held-`kid` verification succeeds.
- K8. A token with a wrong `iss` and an unknown `kid`: `401` and no fetch.

**Connector** (`pkg/mcp` with a recording logger; end to end in `app/` with
the SDK's client)

- M1. `initialize`, `ping`, then `tools/list`: each tool's name, title,
  description, annotations and input schema, exactly.
- M2. `tools/call` with valid arguments: the handler's output as
  `structuredContent`, and text equal to its JSON.
- M3. A missing field, a wrong type, an unknown field at the top and in a
  nested struct, and `arguments` absent: each gives `isError: true`, and a
  counter shows the handler did not run.
- M4. `mcp.Errorf("trip not found")`: that text. A 1,500-byte `Errorf`:
  its first 1,024 bytes. `errors.New` of a 2,000-byte message: text
  `internal error`, and the log holds the first 512 bytes.
- M5. `panic("x")`, `panic(errors.New("x"))` and `panic(nil)`: `isError:
  true`, `internal error`, and the next call succeeds. The log has the
  tool name and stack, and the value `x` does not appear. An index out of
  range: the runtime's message is logged.
- M6. An unknown tool: JSON-RPC error `-32602`. A body that is not JSON-RPC:
  `400`. `resources/list`: an empty list.
- M7. `GET` and `DELETE` with a valid token: `405` problem, code
  `method_not_allowed`.
- M8. Size limits:
  - A body of exactly 256 KiB is handled; 256 KiB + 1 byte gives `413`,
    both with `Content-Length` and chunked.
  - A result of exactly 256 KiB is returned; 1 byte more gives `isError:
    true`, `result too large`.
- M9. A handler that waits on its context, chained behind
  `pkghttp.TimeoutMW(100ms)`: `504` problem, code `timeout`. A counter shows
  the handler saw its context end and returned.
- M10. With 32 handlers blocked, a 33rd call gets `503`, code `unavailable`,
  detail `connector busy`, `Retry-After: 1`. Once one handler is released,
  the next call gets `200`.
- M11. Request headers:
  - No `Accept`: `400`.
  - `Content-Type: text/plain`: `415`.
  - `MCP-Protocol-Version: 1999-01-01`: `400`; `2025-11-25`: `200`.
  - `Host: thetraveler.example.com` over loopback: `200`.
  - `Origin: https://claude.ai`: `200`.
- M12. A raw `POST`: `200`, `application/json`, and no `Mcp-Session-Id` in
  the response.
- M13. Fifty concurrent `tools/call` under `-race`: fifty results.
- M14. Each registration mistake in "API contract" panics with its
  message, including `app.MCP` without `auth.NewService`.
- M15. End to end in `app/` with a tool set defined in the test. No token:
  A2's response on the connector path. A valid token: the handler returns
  the caller's subject.

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
- D3. The DSN:
  - Each of the six `sslmode` values: ends `?sslmode=<value>`.
  - Without the key: equal to today's string.
  - `require&x=y` and `bogus`: a panic with the message.
- D4. This repo's `config.yml` has an empty `ticketmaster.api_key`. With
  `TICKETMASTER_API_KEY` set, the map holds it.

**Logs**

- L1. A token, an `Authorization` header, a tool argument and a tool
  result each carry a marker string. They go through `RequestLogger`, the
  `pkg/auth` middleware and `pkg/mcp` with a recording logger, on
  success, a schema failure, a `401`, a handler error and a panic. No
  marker appears in any log line or error body.

**Compatibility**

- C1. The existing tests pass unchanged. An app with no `auth.Service` and
  no `app.MCP` entry answers `/health` and its routes with no token.
- C2. After each tag, recruiter is bumped to it, following its upstream
  flow (recruiter CLAUDE.md, "Where code lives"). Its CI builds and tests
  the bump commit.

**Benchmark**

- B1. `BenchmarkToolCall` runs a verified `tools/call` with RS256 and
  ES256 tokens. Its output is evidence, not a gate.

**Evidence a reviewer sees.**

- The test output naming every A, K, M, D, L and C test.
- The `401` response and the metadata document that A2 and A11 log.
- The `tools/list` response from M1.
- The output of B1.
- recruiter's green CI run on each bump.

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

1. **Fetch and cache policy in `pkg/auth`, keys parsed by jwkset** (picked).
   Every bound in "Scaling" is our code, under a test clock.
2. **keyfunc v3.9.2.** It gives the hourly refresh, the 5 s timeout and a
   rate limit on unknown `kid`s. It does not give the 10 s retry with no
   keys held, the 16-key refusal or a byte cap. Its timers run on the real
   clock, so K1, K3 and K4 would sleep for real.
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
merges, the merge commit is tagged and recruiter is bumped to the tag (C2).

- **§1 Deploy readiness**, tagged v0.4.0.
  - `app.ListenAddr`, the `env:` rule, and `postgres_sslmode`.
  - The `main.go` changes: the address and the tags.
  - `config.yml` without the Ticketmaster key.
  - `docs/BEST_PRACTICES.md` §4.
  - Tests D1–D4.
  - After it merges, the owner rotates the Ticketmaster key.
- **§2 Sign-in**, tagged v0.5.0.
  - `pkg/auth` and `pkg/auth/authtest`.
  - `Handler()`, `app.Public` and the metadata routes.
  - `pkghttp.HasAuthMiddleware` and `apierror.Unavailable`.
  - The named panic in `injectFields`.
  - jwt and jwkset.
  - The sign-in docs and the ownership rule.
  - Tests A1–A15, K1–K8 and C1.
- **§3 Connector**, tagged v0.6.0.
  - `pkg/mcp`, `app.MCP` and `apierror.TooLarge`.
  - The SDK.
  - The docs and the golden flow.
  - Tests M1–M15, L1 and B1.

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
- WorkOS AuthKit is the hosted service **(designer's call)**.
- One provider, named by a required `auth_provider`
  **(designer's call)**.
- Default deny, with exact-match public paths declared in `main.go`. An
  unknown path gets `401` without a token **(designer's call)**.
- `pkg/auth` and `SetAuthMiddleware` cannot both be set
  **(designer's call)**.
- The order of the sign-in checks. A request without a token never gets
  `503` **(designer's call)**.
- The `Bearer` scheme in any case, with exactly one `Authorization`
  header **(designer's call)**.
- `Identity` carries only `Subject` **(designer's call)**.
- `env:` is for string fields only **(designer's call)**.
- `postgres_sslmode` is optional and checked against libpq's six values
  **(designer's call)**.
- `app.ListenAddr` reads `HOST` and `PORT` **(designer's call)**.
- The connector is stateless with JSON responses, tools only, and one
  endpoint per app **(designer's call)**.
- Protocol errors keep the SDK's bodies. Only the framework's own `401`,
  `413`, `503` and `504` are problems **(designer's call)**.
- Argument errors are tool errors and an unknown tool is a protocol
  error, as the MCP specification's tool error handling says
  **(designer's call)**.
- The bounds: 256 KiB body and result, 32 calls in flight, 64 tools,
  1 KiB `Errorf`, 8 KiB token, 64 KiB key set, 16 keys, 30 s skew, and the
  fetch limits **(designer's call)**.
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
- How `app.MCP` and `app.Public` entries are represented between the
  routes slice and `NewApp`.
- Log field names beyond the five listed under "Security".
- How the 32-slot limit is built, given that a slot is taken before the
  body is read and released when the handler returns.
- The wording of the new `CLAUDE.md` files and doc sections.
- The shape of B1.

## Design review

Panel: BLD, GOAL, QLT, SCL, INF, SEC, FUN. Why: full design with no screen.

Round 1:
- BLD-1 Reference order tools have no inputs, outputs, annotations or service mapping
- BLD-2 No clock seam in the public signature, yet A3 and A11 depend on one
- BLD-3 405 for GET/DELETE on the connector: SDK body or router problem
- BLD-4 Order of checks among 401 and 503 is open
- BLD-5 `env:` rule silent on non-string fields and where the override is applied
- GOAL-1 Goal 7 and the 'existing consumer' anti-goal contradict the env: rule: owner: accepted as a deliberate change; Claude checked recruiter, which has no env: tags
- GOAL-2 An app can serve MCP with no sign-in and still meet every goal: owner: an app with a connector and no sign-in does not start
- GOAL-3 Success line does not check the problem: Claude accepting the connector: owner: tests against the documented requirements now; the first real connection is thetraveler's acceptance
- GOAL-4 No-card and no-paid-resource constraints rest on an unanswered question: owner: the owner checks at WorkOS sign-up; a card means switching provider before code
- GOAL-5 Identity.Scopes and Identity.Claims serve no goal
- GOAL-6 Order tools in the production app go beyond what the Why needs: owner: this repo's app serves no tools; a test fixture proves the pattern
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
- INF-3 WorkOS free-tier limits and card requirement unstated, against an owner decision of no card: owner: the owner checks at WorkOS sign-up; a card means switching provider before code
- INF-4 Pay-per-use WorkOS MAU has no cap, alert or owner opt-in: owner: sign-up stays open, with no gate and no spend cap
- INF-5 Switching off leaves the WorkOS environment and its settings in place
- INF-6 keyfunc/jwkset adds two modules for fetching a key set under custom bounds
- SEC-1 Any self-registered AuthKit user passes as the 'signed-in user': owner: sign-up is open; each app checks ownership by subject
- SEC-2 Reference /mcp order tools are anonymous, with no stated owner check on get_order: owner: this repo's app serves no tools
- SEC-3 A production deploy with no auth.Service silently serves every route anonymously: owner: an app with a connector and no sign-in does not start
- SEC-4 No transport check on auth_issuer and auth_jwks_url in production
- SEC-5 What a logged handler error or panic may contain is not bounded
- SEC-6 A committed, real-looking API key stays in config.yml for a public deployment: owner: the key is rotated; the owner creates a new key before the old one is revoked
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
