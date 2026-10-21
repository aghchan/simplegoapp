# dashboard/ — React SPA served as the Worker's static assets

- Step, run-status, agent-status and rating labels come only from `shared/src/labels.ts`; every themed label renders with its plain one (`themed · plain`), headings included.
- Fetch through `getJson`/`getText` in `src/api.ts`; a `SignedOutError` goes to `navigateTo(SIGN_IN_URL)` (`/auth/login`) in every caller.
- External links go only through `GithubLink`, which renders nothing unless the href starts with `https://github.com/`.
- Live run state comes from `useRunLive`; `mergeLog` dedupes lines by `LogLine.id` and caps them at 2000. The first paint is `RunPage`'s one-off fetch.
- The runs list polls `/api/runs` every 5 s only while the tab is visible and refetches on becoming visible (`useRunsPolling` in `App.tsx`); a failed refresh keeps the last list.
- Never `dangerouslySetInnerHTML`: log and transcript text renders as text.
- Tests fake only the intervals (and `Date`), never `setTimeout`, so Testing Library's `findBy*` timeouts keep working.
