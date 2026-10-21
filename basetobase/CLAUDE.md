# basetobase/ — Base to Base (agent CI/CD)

Spec: docs/superpowers/specs/2026-10-20-base-to-base-design.md

- Own Go module (go.mod) keeps this tree out of `go ./...` and module zips. No Go code here.
- One npm package. Units: shared/ (pure; only dep picomatch), dispatch/ (Worker + RunDO), forwarder/ (Node on runners), dashboard/ (React SPA), scripts/ (owner-run Node tools).
- Relative imports with `.ts` extensions. Erasable TS only.
- Run logic: pure transitions returning effects in dispatch/src/run/machine.ts. RunDO only persists and executes effects.
- Commands: `npm test` (builds the dashboard first; `dashboard/dist` is the Worker's assets) · `npm run typecheck` · `npm run dev` · `npm run deploy`.
- `npm run e2e`: Playwright against `wrangler dev` and a fake GitHub; not part of `npm test`. See e2e/CLAUDE.md.
- `npm run dev` needs `basetobase/.dev.vars` (git-ignored) with the six secrets in `dispatch/src/env.ts`.
- Dependency changes: `npx -y npm@11 install …`. npm 10 crashes on vitest 4.1 and churns lockfile libc entries.
- Transcripts: Workers KV (`TRANSCRIPTS`, 30-day TTL), key `runs/{run}/{agent}.jsonl`. Eventually consistent: a fresh upload can 404 elsewhere for ~60 s.
- `unpatrolledGlobs` (config/basetobase.json): PRs touching Base to Base's own files aren't patrolled until M5. The webhook answers `{"ignored":"unpatrolled"}`.
- Review gate: main requires the App's check run *Base to Base* on the PR head (`checkRunOf`, machine.ts; a refused write is retried like the index). Hazards or a failed agent fail it; unpatrolled PRs get neutral; a push supersedes the PR's active run; an event whose head isn't the PR's current one is ignored as `stale`.
- Review outcome: `reviewOutcome` (machine.ts) is the one source for the check, `RunSnapshot.outcome`, the sweep step's `outcome`, the index row (`runs.outcome`, migration 0002) and every dashboard pass/fail signal. Success/green only for `clear`; `none` (no patrollers) is neutral grey. Never derive pass/fail elsewhere.
- `dispatch/src/routes/`: one Hono sub-app per surface (`github`, `agent`, `auth`, `api`), mounted by `createApp(deps)` in `dispatch/src/index.ts`.
- Bodies via `readBody`/`readJsonObject` (size-bounded). Refusals via `reject` (`routes/request.ts`).
- Credentials: `agent` (OIDC) and `api` (session cookie) in sub-app middleware; `github` checks the HMAC in its handler; `auth` is sign-in.
- `POST /agent/{events,verdict,failure}` answer 410 `{"error":"no longer wanted"}`, changing nothing, once the run is stopped or the agent is done. The forwarder then stops claude.

## Deploy

- `npm run deploy`.
- First deploy: `npm run setup` on the owner's machine (`scripts/src/setup.ts`; rerunnable). Manual fallback: docs/superpowers/plans/2026-10-20-base-to-base-m1-skeleton.md, Task 13.
- New migration: `npm run migrate`.
- `deploy` and `migrate` re-run `wrangler login` and retry once when the Cloudflare login has expired (`scripts/src/wrangler.ts`). A `CLOUDFLARE_API_TOKEN` in the shell never expires and skips login.
- Logs: Cloudflare dashboard → Workers Logs, or `npx wrangler tail`.

## Rollback

- `npx wrangler rollback`.

## Deploy cautions

- `GITHUB_APP_PRIVATE_KEY` must be PKCS#8: `openssl pkcs8 -topk8 -nocrypt -in app.pem -out app.pkcs8.pem`. A PKCS#1 key fails fast, naming that command in the log.
- Pipe the key: `npx wrangler secret put GITHUB_APP_PRIVATE_KEY < app.pkcs8.pem`. A pasted PEM stores only its first line.
- `PUBLIC_URL`: the deployed URL, no trailing slash. It is the OIDC audience (compared byte for byte) and the base of `/auth/callback`. Left at localhost, every `/agent/*` call gets a bare 401.
- Repo variable `BASETOBASE_URL` = `PUBLIC_URL`, exactly.
