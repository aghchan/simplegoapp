# scripts/ — owner-run Node tools

- Run with Node ≥22.18 type stripping: erasable TS; `node:` built-ins and relative `.ts` imports only.
- Pure logic in `*-lib.ts`, tested in `test/`. Side effects (wrangler, gh, browser, network) only in entry files and `io.ts`, their shared child processes and prompts.
- `setup.ts` (`npm run setup`): the one-time owner setup. Every step skips what already exists.
- Secrets travel on child stdin only. Never in argv, files or logs.
- `wrangler.ts` (`npm run deploy`, `npm run migrate`): runs wrangler; an expired login reruns `wrangler login` and retries once.
- `setup-deploy.ts` (`npm run setup:deploy`; `setup`'s last step once gh is signed in): environment `production` (main only, by branch policy), a Cloudflare user token from a filled-in form link, checked against Cloudflare's API and limited to one account, then a first deploy run.
- `ci-deploy.ts` (CI only; `plan` and `deploy`): decisions in `ci-deploy-lib.ts`, driven in tests through `DeployIO`. wrangler reads the token from the job's environment, as Cloudflare documents.
- `trail-names.ts` (`npm run trail-names`): rewrites config/trail-names.json from OpenStreetMap's Overpass API, one query per Ikon mountain in California and Utah (`IKON_RESORTS`: a ski-area name regex and a box). Each good answer is saved raw as `scripts/overpass/<slug>.json` (outside `WORKER_PATHSPEC`, so it never deploys by itself). A mountain whose query fails, times out (180 s) or comes back unusable (`answerProblem`: not JSON, a runtime-error `remark`, no named runs) falls back on its saved answer, with a warning naming its OpenStreetMap date (`chooseAnswer`). A mountain with neither fails the run, which writes nothing; tune its regex or box. Commit config/trail-names.json and scripts/overpass/ together.
