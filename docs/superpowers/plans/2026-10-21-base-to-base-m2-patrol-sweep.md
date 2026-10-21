# Base to Base M2 (Full Patrol Sweep) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A backend PR is swept by six adversarial patrollers at once, one runner each. Their verdicts fill a hazards table, their evidence (requests, responses, command output) shows inline on the dashboard, and the run stays within the free tier.

**Architecture:**
- **No new moving parts.** M1's machine already creates one agent per enabled roster role, and the workflow already runs any role. M2 turns on six roles, gives each an adversarial template, and adds three new things: a per-role tool allowlist, an evidence upload beside the transcript, and a hazards table on the dashboard.
- **The budget work comes first.** Six agents multiply Durable Object writes, so the log moves to one row per event batch. KV gets gzip-compressed transcripts, which keeps it inside its 1 GB.

**Tech Stack:** unchanged from M1 (TypeScript 5.9, Cloudflare Workers + Durable Objects + D1 + KV, Hono, React 19, Vitest 4.1, Node 24, Claude Code CLI 2.1.292).

**Spec:** `docs/superpowers/specs/2026-10-20-base-to-base-design.md`. This plan covers §17 milestone 2, plus the M2 prerequisites parked in the M1 review (DO write budget, evidence storage, tool allowlist, `base.ref`, dispatch rechecking the run). Read §6, §9, §11, §12 and §15 first.

**Out of scope for M2** (later plans):
- the huddle, Groomer, wind hold, owner actions, re-run, Lift closed and the concurrency cap (M3);
- the check run on the PR, the summit check, merge and deploy (M3–M4);
- the frontend panel: Magic Carpet and Bluebird templates, Playwright and screenshots (M5);
- "usual" step durations, the Dispatch freshness indicator, and webhook delivery-id dedupe (M3).

## Global Constraints

**Carried from M1**
- All M1 Global Constraints still hold: layout, TypeScript rules, identity vars, security, comments, commits.
- These M1 values are unchanged:
  - agent id `${role}-${step}-${round}`
  - watchdog 600 000 ms stall and 1 800 000 ms timeout
  - job `timeout-minutes: 25` and forwarder deadline 20 min
  - batches every 2 000 ms or 50 events
  - log text capped at 2 000 chars; snapshots carry 500 lines; the dashboard keeps 2 000
- Dependency changes go through `npx -y npm@11 install`. `npm test` builds the dashboard first.

**Roles**
- After M2, `enabledRoles` = `["granite-chief", "gold-coast", "summit-six", "kt-22", "mainline", "corduroy"]`.
- `magic-carpet` and `bluebird` stay disabled until M5, since every frontend path is unpatrolled until then.
- Every patroller is an adversarial reviewer (spec §6 Stance). The shared stance lives only in `.basetobase/patrol/_verdict.md`. Role templates add attacks for their own criteria and never soften the stance.
- Templates: one imperative rule per line, no preamble, at most 40 lines each.
- **Terse everywhere (owner).** Every text an agent reads is direct and terse: templates, prompt lines built in code, workflow steps, CLAUDE.md files, subagent briefs. That means one rule per line, with no preamble, rationale, hedging or politeness. Reviewers reject wording that adds no rule.

**Tool allowlists** (passed as `claude --tools` with a comma-separated list)
- Patrollers: `Bash,Read,Grep,Glob,Write`.
- Groomer (defined now, used in M3): `Bash,Read,Grep,Glob,Write,Edit,MultiEdit,Task`.
- Every patroller's list must contain `Write`, because the verdict is written to a file.

**Evidence**
- File shape: `{"items":[{"id":"E1","title":"…","kind":"http"|"command","input":"…","output":"…"}]}`.
- Ids match `/^E[1-9][0-9]{0,2}$/`, at most 50 items, titles 1–120 chars.
- `input` and `output` are truncated at 20 000 chars with the suffix `\n… [truncated]`.
- The upload body is at most 1 MiB.
- A hazard's optional `evidence` is an array of at most 10 ids from the same agent's file.

**Storage**
- One KV binding, `EVIDENCE` (renamed from `TRANSCRIPTS`). Same namespace id, so the owner has no new setup step.
- Keys: `runs/{run}/{agent}.jsonl` (transcript, gzip) and `runs/{run}/{agent}.evidence.json`. TTL `2_592_000` s.
- Transcripts upload as `Content-Type: application/gzip`. They are stored compressed with metadata `{"encoding":"gzip"}` and served decompressed. A plain upload, from a pre-M2 forwarder still mid-run, is stored and served as-is.

