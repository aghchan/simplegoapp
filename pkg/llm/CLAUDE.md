# pkg/llm — completion client

One method, `Complete`. Vendor types never leak: callers see `Request`,
`Turn`, `Role`, and a string back.

- **The model is pinned at construction**, not per call. `llm_model` is
  required — there is no default, because a silently-changing model makes
  classifier output incomparable across runs and turns a reproducibility bug
  into a mystery. `llm_base_url` is the test seam.
- **`Temperature` is per-call and omitted entirely when nil.** It cannot be
  sent unconditionally: current-generation models reject sampling parameters
  outright, so a hardcoded `temperature` is a 400 on every request against
  them. Set it only against a model documented to accept it, and pass 0 when
  reproducibility matters.
- **Turn order is preserved verbatim.** Callers that place untrusted text in
  its own turn and their instruction in a later turn depend on this; do not
  reorder, merge, or collapse turns.
- **The timeout is configurable** (`llm_timeout_seconds`, default 30). A
  caller running a per-message loop inside a scheduler deadline must be able
  to make `budget × timeout` fit that deadline without a new release of this
  package — being slow but working is a failure mode, not a success.
- **An abnormal `stop_reason` is logged.** `max_tokens` and `refusal` both
  return HTTP 200 carrying partial text, which reaches the caller as an
  ordinary-looking short reply. Without the log line an operator sees only
  "unparseable" and cannot tell a `MaxTokens` that is too small from a model
  that answered badly — different fixes.
- Non-200 returns an error naming the status, with the body bounded at 8KB:
  `llm_base_url` is configurable, so a proxy's HTML error page would
  otherwise land verbatim in the caller's logs. There is no retry here —
  retry policy belongs to the caller, who knows whether the operation is
  safe to repeat.
