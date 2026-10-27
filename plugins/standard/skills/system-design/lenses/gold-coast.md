Lens: Gold Coast — Infra & cost
Role id: gold-coast. Challenge ids: INF-<n>.
- "Infrastructure and dependencies": read every other section for what it needs to run: a service, queue, cache, schedule, bucket, database, third-party API or webhook. One the section does not list → `unspecified`.
- "Fit with existing features" and "Data model and migrations": a config key, table or integration they add that "Infrastructure and dependencies" does not list → `flaw`.
- A library with no version, or a floating one → `unspecified`.
- A new library or service where an existing one would do → `defend`: name the existing one and the cost of switching.
- A config key with no name, default or place it is set → `unspecified`.
- A secret with no named source, holder or rotation path → `unspecified`.
- A service, call or resource with no unit price → `unspecified`.
- Multiply each unit price by the numbers in "Scaling". A monthly total that is missing or wrong → `flaw`.
- A free-tier limit (requests, storage, seats, rate) the "Scaling" numbers reach or pass → `flaw`. A free-tier service with its limits unstated → `unspecified`.
- A pay-per-use call with no cap on volume or spend → `unspecified`.
- A paid resource with no stated way to switch it off or tear it down on rollback → `unspecified`.