**Durable Object budget**
- About one SQLite row written per events batch.
- `LINE_ID_STRIDE = 1000`, so a log line's id = `batch id × 1000 + index`.
- `EVENT_CLOCK_GRAIN_MS = 60_000`: `lastEventAt` is only persisted once it has moved by that much.

**Labels**
- Headings: "Hazards flagged · concerns raised" and "Evidence · requests and results".
- Hazard statuses come from `HAZARD_STATUS_LABELS` in `shared/src/labels.ts`. M2 has only `open: "Open"`.

## Review Focus

These five cases aren't covered by the main-path tests. Each one is pinned by a test in the task named.

1. **Six agents report in any order, interleaved with events and failures.** The sweep closes exactly once, after the last report, and the Conditions report lists all six. Task 3: `six agents reporting in any order close the sweep once`.
2. **A retried event batch after the Durable Object wakes, with its in-memory seq cache cold,** stores nothing twice. Task 3: `dedupes a retried batch when the seq cache is cold`.
3. **A broken, oversized, or wrong-shaped evidence file** never blocks the verdict, and a hazard that cites a missing evidence id still renders. Task 2: `reports the verdict when evidence is unusable`. Task 4: `refuses malformed evidence by field` and `truncates long evidence input and output`. Task 6: `a hazard citing evidence that does not exist still renders`.
4. **Hazard text and evidence containing HTML or script** render as text. Task 6: `renders hazard and evidence text as text`.
5. **A closed PR, or a GitHub dispatch failure, partway through dispatching six agents.** Nothing more is dispatched once the run is stopped. A failed dispatch fails only its own agent. Task 3: `a stop during the dispatches starts no further workflows` and `one failed dispatch does not hold up the others`.

---

### Task 1: Roster tool allowlists, free-tier limits, brief tools

**Files:**
- Modify: `basetobase/shared/src/config.ts`, `basetobase/config/basetobase.json`, `basetobase/shared/src/types.ts` (`AgentBrief`), `basetobase/dispatch/src/run/machine.ts` (`briefOf`)
- Test: `basetobase/shared/test/config.test.ts`, `basetobase/dispatch/test/machine.test.ts`

**Interfaces:**
- Produces:
  - `RosterEntry.tools: string[]`
  - `B2BConfig.freeTier: { service: string; allowance: string; pressure: string }[]`
  - `AgentBrief.tools: string[]`
  - `briefOf` copies `tools` from the roster entry.

- [ ] **Step 1: Write the failing tests** in `config.test.ts`:
  - `loads every role's tools`: `rosterEntry(config, "mainline").tools` equals `["Bash","Read","Grep","Glob","Write"]`, and every non-groomer entry's tools equal that list.
  - `rejects a patroller without Write`: a roster entry with `panels: ["backend"]` and `tools: ["Read"]` throws `invalid config: roster[0].tools must include Write`.
  - `rejects tool names that are not words`: `tools: ["Bash(rm *)"]` throws a message naming `roster[0].tools[0]`.
  - `loads the free-tier limits`: `config.freeTier` has 7 rows, and the first is `{service: "Cloudflare Workers", …}`.

  Also add `briefOf carries the role's tools` to `machine.test.ts`.
