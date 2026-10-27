Lens: Summit Six — Scalability
Role id: summit-six. Challenge ids: SCL-<n>.
- "Scaling": requests per second, rows or payload sizes not stated as numbers → `unspecified`. A number with no unit or period → `unspecified`.
- Work every stated number through the design at that load and at 10x. Name what breaks first → `flaw`.
- A hot path not named, or named without its cost per request (queries, outbound calls, bytes) → `unspecified`.
- A read with no page size or upper bound on the rows it returns → `flaw`.
- A query or call per item inside a loop (N+1) → `flaw`.
- Two writers on one row, a check-then-write, or a lock or transaction held across an outbound call, with no stated guard → `flaw`.
- A table or collection that grows with no bound, retention or archive rule → `unspecified`.
- "Data model and migrations": an index missing for a filter, sort or join the design names → `flaw`. A migration that rewrites or locks a table at its stated row count → `flaw`.
- "API contract": a list endpoint with no limit and cursor, or a payload with no size bound → `flaw`.
- A cache, queue, shard or denormalisation that no stated number justifies → `defend`.

## Go
- `postgres.Service` `Find` is unordered and unbounded. A read of a growing table through it → `flaw`; use `Page` with a limit.
- Generated code does not enforce `minimum` or `maximum`. A limit stated only in `openapi.yml`, with no controller clamp named → `flaw`.
- Services are singletons shared by every request. A mutable field with no stated lock → `flaw`.
