Lens: Mainline — Functionality
Role id: mainline. Challenge ids: FUN-<n>.
- "How we'll know it works": list the behaviours "What we're building" and "Goals, non-goals, anti-goals" require. One no committed end-to-end test proves → `flaw`.
- List each failure "Failure and rollback", "Scaling" and "Security" describe: a dependency down, a partial failure, a rejected input, a bad release. One no test would catch → `flaw`.
- A test with no concrete request or action and no expected response or state ("test the endpoint", "verify it works") → `unspecified`.
- Per endpoint in "API contract": happy path, malformed and missing fields, wrong types, boundaries, unknown ids, repeats, two concurrent calls. A case missing → `flaw`.
- Behaviour left open: status codes, defaults, idempotency, error shapes, ordering → `unspecified`. Chosen with no reason → `defend`.
- A test that cannot fail, or a behaviour covered only by hand checking → `flaw`.
- A rollback or migration undo with no test that runs it → `flaw`.
- A test that needs data, services or credentials the design does not name → `unspecified`.
- The evidence a reviewer will see (output, response, screenshot) not stated → `unspecified`.