- [ ] **Step 2: Run** `npx vitest run --project node shared/test/config.test.ts` and `npx vitest run --project dispatch test/machine.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - Validate `tools` in `asRosterEntry`: a non-empty array of `/^[A-Z][A-Za-z]+$/`, which must include `Write` when `panels` is non-empty.
  - Validate `freeTier` as an array of objects with three non-empty strings.
  - Copy the spec §15 table's seven rows into `freeTier`, verbatim per cell.
  - Set the allowlists from Global Constraints. Leave `enabledRoles` as `["mainline"]`; Task 5 turns the rest on.
- [ ] **Step 4: Run** the same commands, plus `npm run typecheck`. Expect PASS.
- [ ] **Step 5: Commit**: `basetobase: roster tool allowlists, free-tier limits in config`.

### Task 2: Forwarder: tool allowlist, evidence upload, gzip transcripts

**Files:**
- Modify: `basetobase/forwarder/src/run.ts`, `basetobase/forwarder/src/prompt.ts`, `basetobase/forwarder/src/client.ts`, `basetobase/forwarder/CLAUDE.md`
- Test: `basetobase/forwarder/test/run.test.ts`, `prompt.test.ts`, `client.test.ts`

**Interfaces:**
- Consumes: `AgentBrief.tools` (Task 1).
- Uses the Dispatch contract that Task 4 implements:
  - `PUT /agent/evidence?run_id&agent_id&nonce` with a JSON body. Answers 204, 400 or 422 (`{"error": "<field> <rule>"}`), 413, or 403/410 as for transcripts.
  - `PUT /agent/transcript` now sends `Content-Type: application/gzip`.
- Produces:
  - `buildPrompt(brief, roleText, verdictText, paths: { verdict: string; evidence: string }): string`
  - `DispatchClient.evidence(path: string): Promise<void>`

- [ ] **Step 1: Write the failing tests.**
  - `prompt.test.ts`, `names the evidence path`: the prompt contains `Write evidence JSON to /w/evidence.json.`, and that line sits right after the verdict-path line.
  - `run.test.ts`, `passes the role's tools`: claude's argv contains `--tools` followed by `Bash,Read,Grep,Glob,Write` (from the brief), and still contains `--setting-sources user --strict-mcp-config`.
  - `run.test.ts`, `uploads evidence before the verdict`: the fake client records the calls `transcript`, then `evidence`, then `verdict`, when fake-claude writes both files.
  - `run.test.ts`, `skips a missing evidence file`: no `evidence` call, and the verdict is still posted.
  - `run.test.ts`, `reports the verdict when evidence is unusable`:
    - an evidence file over 1 MiB → no upload, one stderr line naming the size;
    - a 422 from `evidence` → one stderr line with Dispatch's reason.

    In both cases the verdict is posted and the exit code is 0.
  - `client.test.ts`, `gzips the transcript`: the PUT body gunzips (via `node:zlib` `gunzipSync`) back to the file's bytes, and the content type is `application/gzip`.
- [ ] **Step 2: Run** `npx vitest run --project node forwarder/test`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - `startClaude` takes `tools: string[]` and adds `--tools`, `tools.join(",")`.
  - `evidencePath = join(workDir, "evidence.json")`.
  - Upload order in `finish()`: transcript, then evidence (skipped when missing; best-effort like the transcript), then the verdict.
  - The 410 path and the cancel path upload evidence after the transcript too. In the cancel path it is bounded by `cancelStepMs`, like the transcript.
  - Gzip with `node:zlib` `gzip` (promisified) on the file bytes.
  - `forwarder/CLAUDE.md` gains: tools come from the brief; evidence path; gzip.
- [ ] **Step 4: Run** `npx vitest run --project node forwarder/test` and `npm run typecheck`. Expect PASS.
- [ ] **Step 5: Commit**: `basetobase: forwarder passes role tools, uploads evidence, gzips transcripts`.

### Task 3: Dispatch: one row per event batch; dispatch rechecks the run

**Files:**
- Create: `basetobase/dispatch/test/enabled-roles.ts` (a test setup file)
- Modify:
  - `basetobase/dispatch/src/run/do.ts`, `basetobase/dispatch/src/run/machine.ts`
  - `basetobase/dispatch/vitest.config.ts` (`setupFiles`)
  - `basetobase/config/basetobase.json` (the `freeTier` Durable Objects row)
  - `basetobase/CLAUDE.md`, spec §15 (one row, see Step 3)
- Test: `basetobase/dispatch/test/do.test.ts`, `basetobase/dispatch/test/machine.test.ts`

**Interfaces:**
- Produces:
  - `export const EVENT_CLOCK_GRAIN_MS = 60_000` and `export function wantsDispatch(s: RunState, agentId: string): boolean` in `machine.ts`.
  - `LogLine` is unchanged. Ids stay numeric and increase in arrival order, so `mergeLog` needs no change.

