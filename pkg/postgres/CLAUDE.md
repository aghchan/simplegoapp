# pkg/postgres — gorm wrapper

## Expected flow

Inject `postgres.Service`; never expose or import gorm outside this package
(add methods to the interface instead). Models declared in main.go are
AutoMigrated at startup (failure is fatal).

## Contracts

- `Find(model, conds...)` — variadic gorm condition forms (SQL+args, struct,
  map, PK values). Unordered and unbounded.
- `First(model, conds...)` — single row; returns `postgres.ErrNotFound` (a
  re-export of gorm's, so callers never import gorm) when nothing matches.
- `Page(models, order, limit, conds...)` — ordered, bounded read. `order` is
  interpolated into ORDER BY, so it must be a caller-owned literal, never a
  value derived from a request.
- `Insert(objects)` / `Upsert(objects, conflictColumns...)` — structs only (not
  maps); default conflict target is the primary key; UpdateAll clobbers
  zero-value fields. Upsert bumps `updated_at` in the database without
  refreshing the passed struct — re-read if you return it to a client.
- `Delete(model, conds...)` — gorm refuses an unscoped delete, so pass a
  condition.
- `Transaction(fn)` — use fn's tx-bound Service for every call inside; nested
  calls become savepoints (mongo forbids nesting — asymmetry is documented).

## Tests

Integration tests self-skip unless Postgres runs on :5434 (the skip message
contains the docker run command; dedicated `simplegoapp_test` database).
