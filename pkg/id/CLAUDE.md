# pkg/id — UUIDv7 generator

Single function: `New() string`.

## Contract

UUIDv7's lexical order is creation order — this is load-bearing, not
incidental: keyset pagination (`pkg/postgres` `Page`, Linear's Relay cursors
being passed through) relies on ids sorting the way they were created. Do not
swap this for `uuid.NewString()` (v4, random order) or any other scheme
without auditing every cursor-based list.
