# simplegoapp — Best Practices & Patterns

simplegoapp is a lightweight dependency-injection framework for building Go web
applications. It uses reflection to wire constructor-based services together at
startup, injects those services into HTTP controllers, and provides thin,
interface-driven wrappers around common infrastructure (Postgres, Mongo,
logging, outbound HTTP, websockets, SMS).

This document captures the conventions established in this repository. Follow
them when adding new services, controllers, or integrations so the DI container
can wire everything automatically.

---

## 1. Project Layout

```
.
├── main.go                    # Composition root: config struct, routes, service list, models
├── config.yml                 # Production config (local.yml used outside PRODUCTION)
├── app/
│   ├── app.go                 # Framework core: DI container, config loading, server lifecycle
│   ├── router.go              # Route registration, controller injection, health check
│   └── controller/<name>/     # HTTP controllers, one package per resource
├── domain/<name>/             # Business-logic services (application-specific)
└── pkg/<name>/                # Infrastructure & integration services (reusable)
    ├── logger/                # zap-backed structured logger
    ├── http/                  # Controller base type, outbound HTTP helpers, websockets
    ├── postgres/              # gorm-backed Postgres service + migrations
    ├── mongo/                 # Mongo service
    ├── twilio/                # SMS integration
    └── ticketmaster/          # Example third-party REST API client
```

**Rules of thumb**

- `pkg/` holds services that could be reused by any app: databases, loggers,
  third-party API clients. They must not import from `domain/` or `app/`.
- `domain/` holds business logic. Domain services may depend on `pkg/` services
  and on each other.
- `app/controller/` holds HTTP handlers only. Controllers call domain services;
  they should not contain business logic themselves.
- `main.go` is the single composition root — the only place where the full
  dependency graph, routes, config shape, and DB models are declared.

---

## 2. The Service Pattern

Every injectable unit follows the same four-part shape (see
[domain/example/service.go](../domain/example/service.go),
[pkg/postgres/service.go](../pkg/postgres/service.go)):

```go
package example

// 1. An exported interface describing the public surface
type Service interface {
    Hello()
    Bye()
}

// 2. An unexported struct implementing it
type service struct {
    logger logger.Logger
}

// 3. Methods on the struct (receiver named `this` by convention)
func (this service) Hello() { ... }

// 4. A constructor whose parameters ARE the dependency declaration
func NewService(
    logger logger.Logger,
) Service {
    return &service{
        logger: logger,
    }
}
```

**Conventions**

- The primary file in each service package is named `service.go`.
- The interface is always named `Service`; the implementation is always the
  unexported `service`. Callers refer to it as `example.Service`,
  `postgres.Service`, etc. — the package name provides the context.
- `NewService` returns the **interface**, never the concrete struct. The DI
  container keys singletons by the returned interface type, and consumers
  depend only on interfaces, which keeps services mockable.
- Dependencies are declared exclusively as `NewService` parameters. Never reach
  for globals or construct a dependency inside a service.
- The method receiver is named `this` throughout the codebase.
- Struct fields group framework deps (logger) first, then service deps,
  separated by a blank line (see
  [domain/example2/service.go](../domain/example2/service.go)).

### Services depending on other services

Just add the other service's interface as a constructor parameter. The
container resolves ordering automatically:

```go
func NewService(
    logger logger.Logger,
    exampleService example.Service,
) Service {
    return &service{
        logger:  logger,
        example: exampleService,
    }
}
```

---

## 3. How Dependency Injection Works

Wiring happens once, at startup, in `app.NewApp`
([app/app.go](../app/app.go)), which delegates to the resolver in
[app/resolver.go](../app/resolver.go):

1. Every entry in the `serviceFuncs` slice passed to `NewApp` is a constructor
   function (e.g. `postgres.NewService`, `example.NewService`). A constructor
   must be a non-variadic function returning exactly one interface (or
   pointer); anything else fails startup with an error naming the offender.
