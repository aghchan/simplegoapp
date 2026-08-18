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

- **Body data is base64url and the padding is not optional to handle.** Gmail
  pads whenever the decoded length is not a multiple of three, which is most
  messages; a decoder pinned to the unpadded form returns an error for them.
  `decodeBody` trims the padding and decodes raw, which reads both forms.
  This was a real outage-shaped bug rather than a hypothetical: the strict
  no-padding decoder silently produced empty bodies for roughly two thirds of
  all mail, and because every hand-written test fixture was unpadded, the
  suite never saw it.
- **A decode failure is logged, never returned as an empty body.** Every layer
  above treats an empty body as "nothing to say", so a silent decode failure
  is indistinguishable from blank mail all the way up — which is precisely how
  the bug above survived. The message is still returned so headers remain
  usable; the failure goes on the record.
- **Fixtures must include padded base64.** An unpadded-only fixture set cannot
  catch the most common real-world shape.
