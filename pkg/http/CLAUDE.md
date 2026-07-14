# pkg/http — controller base, codecs, middleware

## Handler flow (the only sanctioned request/response path)

`this.Bind(r, &req)` decodes per Content-Type (415/400 problems) →
`this.Respond(w, r, status, v)` encodes per Accept (406 problem; nil v = no
body) → `this.Problem(w, r, err)` for every failure (typed `apierror` values
keep their status; unknown errors are logged with request ID and masked as
500). Never write JSON or call http.Error directly.

## Pitfalls

- `RegisterCodec` at startup only — the registry is unsynchronized.
- `SetAuthMiddleware` before NewApp only — read once, unsynchronized.
- Add q-value-aware Accept negotiation BEFORE registering a second codec
  (known deferred item; first-match today).
- Spec mounts must pass `ErrorHandlerFunc: pkghttp.SpecErrorHandler` or
  param-binding failures regress to plaintext.
- Streaming (SSE/Flusher) is unsupported: the timeout middleware buffers
  responses; only websocket upgrades bypass (case-insensitive Upgrade check).
- Recover never rewrites a committed response and re-panics ErrAbortHandler.
