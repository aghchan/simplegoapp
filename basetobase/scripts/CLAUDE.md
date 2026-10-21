# scripts/ — owner-run Node tools

- Run with Node ≥22.18 type stripping: erasable TS; `node:` built-ins and relative `.ts` imports only.
- Pure logic in `*-lib.ts`, tested in `test/`. Side effects (wrangler, gh, browser, network) only in the entry file.
- `setup.ts` (`npm run setup`): the one-time owner setup. Every step skips what already exists.
- Secrets travel on child stdin only. Never in argv, files or logs.