2. The resolver reflects over each constructor exactly once and records what it
   *provides* (its return type) and what it *requires* (its parameter types):
   - `logger.Logger` → the shared logger singleton (always available; you never
     register it).
   - `map[string]interface{}` → the flattened config map (see §4).
   - anything else → must be provided by another registered constructor.

   Registering a constructor that returns a framework-provided type
   (`logger.Logger`, the config map) fails startup with an error — builtins
   cannot be overridden.
3. The dependency graph is resolved with a topological sort (Kahn's
   algorithm), so **registration order never affects correctness** — a service
   is always built after its dependencies. Among services whose dependencies
   are equally satisfied, initialization runs in **registration order**, making
   startup fully deterministic run to run.
4. Failures are diagnosed before any service is built, each with a precise
   message:
   - a parameter type nobody provides →
     `"func(...) example2.Service requires example.Service, but no constructor provides it"`
   - a dependency cycle → `"dependency cycle among: ..."` naming the members
   - an invalid constructor → an error naming the function and the rule it
     breaks.
5. Registering two constructors that provide the same type is allowed: the
   **last registered wins** and the overridden constructor is never called.
   Use this to swap in fakes or alternates by appending them after the
   defaults.

Every service is a **singleton**: one instance per process, shared by all
controllers and other services. `postgres.NewService` must always be
registered — `NewApp` panics with a named message otherwise, since migrations
depend on it.

**Registering a new service** is one line in `main.go`:

```go
app := app.NewApp(
    "localhost",
    8080,
    routes,
    []interface{}{
        postgres.NewService,
        twilio.NewService,
        mynewthing.NewService,   // ← just add the constructor
    },
    models,
    &config,
)
```

---

## 4. Configuration Pattern

Config is declared as a struct in `main.go` with three tags per leaf field:

```go
type config struct {
    Twilio struct {
        PhoneNumber string `yaml:"phone_number" config:"twilio_number" env:"TWILIO_PHONE_NUMBER"`
    } `yaml:"twilio"`
    Postgres struct {
        User     string `yaml:"user" config:"postgres_user"`
        Password string `yaml:"password" config:"postgres_password"`
        ...
    } `yaml:"postgres"`
}
```

- `yaml:` — where the value lives in the YAML file. The file is `config.yml`
  when `ENV=PRODUCTION`, otherwise `local.yml`.
- `config:` — the flat key under which the value is exposed to services. The
  whole struct is flattened into a single `map[string]interface{}`.
- `env:` (optional) — additionally exports the value as an OS environment
  variable, for third-party SDKs that read from the environment (e.g. the
  Twilio client).

**Consuming config in a service**: take `config map[string]interface{}` as a
constructor parameter and pull namespaced keys out with a type assertion:

```go
func NewService(config map[string]interface{}) Service {
    return &service{
        apiKey:  config["ticketmaster_api_key"].(string),
        baseUrl: config["ticketmaster_base_url"].(string),
    }
}
```

**Conventions**

- Prefix `config:` keys with the service name (`postgres_user`,
  `ticketmaster_api_key`) so keys stay unique in the flat map.
- Config keys are two-level: a top-level section per service, leaf string
  fields inside. Values are treated as strings.
- Document required config keys in a comment above `NewService` (see
  [pkg/twilio/service.go](../pkg/twilio/service.go)).

---

## 5. Controller Pattern

Controllers live in `app/controller/<resource>/controller.go` and follow a
convention-over-configuration model
([app/controller/example/controller.go](../app/controller/example/controller.go)):

```go
type ExampleController struct {
    http.Controller              // embed the framework base — always first

    ExampleService example.Service  // exported fields are injected by type
}

func (this ExampleController) GET(w http.ResponseWriter, req *http.Request) { ... }
func (this ExampleController) POST(w http.ResponseWriter, req *http.Request) { ... }
```

**How it works**

- Embed `http.Controller` (from `pkg/http`). It carries the logger and provides
  request/response helpers.