- [ ] **Step 1: Write the failing tests.**
  - `machine.test.ts`, `persists lastEventAt only past the grain`:
    - a running agent with `lastEventAt = t`: `onEvents(s, id, 3, t + 59_999, jobUrl)` returns the same state object;
    - at `t + 60_000` it sets `lastEventAt`;
    - the first batch (agent `dispatched`) always transitions to `running`.
  - `machine.test.ts`, `wantsDispatch only for a queued agent on a running run`: true for queued plus `on_the_hill`; false after `stopRun`; false for a `dispatched` agent.
  - `do.test.ts`, `stores one row per batch`: post 3 batches of 10 events, then `runInDurableObject` and `SELECT COUNT(*) FROM log_batch` gives 3. The view's log has 30 agent lines plus Dispatch's, in seq order, with ids strictly increasing.
  - `do.test.ts`, `dedupes a retried batch when the seq cache is cold`:
    - post a batch;
    - clear the instance's `lastSeqByAgent` map inside `runInDurableObject`;
    - post the same batch again.

    The log has its 10 lines once, and the second post changed nothing (`updatedAt` unchanged).
  - `do.test.ts`, `migrates an M1 log table`:
    - create the old `log` table with 3 rows in a fresh object via `runInDurableObject` before the run starts;
    - construct;
    - the view returns those 3 lines in order, and `log` no longer exists.
  - `do.test.ts`, `six agents reporting in any order close the sweep once`:
    - inside `withEnabledRoles([...the six backend roles], …)`;
    - interleave events, five verdicts and one failure, in a shuffled order;
    - the sweep goes `done` exactly once (one `sweep` close log line);
    - the Conditions report lists six patrollers, in the form `6 of 6 patrollers in`.
  - `do.test.ts`, `a stop during the dispatches starts no further workflows`: the fake GitHub calls `stop()` on the run from inside the first dispatch request, and only 1 dispatch request is made out of 6.
  - `do.test.ts`, `one failed dispatch does not hold up the others`: the fake GitHub answers 500 for the second dispatch. That agent is `error` with `dispatch failed: …`, and the other five are `dispatched`.
