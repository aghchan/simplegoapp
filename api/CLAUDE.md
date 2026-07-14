# api/ — OpenAPI contracts (source of truth)

## Expected flow

1. Edit `v1/openapi.yml` (contract-first: reviewable before code exists).
2. `make api` regenerates `v1/gen.go` (committed; CI fails on drift via
   `make check-api`).
3. Implement the new `ServerInterface` methods — missing ones are compile
   errors.

## Rules

- cfg.yml must stay `gorilla-server` + `models` STANDARD mode. Never enable
  `strict-server`: it hardcodes encoding/json in generated code and kills the
  framework's codec negotiation.
- Generated code binds params only — it does NOT validate schema constraints
  (`minimum`, `maximum` are documentation). Controllers enforce them (see the
  limit clamp in app/controller/orders/).
- Breaking changes: new `v2/` directory beside `v1/`; published versions are
  immutable.
- `/health` and websocket routes are deliberately out-of-contract.