- Declare service dependencies as **exported struct fields typed as the service
  interface**. The router injects the matching singleton into each field at
  startup ([app/router.go](../app/router.go)).
- Handler methods are named after the HTTP verb they serve: `GET`, `POST`,
  `PUT`, `DELETE`. The router registers one route per verb method it finds. A
  controller with no verb (or `SOCKET`) method panics at startup.
- Routes are declared in `main.go` as a flat alternating list:

  ```go
  routes := []interface{}{
      "/hello",     &controller.ExampleController{},
      "/v1/socket", &controller.SocketController{},
  }
  ```

  Always pass a **pointer** to the controller so fields can be injected.
- A `/health` route returning 200 is registered automatically.

**Request handling helpers** (all on the embedded `http.Controller`, all with
built-in error logging):

| Helper | Use |
|---|---|
| `this.ParseParams(req, &obj)` | Decode query params into a tagged struct |
| `this.ParseBody(req, &obj)` | Decode a JSON body into a tagged struct |
| `this.Respond(w, obj)` | Marshal `obj` as JSON, set content-type and CORS headers |
| `this.InternalError(w, err)` | 500 + `{"error": "..."}` body |

Request and response shapes are defined as structs with `json:` tags —
anonymous structs inline in the handler for one-off shapes, named structs when
reused.

### Websocket controllers

Name the handler `SOCKET` and use the upgrade/read/write helpers:

```go
func (this SocketController) SOCKET(w http.ResponseWriter, req *http.Request) {
    conn, out, err := this.Upgrade(w, req)   // upgrades + starts writer goroutine
    if err != nil {
        return
    }
    defer conn.Close()
    defer close(out)

    for {
        msg, err := this.ReadSocket(conn)    // expected-close errors are not logged
        if err != nil {
            break
        }
        this.SendMessage(out, response{...}) // marshals to JSON, sends on out channel
    }
}
```

Writes always go through the `out` channel (never write to the conn directly) —
a dedicated goroutine owns the write side.

---

## 6. Wrapping Third-Party Libraries

A core principle of the repo: **application code never imports third-party
packages directly**. Every external dependency is hidden behind a `pkg/`
service with a `Service` interface:

- `gorm` → `pkg/postgres` — generic `Find` / `Insert` / `GetOrCreate` /
  `RunMigrations` methods so callers never see `*gorm.DB`.
- `zap` → `pkg/logger` — a four-method `Logger` interface
  (`Info`/`Warn`/`Error`/`Fatal`) over the sugared logger.
- `net/http`, `gorilla/websocket`, `gorilla/schema` → `pkg/http`.
- `twilio-go` → `pkg/twilio` — a single `SendSMS(phoneNumber, body string)`.

When leaking a third-party type is unavoidable, re-export it with a **type
alias** so consumers still only import the wrapper package:

```go
// pkg/http/http.go
type (
    ResponseWriter = http.ResponseWriter
    Request        = http.Request
)

// pkg/mongo/service.go
type D = bson.D
type M = bson.M
type ObjectID = primitive.ObjectID
```

This keeps swap-ability real: replacing zap or gorm touches one package.

### External REST API clients

[pkg/ticketmaster](../pkg/ticketmaster/service.go) is the template for
integrating a third-party HTTP API:

- `service.go` — the `Service` interface, config-driven constructor (API key,
  base URL from config), and endpoint methods.
- One file per endpoint (e.g. `find_events.go`) holding the request query
  struct (`FindEventsQuery`) and the fully-typed response struct
  (`FindEventsResponse`) with `json:` tags mirroring the provider's payload.
- Outbound calls go through the package-level helpers in `pkg/http`
  (`http.GET(url, params, &resp)`, `http.POST(url, body, &resp)`), which share
  a single `http.Client` with a 10-second timeout and handle query encoding
  (including slices) and JSON decoding.

---

## 7. Database Patterns