- [ ] **Step 2: Run** `npx vitest run --project dispatch test/do.test.ts test/machine.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - **Table.** `log_batch (id INTEGER PRIMARY KEY, agent_id TEXT, last_seq INTEGER, ts INTEGER NOT NULL, lines TEXT NOT NULL)`:
    - no AUTOINCREMENT and no UNIQUE index, since each adds a written row;
    - `lines` is a JSON array of `{ts, kind, text}`, with text capped at 2 000;
    - Dispatch's own log lines are single-line batches with a null agent and a null `last_seq`.
  - **Dedupe.** `private lastSeqByAgent = new Map<string, number>()`.
    - On a miss, run `SELECT MAX(last_seq) FROM log_batch WHERE agent_id = ?` once.
    - Keep only events whose `seq > lastSeq`. Insert one row when any remain, then update the map.
  - **Log ids.** Line id = `row id × LINE_ID_STRIDE + index`. `recentLog()` reads `ORDER BY id DESC LIMIT 500` batches, then flattens them and keeps the last 500 lines in ascending order.
  - **Legacy table.** In the constructor's `blockConcurrencyWhile`, if a `log` table exists, copy its rows in id order as single-line batches, then `DROP TABLE log`.
  - **Event clock.** `onEvents` returns `unchanged(s)` when the agent is already `running`, `now - lastEventAt < EVENT_CLOCK_GRAIN_MS`, and nothing else changed (the `jobUrl` is already set or empty).
  - **Dispatch recheck.** `RunDO.dispatch(agentId)` loads the state and returns at once unless `wantsDispatch`.
  - **Test setup.** `dispatch/test/enabled-roles.ts`:
    - exports `withEnabledRoles(roles: RoleId[], fn: () => Promise<void>)`, which sets `config.enabledRoles` and restores it in `finally`;
    - as a setup file, pins `config.enabledRoles = ["mainline"]` in a `beforeEach`, so tests written for one patroller keep passing when Task 5 turns on six.

    If the Durable Object turns out not to see the test module's `config` (a separate module instance), report it and stop: the controller decides on an injection seam.
  - **Docs.**
    - `basetobase/CLAUDE.md` gains a line on the budget rule: one row per batch, no UNIQUE or AUTOINCREMENT on hot tables.
    - Spec §15's Durable Objects row, and the matching `freeTier` row in config, read: "SQLite-backed objects, ~100k requests/day and 100k rows written/day, WebSocket hibernation | About one row per event batch: a 6-agent sweep writes roughly 2k rows".
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expect PASS.
- [ ] **Step 5: Commit**: `basetobase: one log row per event batch, dispatch rechecks the run`.

### Task 4: Dispatch: evidence, gzip transcripts, hazard evidence refs, base branch

**Files:**
- Create: `basetobase/shared/src/evidence.ts`, `basetobase/shared/test/evidence.test.ts`
- Modify:
  - `basetobase/shared/src/types.ts`, `basetobase/shared/src/verdict.ts`
  - `basetobase/dispatch/src/routes/agent.ts`, `basetobase/dispatch/src/routes/api.ts`
  - `basetobase/dispatch/src/run/do.ts`, `basetobase/dispatch/src/run/machine.ts`
  - `basetobase/dispatch/src/github/webhook.ts`
  - `basetobase/wrangler.jsonc`, `basetobase/worker-configuration.d.ts` (regenerate with `npm run types`)
  - `basetobase/CLAUDE.md`, spec §12 and §4 table (see Step 3)
- Test:
  - `basetobase/shared/test/verdict.test.ts`
  - `basetobase/dispatch/test/routes-agent.test.ts`, `routes-api.test.ts`, `machine.test.ts`, `webhook.test.ts`
  - the existing dispatch test helpers (`prPayload` gains `base.ref`)

**Interfaces:**
- Produces:
  - `EvidenceItem = { id: string; title: string; kind: "http" | "command"; input: string; output: string }`
  - `parseEvidence(raw: unknown): EvidenceItem[]`, which throws `EvidenceError` (message `"<path> <rule>"`, never the value)
  - `Hazard.evidence?: string[]`
  - `AgentSnapshot.hasEvidence: boolean`
  - `RunSnapshot.baseRef: string`
  - `PullRequestRef.baseRef: string`
  - `onEvidence(s: RunState, agentId: string): Transition`: status-agnostic, like `onTranscript`
  - `RunDO.evidenceStored(agentId, nonce): Promise<boolean>`
  - `GET /api/runs/:id/agents/:agentId/evidence` → `{ items: EvidenceItem[] }`, or 404

- [ ] **Step 1: Write the failing tests.**
  - `evidence.test.ts`:
    - `parses items`: a valid file round-trips.
    - `refuses malformed evidence by field`: each of these throws with exactly the path named:
      - `items[0].id must match E1–E999` for `"X1"`
      - `items[0].kind must be http or command` for `"sql"`
      - `items must have at most 50 entries` for 51 entries
      - `items[1].id duplicates items[0].id`
    - `truncates long evidence input and output`: a 25 000-char `output` comes back as 20 000 chars plus `\n… [truncated]`; the title is never truncated (over 120 throws).
  - `verdict.test.ts`, `accepts hazard evidence refs`: `evidence: ["E1","E2"]` is kept. `evidence: ["bad"]` throws `hazards[0].evidence[0] must match E1–E999`. 11 refs throws `at most 10`.
  - `routes-agent.test.ts`:
    - `stores evidence with the TTL`: the PUT returns 204; KV `list()` shows the key `runs/r1/mainline-sweep-0.evidence.json` with an expiration about 30 days out; the stored JSON equals `{items: parsed}`; the run view shows `hasEvidence: true`.
    - `refuses evidence without the nonce` (403, nothing stored).
    - `answers 422 naming the field`.
    - `answers 413 over 1 MiB`.
    - `stores a gzip transcript compressed`: KV metadata `{encoding:"gzip"}`, and the stored bytes equal the upload.
  - `routes-api.test.ts`:
    - `serves a gzip transcript decompressed`: the body equals the original ndjson.
    - `serves a plain transcript as-is`.
    - `serves evidence` / `404 for missing evidence`.
  - `webhook.test.ts`, `carries the base branch`: `toTrigger` on a payload with `base.ref: "release"` gives `baseRef: "release"`.
  - `machine.test.ts`:
    - `snapshot carries baseRef`.
    - `onEvidence sets hasEvidence even after stop`.
- [ ] **Step 2: Run** `npx vitest run --project node shared/test` and `npx vitest run --project dispatch`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - **KV binding.** Rename `TRANSCRIPTS` → `EVIDENCE` in `wrangler.jsonc`, keeping the id and the JSONC comment, then run `npm run types`.
  - **Evidence route.** `PUT /agent/evidence`: `checkNonce`, read the body (≤ 1 MiB), JSON-parse it (bad JSON → 400), `parseEvidence` (`EvidenceError` → 422 `{error}`), store `{items}` with the TTL, then `evidenceStored`.
  - **Transcript route.** Store with `{metadata: {encoding: "gzip"}}` when the content type is `application/gzip`.
  - **API.**
    - The transcript GET uses `getWithMetadata(key, "stream")` and pipes gzip bodies through `new DecompressionStream("gzip")`.
    - The evidence GET returns the stored JSON.
  - **Hazard refs.** `parseVerdict` accepts `evidence` as optional: at most 10 ids, each matching the evidence id rule, deduped.
  - **Base branch.** `toTrigger` reads `pull.base.ref`, and `createRun` copies it to `baseRef`. `snapshotOf` lists `baseRef` and passes `hasEvidence` through the agents.
  - **Docs.**
    - `basetobase/CLAUDE.md` lists the evidence key and route.
    - Spec §12: replace the "must be re-decided" sentence with "Workers KV also holds evidence (`runs/{run}/{agent}.evidence.json`, same TTL); screenshots are decided with M5."
    - Spec §4 table, Transcripts row: becomes "Transcripts and evidence"; drop "Evidence storage is open (§12)".
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expect PASS.
- [ ] **Step 5: Commit**: `basetobase: evidence upload and API, gzip transcripts, hazard evidence refs, base branch`.

### Task 5: Adversarial patrol templates; six roles on

**Files:**
- Create: `.basetobase/patrol/granite-chief.md`, `gold-coast.md`, `summit-six.md`, `kt-22.md`, `corduroy.md`
- Modify: `.basetobase/patrol/_verdict.md`, `.basetobase/patrol/mainline.md`, `.basetobase/CLAUDE.md`, `basetobase/config/basetobase.json` (`enabledRoles`)
- Test: `basetobase/shared/test/templates.test.ts` (create)

**Interfaces:**
- Consumes:
  - the evidence shape and the hazard `evidence` refs (Task 4);
  - the `Write evidence JSON to <path>.` prompt line (Task 2);
  - the dispatch test setup that pins `enabledRoles` to `["mainline"]` (Task 3);
  - `config.freeTier` (Task 1).

- [ ] **Step 1: Write the failing test** `templates.test.ts`, reading the files with `node:fs`:
  - `every enabled role has a template`: for each id in `config.enabledRoles`, the file `.basetobase/patrol/<id>.md` exists and its first line starts with `Role: <roster name> — `.
  - `templates stay terse`: every `.basetobase/patrol/*.md` has at most 40 non-empty lines.
  - `the shared stance comes first`: `_verdict.md` starts with `Stance: adversarial.`
  - `the verdict contract names evidence`: `_verdict.md` contains `"evidence":["E1"]` and the evidence item shape.
  - `enables the six backend patrollers`: `config.enabledRoles` equals the Global Constraints list.
- [ ] **Step 2: Run** `npx vitest run --project node shared/test/templates.test.ts`. Expect FAIL.
- [ ] **Step 3: Write the templates.** The text below is the decision: copy it. Tighten wording only if a rule survives intact.

  `_verdict.md`: add these lines after the hazard-shape line:

  ```
  - Hazard may add "evidence":["E1"]: ids from your evidence file.
  - Evidence: write {"items":[{"id":"E1","title":"<≤120 chars>","kind":"http"|"command","input":"…","output":"…"}]} to the evidence path below.
  - Record every attack there, failed ones too, in full. Dispatch truncates.
  ```

  `mainline.md`: add after the curl line:

  ```
  - Record each request/response as evidence (kind "http"), each go test run as kind "command".
  ```

  `granite-chief.md`:

  ```
  Role: Granite Chief — goal fit. Prove the change misses its goal.
  - From <pr_description> and the diff, list every behaviour the goal asks for, stated or implied.
  - No judgeable goal (empty, vague, or a title restating the diff) → hazard.
  - Find the code for each behaviour. Missing or partial → hazard naming it.
  - Implied cases count: empty input, absent records, repeat calls, the error a user will hit.
  - Anything the goal didn't ask for (features, flags, refactors, dependencies, config) → hazard.
  - Docs, CLAUDE.md files or api/v1/openapi.yml left stale → hazard.
  - Goal fit only. Style, cost, scale and security belong to others.
  ```

  `gold-coast.md`:

  ```
  Role: Gold Coast — infra and cost. Prove the change costs money or breaks a free-tier limit.
  - Rule: free hosting, no credit card. Limits: basetobase/config/basetobase.json → freeTier.
  - List every new or changed service, dependency, config key, env var, migration, job, external call and workflow.
  - For each: needs, and cost per request, run and month. Paid usage or a card requirement → hazard.
  - Do the arithmetic for each freeTier pressure point touched. Could exceed its allowance → hazard with the numbers.
  - Per-request external calls, retries, polling, chatty logging: find the rate. Unbounded → hazard.
  - A config.yml key missing from .basetobase/ci/local.yml or the docs → hazard.
  - A dependency that is heavy, unmaintained, or duplicates one in go.mod → hazard.
  ```

  `summit-six.md`:

  ```
  Role: Summit Six — scalability. Prove the change falls over under load or concurrency.
  - Find every changed query, loop, cache, lock, goroutine and request handler.
  - Queries: unbounded results, no LIMIT or pagination, N+1, unindexed filters → hazard with file:line.
  - Concurrency: unlocked shared state, check-then-act, missing transactions, goroutine leaks → hazard.
  - Postgres: localhost:5432, user postgres, password password, db postgres.
  - Run `go test -race` on changed packages. Start the app (`go run . > /tmp/app.log 2>&1 &`; wait for `curl -sf localhost:8080/health`). Fire 20 concurrent requests at each changed endpoint.
  - Per-request work growing with data, calls without timeouts, unbounded memory or goroutines → hazard.
  - Name each load assumption (rows, request rate, payload size). One that breaks at 10× → hazard.
  - Stop the app before writing the verdict.
  ```

  `kt-22.md`:

  ```
  Role: KT-22 — security. Attack the change as an outsider.
  - Map what the diff touches: routes, inputs, auth, queries, file and network access, secrets, logs, errors.
  - Postgres: localhost:5432, user postgres, password password, db postgres. Start: `go run . > /tmp/app.log 2>&1 &`; wait for `curl -sf localhost:8080/health`.
  - Curl every changed endpoint with no, forged and another user's credentials and ids (IDOR).
  - Send SQL injection, path traversal, header and JSON injection, oversized and deeply nested bodies.
  - A successful attack → hazard with the exact request and response.
  - Changed queries: string-built SQL → hazard. File, exec and URL calls on caller input → hazard.
  - Secrets anywhere in the repo, including config.yml → hazard.
  - Errors or logs exposing internals, tokens or personal data → hazard.
  - `go run golang.org/x/vuln/cmd/govulncheck@latest ./...`: a reachable vulnerability → hazard.
  - Stop the app before writing the verdict.
  ```

  `corduroy.md`:

  ```
  Role: Corduroy — code quality. Prove the change makes the codebase worse.
  - Rules: root and directory CLAUDE.md files, docs/BEST_PRACTICES.md, Google Go Style Guide with house exceptions (receivers named `this`).
  - Imports: domain/ never imports api/, pkg/http or apierror; pkg/ never imports domain/ or app/; main.go is the only composition root. Check with `go list -deps`.
  - Run `gofmt -l` on changed files, `go vet ./...`, `go run honnef.co/go/tools/cmd/staticcheck@latest ./...`. A finding in changed code → hazard.
  - SOLID and hexagonal: logic in handlers, adapters in domain, types with several jobs, interfaces wider than callers need → hazard with file:line.
  - Duplicated logic → hazard. Find the existing helper first.
  - Lying names, dead or commented-out code, comments restating code → hazard.
  - New behaviour without unit tests, or tests asserting nothing → hazard.
  - TypeScript: strict-mode escapes, `any`. Agent templates: a line adding no rule → hazard.
  ```

  Set `enabledRoles` to the six roles, and update `shared/test/config.test.ts` where it pins the old list. In `.basetobase/CLAUDE.md`, add: frontend-only roles get templates with M5.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expect PASS.
- [ ] **Step 5: Commit**: `basetobase: adversarial templates for the backend patrol; six patrollers on`.

### Task 6: Dashboard: hazards table, inline evidence, base branch

**Files:**
- Create: `basetobase/dashboard/src/components/HazardsTable.tsx`, `basetobase/dashboard/src/components/Evidence.tsx`
- Modify:
  - `basetobase/dashboard/src/components/StepDetail.tsx`, `basetobase/dashboard/src/pages/RunView.tsx`
  - `basetobase/shared/src/labels.ts` (`HAZARD_STATUS_LABELS`)
  - `basetobase/dashboard/src/theme.css`, `basetobase/dashboard/CLAUDE.md`
- Test: `basetobase/dashboard/test/HazardsTable.test.tsx`, `Evidence.test.tsx`, `RunView.test.tsx`

**Interfaces:**
- Consumes:
  - `Hazard.evidence`, `AgentSnapshot.hasEvidence` and `RunSnapshot.baseRef` (Task 4);
  - `GET /api/runs/:id/agents/:agentId/evidence` (Task 4).
- Produces:
  - `HazardsTable({ run, stepId, onShowEvidence }: { run: RunSnapshot; stepId: StepId; onShowEvidence: (agentId: string, evidenceId: string) => void })`
  - `Evidence({ runId, agentId, focusId }: { runId: string; agentId: string; focusId?: string })`

- [ ] **Step 1: Write the failing tests.**
  - `HazardsTable.test.tsx`:
    - `lists every hazard of the step`: two agents with hazards `FUN-1` and `SEC-1`, `SEC-2` give a table (`role="table"`, name "Hazards flagged · concerns raised") with 3 rows.
      - Columns: Hazard, Raised by, Title, Status.
      - Mainline's rows come first, because functionality outranks the rest.
      - Raised by reads `Mainline · Functionality`.
      - Status reads `Open`.
    - `shows the detail on demand`: each row's detail is in a `<details>` element whose summary is the title.
    - `renders hazard and evidence text as text`: a title of `<img src=x onerror=alert(1)>` appears as literal text, and `container.querySelector("img")` is null.
    - `a hazard citing evidence that does not exist still renders`: a ref `E9` with `hasEvidence: false` renders `E9` as plain text, not a button.
    - `opens cited evidence`: clicking the `E1` button calls `onShowEvidence("mainline-sweep-0","E1")`.
    - `says when nothing is flagged`: "No hazards flagged on this step."
  - `Evidence.test.tsx`:
    - `shows each item inline`: it fetches `/api/runs/r1/agents/mainline-sweep-0/evidence`. Each item renders its id, title, kind, and input and output in `<pre>`.
    - `focuses the cited item`: with `focusId="E2"`, the E2 item has `id="evidence-mainline-sweep-0-E2"` and receives focus.
    - `404 says no evidence was recorded`.
    - `401 signs out`, as in `Transcript`.
  - `RunView.test.tsx`:
    - `header shows the real base branch`: `feature/x → release · head abc1234` for `baseRef: "release"`.
    - `shows six patrol cards at phone width`: six cards are rendered, and none overflows. Assert the class `patrol-grid` and that each card is a list item.
- [ ] **Step 2: Run** `npx vitest run --project dashboard`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - Render `HazardsTable` under "Patrol on this step". Below it, an "Evidence · requests and results" section shows `Evidence` for the picked card's agent, or for the agent whose evidence was last opened from the table, when `hasEvidence` is true.
  - Sort functionality hazards first, then by roster order.
  - Hazard detail and evidence text are `<pre>`/text nodes only.
  - Add `HAZARD_STATUS_LABELS = { open: "Open" }`.
  - The patrol grid wraps to one column under 480 px.
  - `dashboard/CLAUDE.md` gains a line each for the hazards table and evidence.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`, then `npm run build`. Expect PASS. Take a 390 px and a 1280 px screenshot of a fixture run with six agents and three hazards, using Playwright with Chromium at `/opt/pw-browsers/chromium` against `vite preview`. Answer `/api/*` with `page.route` fixtures and stub `WebSocket` with an init script. Report the paths in the scratchpad; do not commit them.
- [ ] **Step 5: Commit**: `basetobase: hazards table, inline evidence, real base branch`.

### Task 7: Deploy and the M2 smoke test (owner)

**Files:** none (owner actions), plus any fix found.

- [ ] **Step 1: Owner** merges M2 to `main`, then runs `cd basetobase && npm run deploy`. There are no new bindings or secrets: `EVIDENCE` reuses the KV namespace id.
- [ ] **Step 2: Owner** opens a small backend PR that adds or changes a Go endpoint. Expected:
  - six patrol cards (Granite Chief, Gold Coast, Summit Six, KT-22, Mainline, Corduroy) start within 10 s;
  - six `basetobase-agent` jobs run in parallel;
  - every card ends clear, hazards or error;
  - the run shows *Swept*, with a Conditions report of `6 of 6 patrollers in`.
- [ ] **Step 3: Owner** checks the hazards table and the evidence:
  - each hazard row opens its detail;
  - cited evidence opens inline;
  - Mainline's evidence shows its curl requests and responses;
  - KT-22's evidence shows its attacks;
  - each card's "Full transcript" opens.
- [ ] **Step 4: Owner** checks the budget in the Cloudflare dashboard:
  - **Durable Objects:** rows written for the day stay under about 3k for that one PR.
  - **KV:** shows at most 12 writes.
