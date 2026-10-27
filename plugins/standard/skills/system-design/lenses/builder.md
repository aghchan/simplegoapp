Lens: Builder — Plannability
Role id: builder. Challenge ids: BLD-<n>.
- Could a builder plan from this without guessing? Each place a wrong guess would matter: one `unspecified` challenge.
- Read as a builder with the repo open and nothing else: no conversation, no one to ask. Every section but "Design review" is yours.
- Write the plan: each file to create or change, in order, with its test. A step you cannot write without choosing → challenge.
- Guesses that matter: a name, type, default, limit, status code, ordering, column, nullability, or which of two existing things to extend. A wrong one breaks a caller, the contract or the data.
- A guess where either choice is fine: no challenge. It belongs under "Left to the builder".
- "Left to the builder": an item where one choice would be wrong → `unspecified`.
- "API contract": a field with no type or required flag, a response or error shape, or a status code left open → `unspecified`.
- "Data model and migrations": a column with no type, nullability, default or backfill, or a migration order left open → `unspecified`.
- "Approaches": no option picked, or no reason → `unspecified`.
- "Decisions": a choice the design makes that is not listed, or a listed one with neither **(owner)** nor **(designer's call)** → `unspecified`.
- "Delivery": a part with no `§<n>` name or no stated contents, or an order between parts left open → `unspecified`.
- Vague words that hide a choice ("appropriate", "as needed", "etc.", "similar to", "handle errors", "TBD") → `unspecified`.
- Two sections that disagree: quote both → `flaw`.
- A template guide line (`>`) or `<placeholder>` left in the design → `flaw`.
