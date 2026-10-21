# forwarder/ — runs claude in the agent job, reports to Dispatch

- Runs as `node forwarder/src/main.ts` (Node ≥22.18 type stripping): erasable TS; imports `node:` built-ins and relative `.ts` only.
- Forwarder-only env (`FORWARDER_ONLY_ENV`, stripped from claude): `NONCE`, `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN`. `CLAUDE_CODE_OAUTH_TOKEN` stays, redacted from events and transcript.
- Prompt goes on stdin; argv is too small. PR text sits in the `<pr_description>` fence.
- 410 from events, verdict or failure: stop claude (SIGTERM, SIGKILL after 5 s), send nothing more, upload the transcript, exit 0.
- Exit 0 only for a delivered clear verdict. Hazards, a failed agent or an undelivered report exit 1: a green job means the review passed.
- 20 min after spawn: failure `claude ran past 20 min`, exit 1.
- SIGINT/SIGTERM: failure `job cancelled`, exit 1, each step ≤2 s. A second signal exits at once.
- The workflow step `exec`s node so runner signals reach it.
- Never log the nonce or tokens. Client errors carry method, path and Dispatch's answer, never the query string.
- Tests drive the real loop against test/fixtures/fake-claude.mjs (`FAKE_*` knobs) with injected client, batcher, signals and timings.
