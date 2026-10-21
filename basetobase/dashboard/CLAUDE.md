# dashboard/ — React SPA, served as the Worker's static assets

- Labels only from `shared/src/labels.ts`. Every themed label renders with its plain one (`themed · plain`), headings included.
- Fetch via `getJson`/`getText` (`src/api.ts`). Every caller sends a `SignedOutError` to `navigateTo(SIGN_IN_URL)`.
- External links only through `GithubLink`; it renders nothing unless the href starts `https://github.com/`.
- Live run state: `useRunLive`. `mergeLog` dedupes by `LogLine.id`, caps at 2000. First paint: `RunPage`'s one-off fetch.
- Live runs list: `useRunsLive`. After the first `/api/runs`, the lobby socket (`/api/live`) sends a `summary` per index write; every open refetches. While it is down, polls every 5 s while visible and refetches on becoming visible. `mergeRuns` upserts by id, newer `updatedAt` wins, sorted and capped as `listRuns`. A failed refresh keeps the last list.
- No `dangerouslySetInnerHTML`: log and transcript text renders as text.
- Tests awaiting `findBy*` fake only intervals (and `Date`), never `setTimeout`. Wait for the socket with `FakeWebSocket.opened()`; in `App` tests, pass its URL pattern (the lobby socket opens too). With intervals faked, `waitFor` cannot poll: flush effects in `act` first.
- Proven in a real browser by `npm run e2e` (e2e/CLAUDE.md).
