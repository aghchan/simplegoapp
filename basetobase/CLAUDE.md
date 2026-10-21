# basetobase/ — Base to Base (agent CI/CD)

Spec: docs/superpowers/specs/2026-10-20-base-to-base-design.md

- Own Go module (go.mod) keeps this tree out of `go ./...` and module zips. Never add Go code here.
- One npm package. Units: shared/ (pure, no deps but picomatch), dispatch/ (Worker + RunDO), forwarder/ (Node on runners), dashboard/ (React SPA).
- Relative imports with .ts extensions. Erasable TS only (forwarder runs via Node type stripping).
- Run logic lives in dispatch/src/run/machine.ts as pure transitions returning effects; RunDO only persists and executes effects.
- Commands: npm test · npm run typecheck · npm run dev · npm run deploy
- `npm run dev` needs `basetobase/.dev.vars` (git-ignored) holding the six Worker secrets listed in `dispatch/src/env.ts`.
- Transcripts live in Workers KV (`TRANSCRIPTS`, 30-day TTL), key `runs/{run}/{agent}.jsonl`. KV is eventually consistent: a fresh upload can 404 from another location for about 60 s.
- PRs touching `unpatrolledGlobs` (config/basetobase.json: Base to Base's own files) are not patrolled until M5; the webhook answers `{"ignored":"unpatrolled"}`.
- Dependency changes: `npx -y npm@11 install …` (npm 10 crashes on vitest 4.1 installs and churns lockfile libc entries).
- `npm test` builds the dashboard first; `dashboard/dist` is the Worker's `assets` directory.
- `dispatch/src/routes/`: one Hono sub-app per surface (`github`, `agent`, `auth`, `api`), mounted in `dispatch/src/index.ts` by `createApp(deps)`.
- Route bodies are read with `readBody`/`readJsonObject` (size-bounded); refusals go through `reject` (all in `routes/request.ts`).
- Credentials: `agent` (OIDC) and `api` (session cookie) check in sub-app middleware; `github` verifies the HMAC in its handler; `auth` is the sign-in flow.
- `POST /agent/{events,verdict,failure}` answer 410 `{"error":"no longer wanted"}`, changing nothing, once the run is stopped or the agent has finished; the forwarder stops claude on it.

## Deploy

- `npm run deploy`.
- The first deploy needs the owner setup in docs/superpowers/plans/2026-10-20-base-to-base-m1-skeleton.md Task 13: D1, KV, migrations, GitHub App, OAuth App, Worker secrets, repo secret and variable.
- After any new migration: `npx wrangler d1 migrations apply basetobase --remote`.
- Worker logs: Cloudflare dashboard → Workers Logs (`observability` is on in wrangler.jsonc), or live with `npx wrangler tail`.

## Rollback

- `npx wrangler rollback`.

## Deploy cautions

- `GITHUB_APP_PRIVATE_KEY` must be PKCS#8 (`openssl pkcs8 -topk8 -nocrypt -in app.pem -out app.pkcs8.pem`); a PKCS#1 key fails fast with that command in the Worker log.
- Pipe the key, never paste it: `npx wrangler secret put GITHUB_APP_PRIVATE_KEY < app.pkcs8.pem`. The interactive prompt reads one line, so a pasted PEM is stored as its header alone.
- `PUBLIC_URL` must be the deployed URL with no trailing slash: it is the OIDC audience, compared byte for byte, and URLs are built as `${PUBLIC_URL}/auth/callback`. Left at localhost, every `/agent/*` call gets a bare 401.
- Repo variable `BASETOBASE_URL` must equal `PUBLIC_URL`, also with no trailing slash.
