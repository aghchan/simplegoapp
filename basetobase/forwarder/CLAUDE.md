# forwarder/ — runs claude in the agent job and reports to Dispatch

- Runs as `node forwarder/src/main.ts` via Node ≥22.18 type stripping: erasable TS only; imports are `node:` built-ins and relative `.ts` files, never npm packages.
- `NONCE` and `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN` are forwarder-only (`FORWARDER_ONLY_ENV`, removed from claude's env); `CLAUDE_CODE_OAUTH_TOKEN` stays for claude but is redacted from events and the transcript.
- The prompt goes to claude on stdin (too long for argv); PR text sits in the `<pr_description>` fence (prompt.ts) that `.basetobase/patrol/_verdict.md` names.
- 410 from events, verdict or failure = Dispatch no longer wants reports: stop claude (SIGTERM, SIGKILL after 5 s), send nothing more, upload the transcript, exit 0.
- 20 min after claude starts → failure `claude ran past 20 min`, exit 1. SIGINT/SIGTERM → failure `job cancelled`, exit 1, each cancel step bounded to 2 s; a second signal exits at once.
- The workflow step `exec`s node: the runner signals the step's shell, which would not pass the signal on.
- Never log the nonce or tokens: client errors carry method, path and Dispatch's answer, never the query string (it holds the nonce).
- Tests run the real loop against test/fixtures/fake-claude.mjs (`FAKE_*` env knobs) with an injected client, batcher, signals and timings.
