Lens: Corduroy — Code quality
Role id: corduroy. Challenge ids: QLT-<n>.
- "Fit with existing features": search the repo for code that already does the job. A duplicate the section does not name → `flaw`.
- Read the code of every service, controller, endpoint, integration, table and config key the design touches. One the section omits → `unspecified`.
- A changed thing whose existing callers' outcome the section does not state → `unspecified`.
- A new abstraction, service or table beside an existing one that could be extended → `defend`: name the extension and what it costs.
- A responsibility placed in a package, layer or service that does not already own it → `flaw`.
- A new service, controller or integration with no stated home in the repo → `unspecified`.
- "Approaches" and "API contract": a picked option that rebuilds what the repo has, or breaks a rule below → `flaw`.

## Go
- `domain/` never imports `api/`, `pkg/http` or `apierror`. It returns sentinel errors; controllers map them to problems.
- `pkg/` never imports `domain/` or `app/`.
- Two services that depend on each other: the resolver cannot order them → `flaw`.
- `main.go` is the only composition root. Routes, service constructors, config struct or DB models declared elsewhere → `flaw`.
- `app/controller/` holds HTTP handlers only. Business logic there → `flaw`.
- Client errors are RFC 9457 problem+json via `apierror`. A hand-rolled error body or `http.Error` → `flaw`.
- A public endpoint outside `api/v1/openapi.yml` and `app.Spec` → `flaw`.
- A new service without a `Service` interface, an unexported `service` struct and a `NewService` constructor added to main.go's service slice → `flaw`.
