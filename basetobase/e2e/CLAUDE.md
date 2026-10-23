# e2e/ — the real stack in a real browser

- `npm run e2e` (builds the dashboard first). Not part of `npm test`.
- `global-setup.ts`: a fresh local D1/KV/DO state in a temp dir, `wrangler dev` on a free port, and `fake-github.ts` (node:http) as `GITHUB_API`. Secrets go in a generated file passed with `--env-file`, so a developer's own `.dev.vars` is left alone. Log: `$TMPDIR/basetobase-e2e-wrangler.log`.
- `wrangler dev` runs `worker/index.ts`: the production Worker, but agents' OIDC tokens verify against the fake's key set (`OIDC_KEYS_PATH`), since only Actions can mint GitHub's. It has Workers types: `tsc -p e2e/worker`, the last step of `npm run typecheck`.
- Identity and test secrets: `stack.ts`. Session cookie: `signSession` from dispatch/src/auth/session.ts. Webhooks are signed with `WEBHOOK_SECRET`.
- `fake-github.ts` answers every call Dispatch makes. A new GitHub call needs a route there, or it gets a 404. A PR is what a test last posted to `POST /__pulls/{n}` (404 before). Tests read `GET /__checks` (check-run calls), `/__jobs` (dispatched agent jobs, each with its OIDC token) and `/__cancels` (cancelled Actions runs) at `E2E_GITHUB_URL`.
- `github.ts` plays GitHub's side: `pullRequest` builds a PR in GitHub's shape; `open`, `push` and `close` change it on the fake, then deliver the event, as GitHub does. `patrol` is an agent's job (brief, then verdict, over `/agent`), so sweeps are real. `reconcileTick` runs the cron via Miniflare's `/cdn-cgi/local/scheduled`: `--test-scheduled`'s `/__scheduled` never reaches the Worker, which `run_worker_first` limits to its own paths.
- `dashboard.ts`: sign-in, the runs list's groups and links, screenshots.
- `health.spec.ts`: `GET /health` gets past the assets layer. Without its `run_worker_first` entry the dashboard's page answers, and every deploy would roll back.
- Chromium: `/opt/pw-browsers/chromium` (override with `E2E_CHROMIUM`). `@playwright/test` is pinned to the version that drives it. Never `playwright install`.
- Projects `phone` (390 px) and `desktop` (1280 px), one worker, one shared stack. Each test uses its own PR numbers (`prNumber`, `n` unique across spec files). `/` and the cron see every test's runs and PRs.
- No reloads: `openRunsList` marks the page and `expectNoReload` checks the mark.
- Screenshots go to `$E2E_SCREENSHOTS` when set, else the test's output dir.
- Nothing leaves the machine: Google Fonts are aborted and `request.cf` stays the placeholder.
