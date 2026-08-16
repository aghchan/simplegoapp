# pkg/linear — Linear GraphQL wrapper

This package is the only place that knows Linear's schema; consumers see
`linear.Service` (issue CRUD, comments, workflow-state lookup) and
`linear.Admin` (one-time workspace setup — kept separate so a running app
cannot reshape the workspace it reads from).

## Contracts

- `IssuePatch` applies only its non-nil fields; an entirely empty patch skips
  the mutation and just re-reads.
- `Issues` is Relay-paginated (`first`/`after`). `NextCursor` is empty when
  `hasNextPage` is false — never return `endCursor` on the last page or paging
  will not terminate.
- State is addressed by **name**, not id: `stateId` resolves against the
  team's workflow states and caches the map for the process lifetime. A
  missing state returns `ErrUnorganized` naming it — a setup problem, not a
  runtime failure.
- Dates: Linear's `dueDate` is a TimelessDate (`2006-01-02`), not RFC3339.
  `createdAt`/`updatedAt` are RFC3339. Do not conflate them.
- `Teams` is the only call that works without a configured team id — that is
  what makes it usable for discovering one during setup.
- `Attachments`/`AttachURL` — thread⇄issue links; `attachmentCreate` is
  idempotent per (issue, url). `Comments` returns the newest 50, newest
  first — sized for marker checks, not history export.
- AttachmentsForURL is the reverse thread→issue lookup; Attachment carries
  IssueId.

## Pitfalls

- Linear reports application errors in a **200** body under `errors`; checking
  the status code alone silently swallows failures.
- Missing entities come back two ways — a null node and an "Entity not found"
  GraphQL error. Both map to `ErrNotFound`.
- Personal API keys go in `Authorization` **unprefixed**; only OAuth tokens
  use `Bearer`. This package assumes a personal API key.
- 429 maps to `ErrRateLimited` so callers can back off rather than retry
  blindly.
- Linear rewrites description markdown on save (URLs become `[url](<url>)`),
  so read-modify-write flows must match the linkified form.

## Tests

`service_test.go` runs against a fake GraphQL server, so it locks in *our*
request shapes and error handling — not Linear's real schema.
