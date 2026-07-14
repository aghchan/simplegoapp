# pkg/mongo — mongo-driver wrapper

## Expected flow

Inject `mongo.Service`; ctx is the first param on every method. Driver types
stay internal — bson aliases (`M`, `D`, `A`, `E`, `ObjectID`) are re-exported
here so callers never import the driver.

## Contracts

- `Find`/`BulkUpsert` reject nil and empty map/slice filters with
  `ErrNoFilter`; `Update`/`FindOneAndUpdate` do NOT (empty filter matches
  everything — deliberate, documented).
- `Insert` accepts one document or a slice; non-ObjectID user-supplied `_id`s
  leave zero slots in the returned ids.
- `Transaction(ctx, fn)` — use fn's session-bound Service inside; requires a
  replica set; nesting returns `ErrNestedTransaction`; fn may run more than
  once on transient errors (must be idempotent).

## Tests

Integration tests self-skip unless a single-node replica set runs on :27018
(skip message contains the docker run + rs.initiate commands).
