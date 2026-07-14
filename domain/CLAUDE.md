# domain/ — business-logic services

## Expected flow

One package per domain concept: `Service` interface + unexported `service`
struct + `NewService(deps...) Service`. Register the constructor in main.go's
service slice; the DI container wires it by parameter types (other Service
interfaces, `logger.Logger`, the config map).

## Rules

- Transport-agnostic: never import `api/`, `pkg/http`, or `apierror`. Return
  domain sentinel errors (e.g. `orders.ErrNotFound`); controllers map them to
  problems.
- Domain services own invariants that must hold for EVERY caller; contract
  shape validation (required fields, ranges) lives at the controller edge.
- Data access goes through the injected `postgres.Service`/`mongo.Service`
  interfaces; the reference `orders` uses an in-memory store only because it
  is a demo.
