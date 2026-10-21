# dashboard/ — React SPA, served as the Worker's static assets

- Labels only from `shared/src/labels.ts`. Every themed label renders with its plain one (`themed · plain`), headings included.
- Fetch via `getJson`/`getText` (`src/api.ts`). Every caller sends a `SignedOutError` to `navigateTo(SIGN_IN_URL)`.
- External links only through `GithubLink`; it renders nothing unless the href starts `https://github.com/`.
- Live run state: `useRunLive`. `mergeLog` dedupes by `LogLine.id`, caps at 2000. First paint: `RunPage`'s one-off fetch.
- Runs list polls `/api/runs` every 5 s while visible and refetches on becoming visible (`useRunsPolling`, `App.tsx`). A failed refresh keeps the last list.
- No `dangerouslySetInnerHTML`: log and transcript text renders as text.
- Tests awaiting `findBy*` fake only intervals (and `Date`), never `setTimeout`. Wait for the socket with `FakeWebSocket.opened()`.