### Postgres (primary store)

- Models are plain structs with `gorm:` tags, declared in `main.go` and passed
  to `NewApp`:

  ```go
  type SampleModel struct {
      Id   string `gorm:"type:uuid;primaryKey"`
      Name string `gorm:"type:varchar(100);index"`
  }

  models := []interface{}{&SampleModel{}}
  ```

- `NewApp` runs `AutoMigrate` on all registered models at startup, before the
  server starts. Migration failure is fatal.
- Postgres is a first-class citizen: the `App` struct holds `postgres.Service`
  directly, so it is effectively required. Comment it out of the service list
  only if you also remove models/migrations.
- Data access goes through the `postgres.Service` interface: `Find(model, conds...)`
  for filtered multi-row selects, `Insert`, `Upsert(objects, conflictColumns...)`
  for bulk insert-or-update, `GetOrCreate`, and `Transaction(fn)` — the callback
  receives a transaction-bound `Service`; use it (not the outer service) for
  every call inside the transaction. Add new query methods to the interface
  rather than exposing gorm.

### Mongo (optional)

`pkg/mongo` follows the same shape with a `context.Context` first parameter on
every method — collection-name-first methods (`Find(ctx, collection, filter,
result)`), `BulkUpsert(ctx, collection, filters, updates)` for insert-or-update
of many documents in one write, and `Transaction(ctx, fn)` — the callback
receives a transaction-bound `Service`; use it (not the outer service) for
every call inside the transaction (requires mongo running as a replica set; do
not nest). Guard rails: `Find` and `BulkUpsert` (per-filter) reject nil and
empty filters with `ErrNoFilter` — `Update` and `FindOneAndUpdate` do not, so
an empty filter there matches every document. `Insert` accepts either a single
document or a slice.

---

## 8. Error Handling & Logging Conventions

- **Startup errors are fatal**: config load/parse failures, DB connection
  failures, invalid controllers, and unresolvable dependencies all `panic` or
  `logger.Fatal`. The app should never come up half-wired.
- **Request-time errors are returned**, logged where they occur, and surfaced
  to clients via `this.InternalError(w, err)`.
- Logging is structured key-value throughout, via the injected `logger.Logger`:

  ```go
  this.logger.Error(
      "connecting to postgres",   // message: lowercase phrase describing the action
      "error", err,               // alternating key, value pairs
  )
  ```

  The message describes what was being attempted ("parsing query params",
  "running migration"), and context (err, path, params) goes in the key-value
  pairs — never `fmt.Sprintf` into the message.
- Services log their own failures at the point of error *and* return the error
  to the caller.

---

## 9. Checklist: Adding a New Feature

**A new domain service**

1. Create `domain/<name>/service.go`.
2. Define `Service` interface, unexported `service` struct, `NewService`
   constructor taking `logger.Logger` plus any service interfaces / config map
   it needs, returning `Service`.
3. Register `<name>.NewService` in the service slice in `main.go`.

**A new controller/route**

1. Create `app/controller/<name>/controller.go`.
2. Define a struct embedding `http.Controller` with exported service-interface
   fields.
3. Add verb-named methods (`GET`, `POST`, ...) or `SOCKET`.
4. Add `"/path", &controller.MyController{}` to `routes` in `main.go`.

**A new third-party integration**

1. Create `pkg/<name>/service.go` following the ticketmaster/twilio template.
2. Expose a minimal `Service` interface; keep the vendor SDK types internal
   (alias any that must leak).
3. Add a config section + `config:`-tagged fields to the config struct in
   `main.go` and values to `config.yml` / `local.yml`.
4. Register the constructor in `main.go`.

**New config values**

1. Add the field to the config struct in `main.go` with `yaml:` and `config:`
   tags (and `env:` if an SDK needs an env var).
2. Add the value to `config.yml` (and `local.yml` for local dev).
3. Read it in the service constructor via `config["<key>"].(string)`.
