# pkg/postgres — gorm wrapper

## Expected flow

Inject `postgres.Service`; never expose or import gorm outside this package
(add methods to the interface instead). Models declared in main.go are
AutoMigrated at startup (failure is fatal).

## Contracts

- `Find(model, conds...)` — variadic gorm condition forms (SQL+args, struct,
  map, PK values).
- `Upsert(objects, conflictColumns...)` — structs only (not maps); default
  conflict target is the primary key; UpdateAll clobbers zero-value fields.
- `Transaction(fn)` — use fn's tx-bound Service for every call inside;
  nested calls become savepoints (mongo forbids nesting — asymmetry is
  documented).

## Tests

Integration tests self-skip unless Postgres runs on :5434 (the skip message
contains the docker run command; dedicated `simplegoapp_test` database).
