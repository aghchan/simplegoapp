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
- Review gate: main requires the App's check run *Base to Base* on the PR head (`checkRunOf`, machine.ts; an owed write is retried). Hazards or a failed agent fail it; unpatrolled PRs get neutral. Only ready PRs into the default branch are patrolled (`{"ignored":"draft"}`, `{"ignored":"base"}`): a check on a head vouches for every PR on it.
- Run statuses: open runs (`on_the_hill`, `swept`) speak for their PR. `landed`: GitHub merged it (violet on the dashboard; the end until M4 deploys). `stopped`: closed, superseded, or no longer ready. A stopped or landed run keeps its finished sweep's check conclusion; only a pending review's check is cancelled.
- GitHub → runs (`dispatch/src/reconcile/pr.ts`): every webhook path reads the PR as GitHub has it now (`pullState`), never trusting the event; a start or close the PR has moved past is `stale`. Each path ends in `reconcilePr`: keep the newest open run on the head, stop the rest (`superseded by <sha7>`, `PR closed`, `PR marked draft`, `PR retargeted to <ref>`); a merge into the default branch lands the newest run on the merged head and stops the others (`PR merged`); a title edit gives every run of the PR the title `pullState` reads, never the event's (edits arrive out of order).
- A merge into another branch lands nothing: it never reached what the run vouched for. The open runs stop (`PR merged into <base>`).
- Newest check wins: GitHub reads the newest check run of a name. When `reconcilePr` stops a run on the kept run's head, the kept run reposts its check (`repostCheck`, a durable mark) and marks the old one `skipped`. A review that ended pending before its check existed never creates one.
- Start order: the new run, or the unpatrolled neutral check, exists before any old run stops, so a failed delivery leaves the PR as it was. A fresh read after the start settles starts that race. An edit that changes the base is a retarget and skips the duplicate check.
- Reconcile cron (`dispatch/src/reconcile/cron.ts`, `*/5 * * * *`): GitHub never redelivers a failed webhook. Each tick reconciles every PR with an open run, then gives the start path to owner PRs whose head has no open run. ≤50 PRs a tick; logs `reconcile: <repo>#<n>: …`. Locally: `npm run dev`, then `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*"` (Miniflare's route; `/__scheduled` never reaches the Worker past `run_worker_first`).
- Cron restarts: a head whose runs all stopped is started again whatever its check says (that check is the stopped run's; the ready, reopened or retarget delivery was lost). A head with no run is started only without this App's check (an unpatrolled PR's neutral one). The restarted run stays open, so the next tick passes it.
- Runs → GitHub: stopping or landing a run cancels each live agent's Actions run (`cancelWorkflowRun`; best effort, 409 counts as done). The in-progress check is rewritten after every verdict or failure.
- Owed writes: `commit()` stores the state with revisioned index/check marks and arms a 60 s retry alarm; a mark clears only after its write succeeds and no newer commit set it. The index mark also waits for the lobby.
- Review outcome: `reviewOutcome` (machine.ts) is the one source for the check, `RunSnapshot.outcome`, the sweep step's `outcome`, the index row (`runs.outcome`, migration 0002) and every dashboard pass/fail signal. Success/green only for `clear`; `none` (no patrollers) is neutral grey. Never derive pass/fail elsewhere.
- `dispatch/src/routes/`: one Hono sub-app per surface (`github`, `agent`, `auth`, `api`, `health`), mounted by `createApp(deps)` in `dispatch/src/index.ts`.
- Bodies via `readBody`/`readJsonObject` (size-bounded). Refusals via `reject` (`routes/request.ts`).
- Credentials: `agent` (OIDC) and `api` (session cookie) in sub-app middleware; `github` checks the HMAC in its handler; `auth` is sign-in; `health` is public and names only the version.
- `GET /agent/brief` and `POST /agent/{events,verdict,failure}` answer 410 `{"error":"no longer wanted","agent":"<AgentStatus>"}`, changing nothing, once the run is stopped or landed or the agent is done. 403 is a wrong nonce only. The forwarder stops claude and exits by `agent`: `clear` or `stopped` 0, anything else 1.
- Agent clocks start at the brief (`onBriefed`) and reset on every re-run of the job. A dispatched job that never asks for its brief fails after 30 min (`JOB_START_MS`); no stall before the brief.
- Agent jobs: the Actions run is titled `Base to Base · <run> · <agent>`, the job named by agent id. Its last step (`if: failure() || cancelled()`) posts `/agent/failure` (`job failed|cancelled before the agent reported`) with curl and jq; like `/brief`, it links the job from the verified token, for a job that died before its brief. Event seq is offset per attempt (`(GITHUB_RUN_ATTEMPT − 1) × 1 000 000`) so a re-run's events survive the log's dedupe.
- Dashboard runs list: one entry per PR, filed by the run that speaks for it: the newest open run, else the newest landed, else the newest. Never the largest `createdAt` alone, since a run stopped in a race can be newer. Its other runs collapse beneath it. `/` shows the newest of the PRs' speaking runs and follows a newer one; `/runs/:id` pins one.

## Deploy

- Automatic: a push to main that passes basetobase-ci deploys itself (jobs `plan` and `deploy`; `scripts/src/ci-deploy.ts`). `plan` asks the live Worker's `GET /health` which commit it runs and skips when that commit, a newer one, or the same Worker code (`WORKER_PATHSPEC`, by exclusion) is live. `deploy` applies D1 migrations, deploys tagged with the commit, and waits ≤120 s for `/health` to show it healthy; otherwise it rolls back to the version that served before and fails.
- `GET /health` (public, never cached): `{ok, version, tag}` from the `CF_VERSION_METADATA` binding plus a D1 ping; 503 when D1 is unreachable. Routed worker-first (`run_worker_first`), or the dashboard's page would answer it.
- Secrets: environment `production` holds `CLOUDFLARE_API_TOKEN` (Workers Scripts and D1 edit, account settings read) and variable `CLOUDFLARE_ACCOUNT_ID`. Only protected branches may deploy to it, so no pull request's workflow reads them. Set up by `npm run setup:deploy` (also `npm run setup`'s last step).
- By hand: `npm run deploy` (untagged, so the next automatic deploy always ships), or Actions → basetobase-ci → Run workflow on main.
- First deploy: `npm run setup` on the owner's machine (`scripts/src/setup.ts`; rerunnable). Manual fallback: docs/superpowers/plans/2026-10-20-base-to-base-m1-skeleton.md, Task 13.
- New migration: `npm run migrate`, or let the deploy job apply it. Migrations run before the new code and a rollback leaves them, so each must also suit the version serving before it.
- `deploy` and `migrate` re-run `wrangler login` and retry once when the Cloudflare login has expired (`scripts/src/wrangler.ts`). A `CLOUDFLARE_API_TOKEN` in the shell never expires and skips login.
- Logs: Cloudflare dashboard → Workers Logs, or `npx wrangler tail`.

## Rollback

- Automatic when a deploy never serves a healthy `/health`. By hand: `npx wrangler rollback [version-id]`. Neither undoes D1 migrations, and neither can cross a Durable Object migration.

## Deploy cautions

- `GITHUB_APP_PRIVATE_KEY` must be PKCS#8: `openssl pkcs8 -topk8 -nocrypt -in app.pem -out app.pkcs8.pem`. A PKCS#1 key fails fast, naming that command in the log.
- Pipe the key: `npx wrangler secret put GITHUB_APP_PRIVATE_KEY < app.pkcs8.pem`. A pasted PEM stores only its first line.
- `PUBLIC_URL`: the deployed URL, no trailing slash. It is the OIDC audience (compared byte for byte) and the base of `/auth/callback`. Left at localhost, every `/agent/*` call gets a bare 401.
- Repo variable `BASETOBASE_URL` = `PUBLIC_URL`, exactly.
