# dashboard/ — React SPA, served as the Worker's static assets

- Labels only from `shared/src/labels.ts`. Every themed label renders with its plain one (`themed · plain`), headings included.
- Fetch via `getJson`/`getText` (`src/api.ts`). Every caller sends a `SignedOutError` to `navigateTo(SIGN_IN_URL)`.
- External links only through `GithubLink`; it renders nothing unless the href starts `https://github.com/`.
- Live run state: `useRunLive`. `mergeLog` dedupes by `LogLine.id`, caps at 2000. First paint: `RunPage`'s one-off fetch.
- Live runs list: `useRunsLive`. After the first `/api/runs`, the lobby socket (`/api/live`) sends a `summary` per index write; every open refetches. While it is down, polls every 5 s while visible and refetches on becoming visible. `mergeRuns` upserts by id, newer `updatedAt` wins, sorted and capped as `listRuns`. A failed refresh keeps the last list.
- `/` shows the newest run (`newestRun`: largest `createdAt`) and follows a newer one as it arrives; `/runs/:id` pins one. Both key `RunPage` by run id, so pinning the run on show does not fetch it again.
- Runs list: one entry per PR, filed by its latest run's `groupOf` (landed → Landed, stopped → Closed whatever the outcome, failed or swept with hazards/failed → needs you). Earlier runs collapse under a disclosure button (`aria-expanded`, `aria-controls`) that opens itself when the current page is one of them.
- `--landed` (violet) means the PR merged: runs-list card, PR header chip and edge, a done Drop in (`landed` Mark). 7.10:1 on `--surface`, 6.25:1 on `--tint`, 6.32:1 on `--ground`.
- A `hidden` element whose class sets `display` still shows: add a `[hidden] { display: none }` rule for it.
- No `dangerouslySetInnerHTML`: log and transcript text renders as text.
- Tests awaiting `findBy*` fake only intervals (and `Date`), never `setTimeout`. Wait for the socket with `FakeWebSocket.opened()`; in `App` tests, pass its URL pattern (the lobby socket opens too). With intervals faked, `waitFor` cannot poll: flush effects in `act` first. `App` at `/` opens the newest run, so stub its `/api/runs/:id` too (`RUN_PAGES`).
- Proven in a real browser by `npm run e2e` (e2e/CLAUDE.md).
