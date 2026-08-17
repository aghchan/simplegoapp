# pkg/logger — zap wrapper

Four methods only: `Info`/`Warn`/`Error`/`Fatal(msg string, keysAndValues ...interface{})`.
No `Debug` — this is the app's only logger, keep the surface small.

## Contracts

- `keysAndValues` is zap's sugared alternating-pairs form: key, value, key,
  value... An odd count logs a broken pair silently (zap's behavior, not
  wrapped) — always pass matched pairs.
- `msg` is a lowercase action phrase ("hosted agent starting", "order
  created"), not a sentence — no trailing punctuation, no capitalization.
  Keeps log lines greppable and consistent across callers.
- `Fatal` calls `os.Exit` (via zap) — only for startup failures the process
  cannot run without.
