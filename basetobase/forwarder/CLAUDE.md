# forwarder/ — runs claude in the agent job, reports to Dispatch

- Runs as `node forwarder/src/main.ts` (Node ≥22.18 type stripping): erasable TS; imports `node:` built-ins and relative `.ts` only.
- Forwarder-only env (`FORWARDER_ONLY_ENV`, stripped from claude): `NONCE`, `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN`. `CLAUDE_CODE_OAUTH_TOKEN` stays, redacted from events and transcript.
- Prompt goes on stdin; argv is too small. PR text sits in the `<pr_description>` fence.
- 410 `{"error":"no longer wanted","agent":"<AgentStatus>"}`: Dispatch no longer wants the agent. On the brief, send nothing. On events, verdict or failure: stop claude (SIGTERM, SIGKILL after 5 s), send nothing more, upload the transcript.
- The 410's `agent` sets the exit: `clear` or `stopped` 0, anything else (or none) 1. A retried verdict's 410 then exits by the verdict Dispatch already has.
- A brief 403 is a wrong nonce: exit 1, like any other brief error.
- Exit 0 only for a delivered clear verdict or a 410 naming `clear` or `stopped`. Hazards, a failed agent or an undelivered report exit 1: a green job means the review passed.
- Event `seq` starts at `(GITHUB_RUN_ATTEMPT − 1) × 1 000 000`: Dispatch drops a seq it already holds for the agent, so a re-run's events would be lost.
- The workflow's last step (`if: failure() || cancelled()`) posts failure `job failed|cancelled before the agent reported` with curl and jq, for a job that ended before the forwarder reported. It copies client.ts's OIDC request and failure body: change them together.
- 20 min after spawn: failure `claude ran past 20 min`, exit 1.
- SIGINT/SIGTERM: failure `job cancelled`, exit 1, each step ≤2 s. A second signal exits at once.
- The workflow step `exec`s node so runner signals reach it.
- Never log the nonce or tokens. Client errors carry method, path and Dispatch's answer, never the query string.
- Tests drive the real loop against test/fixtures/fake-claude.mjs (`FAKE_*` knobs) with injected client, batcher, signals and timings.
