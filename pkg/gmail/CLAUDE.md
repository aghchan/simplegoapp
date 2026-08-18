# pkg/gmail — Gmail REST wrapper

Message-granular by design: Gmail labels are per-message (new messages in a
labeled thread do NOT inherit the label), so consumers must check
`Message.LabelIds` client-side; query-string `-label:` exclusion is only a
prefilter.

## Contracts

- `Search` pages internally (cap 10 pages) and returns message refs, not
  threads.
- `Body` is the first `text/plain` part; `HTMLBody` is the first `text/html`
  part. Either may be empty — HTML-only mail has no `Body` at all — and on
  multipart mail they may disagree, since a sender controls each
  independently. A caller that decides using one while showing the human the
  other is comparing different documents.
- `SelfAddress` exposes the authenticated account's address (the same cached
  `users.getProfile` lookup the sends use), so callers can recognise the
  user's own mail.
- `SendToSelf` and `SendHTMLToSelf` are the ONLY sends: both address the
  authenticated account only (cached from users.getProfile), and share
  `headerSafe` to truncate subject at the first CR/LF so caller text cannot
  mint extra RFC 822 headers. A third-party recipient is unrepresentable.
  Do not add a general Send.
- `EnsureLabel` is create-or-get by exact name, list-then-create, and
  conflict-tolerant: the loser of a create race re-lists and adopts the
  winner's label instead of erroring (logged so races are visible). Use hyphenated names
  (`recruiter-processed`) — slash-nested names translate undocumentedly in
  search syntax.
- `Authorize` is setup-only (interactive consent, loopback redirect with a
  per-run random state, token written 0600). The service constructor fails
  with instructions when the token cache is missing.
- Terminal auth death surfaces as ErrAuthExpired — the only error consumers
  must branch on.

## Setup prerequisite

The OAuth consent screen MUST be published to "In production": Testing-status
refresh tokens expire every 7 days. Unverified-in-production is fine for a
single personal user. `invalid_grant` at runtime means the token is dead —
re-run Authorize.

## Tests

`service_test.go` runs against a fake Gmail HTTP server via the
`gmail_base_url` config seam (paths under `/gmail/v1/...`) — they lock in our
request shapes and parsing, not Google's behavior.
