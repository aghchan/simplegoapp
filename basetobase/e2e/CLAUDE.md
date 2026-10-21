# e2e/ — the real stack in a real browser

- `npm run e2e` (builds the dashboard first). Not part of `npm test`.
- `global-setup.ts`: a fresh local D1/KV/DO state in a temp dir, `wrangler dev` on a free port, and `fake-github.ts` (node:http) as `GITHUB_API`. Secrets go in a generated file passed with `--env-file`, so a developer's own `.dev.vars` is left alone. Log: `$TMPDIR/basetobase-e2e-wrangler.log`.
- Identity and test secrets: `stack.ts`. Session cookie: `signSession` from dispatch/src/auth/session.ts. Webhooks are signed with `WEBHOOK_SECRET`.
- `fake-github.ts` answers the calls Dispatch makes today. A new GitHub call needs a route there, or it gets a 404.
- Chromium: `/opt/pw-browsers/chromium` (override with `E2E_CHROMIUM`). `@playwright/test` is pinned to the version that drives it. Never `playwright install`.
- Projects `phone` (390 px) and `desktop` (1280 px), one worker, one shared stack. Each test uses its own PR numbers (`prNumber`).
- No reloads: `openRunsList` marks the page and `expectNoReload` checks the mark.
- Screenshots go to `$E2E_SCREENSHOTS` when set, else the test's output dir.
- Nothing leaves the machine: Google Fonts are aborted and `request.cf` stays the placeholder.
