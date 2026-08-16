# pkg/gmail — Gmail REST wrapper

Message-granular by design: Gmail labels are per-message (new messages in a
labeled thread do NOT inherit the label), so consumers must check
`Message.LabelIds` client-side; query-string `-label:` exclusion is only a
prefilter.

## Contracts

- `Search` pages internally (cap 10 pages) and returns message refs, not
  threads.
- `Message` extracts the first text/plain MIME part; HTML-only mail yields an
  empty body — headers still carry the signal.
- `SendToSelf` is the ONLY send: it addresses the authenticated account
  (cached from users.getProfile), and `headerSafe` truncates subject at the
  first CR/LF so caller text cannot mint extra RFC 822 headers. A third-party
  recipient is unrepresentable. Do not add a general Send.
- `EnsureLabel` is create-or-get by exact name, list-then-create (not
  concurrency-safe; the intended caller is a single sequential process). Use
  hyphenated names (`recruiter-processed`) — slash-nested names translate
  undocumentedly in search syntax.
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
