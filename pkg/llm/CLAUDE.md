# pkg/llm — completion client

One method, `Complete`. Vendor types never leak: callers see `Request`,
`Turn`, `Role`, and a string back. The implementations wrap
[Eino](https://github.com/cloudwego/eino) chat-model components — Eino's core
carries no vendor dependencies, and each vendor lives in its own
`eino-ext/components/model/*` module.

- **The vendor lives behind the `provider` interface, one file each.**
  `llm_provider` is REQUIRED — `anthropic`, `openai`, or `openrouter`. Both an
  empty and an unknown value are construction errors, never a fallback: an
  implicit vendor is a silent one, and the failure it prevents is a key sent
  to a host nobody chose.
- **`openrouter` is its own provider even though it reuses the `openai` wire
  shape**, because that is what makes the endpoint unforgettable. `openai`
  names a protocol, not a company — Groq, Together, Ollama and vLLM serve it
  too — so a config that said `openai` and omitted `llm_base_url` would send
  an OpenRouter key to api.openai.com. Naming the host as the provider
  removes that configuration entirely; `llm_base_url` still overrides it for a
  proxy or a self-hosted server. `openRouterConfig` is split out from
  `newOpenRouter` so that defaulting rule is testable without reaching into
  the vendor component.
- **Retry belongs to the vendor client, and closing it fixed a real bug.**
  There used to be no retry at all: a routine 429 or 529 became a hard error,
  which a fail-open caller turned into "no verdict" — indistinguishable, by
  design, from a quiet inbox. The underlying clients now back off on
  408/409/429/5xx and connection errors and honour `Retry-After`.
- **`llm_timeout_seconds` (default 30) bounds ONE `Complete` call in total,
  retries included.** It is deliberately not a per-request timeout. A caller
  running a per-message loop inside a scheduler deadline sizes
  `budget × timeout` against that deadline; a per-request bound would let
  backoff multiply past it, and a slow run that silently skips downstream
  work is a failure mode, not a success.
- **Turn order is preserved verbatim, including consecutive same-role turns.**
  A prompt that fences untrusted content in one user turn and puts its
  instruction in the *next* user turn depends on this: collapsing them moves
  the instruction inside the attacker-controlled span. Eino's Claude component
  merges only adjacent *tool-result* and *system* messages, never plain user
  turns — `TestCompletePreservesConsecutiveUserTurns` pins that, and it has
  been mutation-tested to confirm it fails when the turns are merged. Re-run
  it on every component upgrade; it is the one test guarding a security
  property rather than a behaviour.
- **`Turns` must begin with a user turn.** The vendor components reject a
  leading assistant turn rather than silently reordering.
- **The model is pinned at construction**, not per call. `llm_model` is
  required — there is no default, because a silently-changing model makes
  classifier output incomparable across runs and turns a reproducibility bug
  into a mystery. `llm_base_url` is also the test seam.
- **`MaxTokens` is per-call, never construction-time.** A caller retrying an
  unparseable reply raises the ceiling; a construction-time cap would make
  that retry byte-identical to the attempt that just failed. The
  `constructionMaxTokens` value only satisfies the components' required field
  and is never the value actually sent.
- **`Temperature` is per-call and omitted entirely when nil.** It cannot be
  sent unconditionally: current-generation models reject sampling parameters
  outright, so a hardcoded `temperature` is a 400 on every request against
  them. Set it only against a model documented to accept it, and pass 0 when
  reproducibility matters.
- **An abnormal finish reason is logged.** Truncation and refusal both return
  an ordinary-looking short reply. Without the log line an operator sees only
  "unparseable" and cannot tell a `MaxTokens` that is too small from a model
  that answered badly — different fixes. `normalFinish` lists every vendor's
  spelling of a clean stop, because a provider swap must not turn healthy
  replies into logged anomalies.
- Provider errors are truncated before logging: `llm_base_url` is
  configurable, so a proxy's HTML error page would otherwise land verbatim in
  the caller's logs.
