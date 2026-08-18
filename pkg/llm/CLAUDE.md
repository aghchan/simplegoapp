# pkg/llm — completion client

One method, `Complete`. Vendor types never leak: callers see `Request`,
`Turn`, `Role`, and a string back.

- **Model and temperature are pinned at construction**, not per call.
  `llm_model` is required — there is no default, because a silently-changing
  model makes classifier output incomparable across runs and turns a
  reproducibility bug into a mystery. `llm_base_url` is the test seam.
- **Turn order is preserved verbatim.** Callers that place untrusted text in
  its own turn and their instruction in a later turn depend on this; do not
  reorder, merge, or collapse turns.
- **The HTTP client carries a 30s timeout.** An unbounded call would stall
  callers running against a scheduler deadline — being slow but working is a
  failure mode, not a success.
- Non-200 returns an error naming the status. There is no retry here:
  retry policy belongs to the caller, who knows whether the operation is
  safe to repeat and what to do when it isn't.
