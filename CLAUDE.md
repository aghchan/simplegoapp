# simplegoapp

Go DI framework + template for spec-first JSON APIs. Full conventions:
docs/BEST_PRACTICES.md. Design specs: docs/superpowers/specs/.

## Commands

- `make api` — regenerate api/v1/gen.go from openapi.yml (required after any spec edit)
- `make check-api` — fail on codegen drift (CI runs this)
- `go test ./... -count=1` — datastore integration tests self-skip without their
  Docker containers (start commands are printed in the skip messages)

## The two golden flows

- **New public endpoint:** edit `api/v1/openapi.yml` → `make api` → implement
  the generated `ServerInterface` on a controller → register with `app.Spec`
  in main.go. Never hand-register public routes. See api/CLAUDE.md.
- **New service:** `Service` interface + unexported `service` struct +
  `NewService` constructor whose params declare its dependencies → add the
  constructor to the service slice in main.go. See domain/CLAUDE.md.

## Conventions that differ from defaults

- Method receivers are named `this` everywhere.
- Comments only for constraints code can't show; terse.
- Errors to clients are always RFC 9457 problem+json via `apierror` — never
  hand-rolled JSON or `http.Error`.
- main.go is the only composition root: routes, service constructors, config
  struct, DB models all declared there.
