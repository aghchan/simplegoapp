# Review phases by config (§1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `enabledRoles` with ordered `reviewStages` (plus a validated `designRoles`), run a
PR's patrol stage by stage with `waiting` and `skipped` agents, and show the stages on the dashboard.
The shipped review stays one stage, so no PR's review changes yet.

**Architecture:** Config validation lives in `shared/src/config.ts`. Every stage decision is in the
pure run machine (`dispatch/src/run/machine.ts`): `passes` judges an agent, and `advanceStages`
releases, holds or skips later stages after each verdict, failure, retry and bypass. The machine
hands the dashboard `stage`, `releasedAt` and `skippedFor` on each agent, so the dashboard renders
stages and next actions without judging pass or fail.

**Tech Stack:** TypeScript (erasable only, Node ≥22.18 type stripping), Cloudflare Workers and
Durable Objects, vitest with `@cloudflare/vitest-plugin`, React with Testing Library, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-11-staged-review-design.md` (§1 of its Delivery). Read
"Fit with existing features" and "How we'll know it works" before any task; this plan names the
decisions, and the spec holds the reasons.

## Global Constraints

- Shipped `reviewStages` is `[["granite-chief", "mainline"]]`. Shipped `designRoles` is all eight
  specialists in roster order: `["granite-chief", "gold-coast", "summit-six", "kt-22", "mainline",
  "corduroy", "magic-carpet", "bluebird"]`.
- Pass or fail is decided only by `passes(s, agent)` in machine.ts. `reviewOutcome` and
  `advanceStages` call it; nothing else (the dashboard included) decides pass or fail.
- Run logic stays pure in machine.ts: transitions return `{ state, effects }`; RunDO only persists
  and executes effects.
- Relative imports with `.ts` extensions. Erasable TS only (no enums, no namespaces, no parameter
  properties).
- Dependency changes, if any: `npx -y npm@11 install …` (none are expected).
- Status words and button labels exactly as the spec writes them: "Waiting", "Skipped",
  `Retry the failed patroller`, `Retry the N failed patrollers`, `Bypass design (emergency)`.
- Commits end with the session's attribution lines; no model identifier anywhere.
- All commands run from `basetobase/` unless a step says otherwise.

## Review Focus

1. **A run stored before the deploy** (agents without `stage`, any of today's statuses) gets a
   verdict, failure, retry or bypass after it: it must behave exactly as today, one stage, with no
   `waiting` or `skipped` agent appearing. Test in Task 3.
2. **Every stage emptied by the panel filter** (a multi-stage config whose roles cover none of the
   PR's panels): the run reads `none` and dispatches nothing, as a one-stage run does today. Test in
   Task 2.
3. **A stop or merge right after a release, before the released job's brief**: the released agent
   becomes `stopped`, and no cancel effect is made for it (it has no Actions run yet). Test in Task 3.
4. **Granite Chief in the last stage** (e.g. `[["mainline"], ["granite-chief"]]`): its
   missing-design hazard is bypassed on a swept run with nothing later to release, so the bypass
   raises `checkReposts` by exactly 1, keeps the run swept and reads `clear`. Test in Task 4.
5. **A selected Waiting card whose run is then stopped**: the card turns Stopped and its Debug pane
   returns to today's markup (transcript button, job link, transcript hint), with no stage hint.
   Test in Task 6.

---

## File Structure

| File | Change |
|---|---|
| `basetobase/config/basetobase.json` | `enabledRoles` → `reviewStages`, add `designRoles` |
| `basetobase/shared/src/config.ts` | validate both keys, refuse `enabledRoles`; `withEnabledRoles` → `withReviewRoles` |
| `basetobase/shared/src/types.ts` | `AgentStatus` + `waiting`, `skipped`; `AgentSnapshot` + `stage?`, `releasedAt?`, `skippedFor?` |
| `basetobase/shared/src/labels.ts` | `AGENT_STATUS_LABELS` + two labels |
| `basetobase/dispatch/src/env.ts`, `dispatch/vitest.config.ts`, `dispatch/src/run/do.ts` | `REVIEW_ROLES` |
| `basetobase/dispatch/src/run/machine.ts` | stages, `passes`, `advanceStages`, reopen helper, tally and titles |
| `basetobase/dispatch/test/seed.ts` | `addAgent`; `addGraniteChief` calls it |
| `basetobase/dashboard/src/components/PatrolCards.tsx`, `StepDetail.tsx`, `PipelineRow.tsx`, `theme.css` | stage sections, cards, Debug hint, row text |
| Tests | `shared/test/config.test.ts`, `dispatch/test/machine.test.ts`, `do.test.ts`, `routes-agent.test.ts`, `routes-api.test.ts`, `forwarder/test/run.test.ts`, `dashboard/test/RunView.test.tsx`, `PipelineRow.test.tsx` |
| Docs | `basetobase/CLAUDE.md`, `.basetobase/CLAUDE.md:3`, `basetobase/e2e/CLAUDE.md:9`, `basetobase/dashboard/CLAUDE.md` |

---

### Task 1: Config keys, the rename, and the two new statuses

**Files:**
- Modify: `basetobase/config/basetobase.json:110`, `basetobase/shared/src/config.ts:32-86`
- Modify: `basetobase/shared/src/types.ts:15-24` and `:57-77`, `basetobase/shared/src/labels.ts:48`
- Modify: `basetobase/dashboard/src/components/PatrolCards.tsx:6`
- Modify: `basetobase/dispatch/src/env.ts:17-18`, `dispatch/vitest.config.ts:21`, `dispatch/src/run/do.ts:2,92`, `dispatch/src/run/machine.ts:84-88`
- Modify: `basetobase/dispatch/test/machine.test.ts:5,57,84,88,350,383,419`, `dispatch/test/seed.ts:9`
- Test: `basetobase/shared/test/config.test.ts`, `basetobase/forwarder/test/run.test.ts`

**Interfaces:**
- Produces: `B2BConfig.reviewStages: RoleId[][]`, `B2BConfig.designRoles: RoleId[]` (no
  `enabledRoles`); `withReviewRoles(cfg: B2BConfig, csv: string | undefined): B2BConfig`;
  `Env.REVIEW_ROLES?: string`; `AgentStatus` gains `"waiting" | "skipped"`; `AgentSnapshot` gains
  `stage?: number`, `releasedAt?: number`, `skippedFor?: { stage: number; canPass: boolean }`.

- [ ] **Step 1: Rewrite the config tests**

In `shared/test/config.test.ts`, replace the `enabledRoles` tests and the `withEnabledRoles` block:
- `it("ships one review stage of Granite Chief and Mainline")`:
  `expect(config.reviewStages).toEqual([["granite-chief", "mainline"]])`.
- `it("ships every specialist in the design phase")`: `config.designRoles` equals the eight ids in
  Global Constraints.
- `it.each` refusals, each `expect(() => loadConfig({ ...raw, <key>: <value> })).toThrow(<regex>)`:
  `reviewStages: [["nope"]]` → `/reviewStages\[0\]\[0\]/`; `reviewStages: [["groomer"]]` →
  `/reviewStages\[0\]\[0\]/`; `reviewStages: [["mainline"], ["mainline"]]` → `/reviewStages\[1\]\[0\]/`;
  `reviewStages: [["mainline"], []]` → `/reviewStages\[1\]/`; `reviewStages: []` → `/reviewStages/`;
  `reviewStages: ["granite-chief", "mainline"]` → `/reviewStages\[0\]/`; `designRoles: [...eight,
  "nope"]` → `/designRoles\[8\]/`; `designRoles` with `"groomer"` → `/designRoles/`; `designRoles`
  with a duplicate → `/designRoles/`; `designRoles` without `"kt-22"` → `/designRoles/`; `designRoles`
  without `"granite-chief"` → `/designRoles/`.
- `it("refuses a leftover enabledRoles")`: `loadConfig({ ...raw, enabledRoles: ["mainline"] })`
  throws `/enabledRoles/`.
- `describe("withReviewRoles")`: the same cases the old block had, against `reviewStages`:
  `"mainline"` → `[["mainline"]]`; `"mainline,granite-chief"` → `[["mainline", "granite-chief"]]`;
  unset and `""` return `config` itself (`toBe`); only `reviewStages` changes; `config` is not
  mutated; `"nope"` throws `/REVIEW_ROLES\[0\]/`, `"mainline,nope"` throws `/REVIEW_ROLES\[1\]/`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project shared shared/test/config.test.ts`
Expected: FAIL (no `reviewStages`, no `withReviewRoles`).

- [ ] **Step 3: Implement the config**

`basetobase.json`: replace `"enabledRoles"` with `"reviewStages": [["granite-chief", "mainline"]]`
and add `"designRoles"` (Global Constraints). In `config.ts`, `loadConfig` fails with
`enabledRoles is replaced by reviewStages` when the raw object has an `enabledRoles` key; validates
`reviewStages` (an array of non-empty arrays, at least one; each id in the roster and not `groomer`;
no id twice across stages; error paths `reviewStages[i]` and `reviewStages[i][j]`) and `designRoles`
(roster ids, not `groomer`, no duplicates, holding `granite-chief` and `kt-22`; paths
`designRoles[i]`). Wording of the messages is free. Rename `withEnabledRoles` to `withReviewRoles`:
it returns `{ ...cfg, reviewStages: [roles] }`, error path `REVIEW_ROLES[i]`, and its comment names
`REVIEW_ROLES`.

- [ ] **Step 4: Rename every reader**

`env.ts`: `REVIEW_ROLES?: string` with its test-only comment naming `withReviewRoles`.
`vitest.config.ts`: `REVIEW_ROLES: "mainline"`. `do.ts`: `withReviewRoles(config, this.env.REVIEW_ROLES)`.
`machine.ts` `createRun`: filter on `cfg.reviewStages.flat().includes(entry.id)` for now; Task 2
replaces it with stages. `machine.test.ts`: `withReviewRoles`, and each hand-built config uses
`reviewStages` with its old list as one stage (`PATROL`, `SQUAD`, :350, :419); the test at :383
compares with `config.reviewStages.flat()`. `seed.ts:9` comment: `REVIEW_ROLES`.

- [ ] **Step 5: Add the statuses and fields**

`types.ts`: `AgentStatus` adds `"waiting"` and `"skipped"` with a comment (a later stage's agent not
yet dispatched; an agent whose earlier stage is in and did not pass). `AgentSnapshot` adds
`stage?: number` (position among the run's stages, 0 first; absent reads as 0),
`releasedAt?: number` (epoch ms its stage was released) and
`skippedFor?: { stage: number; canPass: boolean }` (set only on a skipped agent). `labels.ts`:
`waiting: "Waiting"`, `skipped: "Skipped"`. `PatrolCards.tsx` `AGENT_TONES`: both `"idle"`.

- [ ] **Step 6: Pin the forwarder's exits for the new statuses**

`forwarder/test/run.test.ts`: the brief table (`is refused with the agent %s in Dispatch`, :383)
and the failure-report table (:674) each gain `["waiting", 1]` and `["skipped", 1]`; the retried
verdict table (:644) gains `["valid", "waiting", 1]` and `["valid", "skipped", 1]`.
`GREEN_WHEN_UNWANTED` (`forwarder/src/run.ts:44`) stays `["clear", "stopped"]`.

- [ ] **Step 7: Run the whole suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS, including every pre-existing machine and RunDO test.

- [ ] **Step 8: Commit**

```bash
git add -A basetobase && git commit -m "basetobase: reviewStages and designRoles replace enabledRoles"
```

---

### Task 2: Stages at run start, and the statuses in the machine's predicates

**Files:**
- Modify: `basetobase/dispatch/src/run/machine.ts` (`createRun` :74, `isTerminal` :597, `liveAgent` :603, `deadlinesOf` :611, `reviewOutcome` :529, `retryAgents` rebuild :318)
- Test: `basetobase/dispatch/test/machine.test.ts`

**Interfaces:**
- Consumes: Task 1's types and `reviewStages`.
- Produces (module-private in machine.ts unless noted): `stageOf(agent: AgentSnapshot): number`
  (`agent.stage ?? 0`); `passes(s: RunState, agent: AgentSnapshot): boolean`; `stagesOf(s: RunState):
  AgentSnapshot[][]` (the sweep's agents grouped by `stageOf`, in stage order). Test fixtures, in
  machine.test.ts: `STAGED: B2BConfig = { ...config, reviewStages: [["granite-chief", "mainline"],
  ["corduroy"]] }`, `THREE: B2BConfig` with `[["granite-chief"], ["mainline"], ["corduroy"]]`,
  `const CORDUROY = "corduroy-sweep-0"`.

- [ ] **Step 1: Write the failing tests**

In `describe("createRun")`:
- `it("starts the first stage queued and later stages waiting, with no dispatch for them")`:
  `createRun(pr, "r1", t, STAGED, …)` gives agents `[GRANITE, ID, CORDUROY]` with stages
  `[0, 0, 1]` and statuses `["queued", "queued", "waiting"]`; dispatch effects for `GRANITE` and
  `ID` only; `nonces` has all three; `nextAlarm(state)` equals the queued agents' "never dispatched"
  time, never one for Corduroy (`deadlinesOf` gives a waiting agent none).
- `it("orders agents by stage, then roster, whatever order a stage lists its roles")`: with
  `reviewStages: [["mainline", "granite-chief"], ["corduroy"]]`, ids are `[GRANITE, ID, CORDUROY]`.
- `it("drops a stage the panel filter empties, and renumbers the rest")`: with
  `[["magic-carpet", "bluebird"], ["corduroy"]]` and a backend PR, Corduroy is the only agent, at
  stage 0, `queued`, with one dispatch effect. With `[["granite-chief"], ["magic-carpet"],
  ["corduroy"]]`, Granite Chief is stage 0 `queued` and Corduroy stage 1 `waiting`.
- `it("reads none when the panel filter empties every stage")` (Review Focus 2): with
  `[["magic-carpet"], ["bluebird"]]` on a backend PR, the run is `swept`, outcome `none`, no
  dispatch effect.

New `describe("a waiting agent")` on a `STAGED` run:
- `it.each` over `onDispatched`, `onBriefed`, `onEvents`, `onVerdict`, `onFailure` for `CORDUROY`:
  each returns the state unchanged (`toBe(state)`), so `acceptsReports` will answer 410.
- `it("is never failed by the watchdog")`: `onTick(state, CREATED_AT + JOB_START_MS * 10)` leaves
  Corduroy `waiting`.
- The same five calls for a skipped agent: build the state by setting Corduroy's status to
  `skipped` by hand; each is unchanged.
- In `describe("stopRun")` and `describe("landRun")`: `it("stops a waiting agent and leaves a
  skipped one as it is")`, with no cancel effect for either.

In `describe("reviewOutcome")`:
- `it("never passes a skipped agent")`: a hand-built swept run whose only non-passing agent is
  `skipped` reads `failed`.
- `it("passes a hazards verdict whose every hazard was waived")` and `it("never passes a hazards
  verdict that lists none")` (both today's behaviour, now through `passes`).

In `describe("retryAgents")`: `it("keeps a retried agent's stage and drops its releasedAt")`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project dispatch dispatch/test/machine.test.ts`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement**

- `createRun`: for each stage of `cfg.reviewStages`, the roster entries in it whose panels match,
  in roster order; drop empty stages; agent `stage` is the index among those kept. Stage 0 agents
  `queued`, later ones `waiting`. Nonces for every agent; dispatch effects for stage 0 only.
- `isTerminal`: adds `skipped`. `liveAgent`: also `undefined` for `waiting`. `deadlinesOf`: `[]` for
  `waiting`; the "never dispatched" clock reads `agent.retriedAt ?? agent.releasedAt ?? createdAt`.
- `passes(s, agent)`: `status === "clear"`, or `status === "hazards"` with a non-empty `hazards`
  and `openHazards(s, agent).length === 0`.
- `reviewOutcome`: keep the `failed` and `pending` checks; then `hazards` when any agent has status
  `hazards` and does not pass; then `failed` when any agent does not pass (the skipped-only guard);
  else `none` or `clear` as today.
- `retryAgents` rebuild keeps `stage` (only when the agent had one) and never copies `releasedAt`.

- [ ] **Step 4: Run the machine tests**

Run: `npx vitest run --project dispatch dispatch/test/machine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A basetobase && git commit -m "basetobase: runs start their later review stages waiting"
```

---

### Task 3: `advanceStages`, skips and releases, and what the check says

**Files:**
- Modify: `basetobase/dispatch/src/run/machine.ts` (`closeSweepIfDone` :788, `conditionsReport` :726, `failureTitle` :755, `checkRunOf` in-progress title)
- Test: `basetobase/dispatch/test/machine.test.ts`

**Interfaces:**
- Consumes: Task 2's `stageOf`, `passes`, `stagesOf`.
- Produces (module-private): `advanceStages(s: RunState, now: number): Transition` — effects are
  one `{ type: "dispatch", agentId }` per released agent and nothing else; `currentStage(s:
  RunState): number | undefined` (index of the first stage that has not passed);
  `canPassStage(s: RunState, agents: AgentSnapshot[]): boolean`.

- [ ] **Step 1: Write the failing tests**

New `describe("review stages")` on `STAGED` and `THREE` runs, driven through `onBriefed`,
`onVerdict`, `onFailure`, `onTick`:
- `it("releases stage 2 once stage 1 passes")`: both stage-1 agents clear → Corduroy `queued`,
  `releasedAt` = the verdict's `now`, exactly one `{ type: "dispatch", agentId: CORDUROY }`, run
  `on_the_hill`, `checkRunOf(state, URL).output.title` is `"Red Dog Face · patrol sweep · stage 2 of
  2"`, and before the release it was `"… · stage 1 of 2"`.
- `it("holds stage 2 only once every stage-1 agent is in")`, both report orders: the first stage-1
  hazards verdict leaves Corduroy `waiting` with no summary and the run `on_the_hill`; the second
  (clear) skips Corduroy with summary `Skipped: stage 1 did not pass (Granite Chief).` and closes the
  sweep in that transition (step `done`, run `swept`, outcome `hazards`).
- `it("skips stage 2 behind a failed agent")`: outcome `failed`, summary names Mainline.
- `it("holds stage 2 behind a hazards verdict that lists none")`.
- `it("keeps a stalled stage-1 agent's stage running")`: a stall leaves Corduroy `waiting`; the
  timeout then skips it.
- `it("sets skippedFor on a skipped agent")`: `{ stage: 0, canPass }` with `canPass` true for: a
  failed agent; Granite Chief's lone `No approved design` hazard (no bypass yet); both. False for:
  any other hazard; a `hazards` verdict listing none; two missing-design hazards; a failed agent
  beside another hazard.
- `it("releases a stage once, whatever repeats")`: a repeated verdict or events for a stage-1 agent
  after the release adds no dispatch effect.
- `it("runs the never-dispatched clock from releasedAt")`: `onTick` at `releasedAt + STALL_MS` fails
  a released Corduroy with `never dispatched`, and not one tick earlier.
- `it("skips stage 3 when stage 2 fails, and releases it only after stages 1 and 2 pass")` (`THREE`).
- `it("tallies skipped agents and leaves them out of the in count")`: the Conditions report holds
  `2 of 3 patrollers in · 1 hazard · 0 failed · 1 skipped`, and a one-stage run's tally is unchanged.
- `it("falls back to Run failed")`: `failureTitle` via `checkRunOf` on a hand-built swept run whose
  only non-passing agent is skipped is `Run failed`.
- `it("keeps a one-stage run's check title as today")`: `"Red Dog Face · patrol sweep"`.
- Review Focus 1: `it("treats a run stored before stages as one stage")`: a `PATROL` run with
  `stage` deleted from every agent: a hazards then a clear verdict close the sweep exactly as today
  (same notes, same effects, no `skipped` agent).
- Review Focus 3: `it("stops a released agent that has no job yet without a cancel")`: release
  Corduroy, then `stopRun` → Corduroy `stopped`, no `{ type: "cancel" }` effect for it.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project dispatch dispatch/test/machine.test.ts`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement `advanceStages` and wire it in**

Follow the spec's four stage states ("Fit with existing features › Run machine"). A stage is
unreleased when its agents are all `waiting` or all `skipped`; running when released and an agent
is not in (`isTerminal`); held when all in and one does not `passes`; passed otherwise. Act on the
current stage only:
- unreleased → its agents `queued`, `releasedAt: now`, `summary` and `skippedFor` removed, one
  dispatch effect each; later `skipped` agents → `waiting` with `summary` and `skippedFor` removed;
- running → later `skipped` agents → `waiting`, same removal;
- held → every later agent `skipped`, `summary` `Skipped: stage ${k + 1} did not pass (${names}).`
  (names from `s.agentNames` of the held stage's non-passing agents, joined `", "`), `skippedFor:
  { stage: k, canPass: canPassStage(s, heldAgents) }`; no `finishedAt`.

`canPassStage`: every non-passing agent is `error`, or `passes` it on
`{ ...s, designBypassedAt: s.designBypassedAt ?? now }`. When nothing changes, return the state
object as given.

`closeSweepIfDone(s, now, earned)` runs `advanceStages` first and puts its effects after `earned`.
`conditionsReport`: `reported` excludes `skipped` as it excludes `stopped`; append ` · N skipped`
when N > 0. `failureTitle`: return `Run failed` whenever the hazards part and the failed-agent part
are both empty. `checkRunOf` pending title: add ` · stage ${k + 1} of ${n}` when the run has more
than one stage (`n = stagesOf(s).length`, `k = currentStage(s)`).

- [ ] **Step 4: Run the machine tests**

Run: `npx vitest run --project dispatch dispatch/test/machine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A basetobase && git commit -m "basetobase: later review stages follow the first that has not passed"
```

---

### Task 4: Retry and bypass through the stages

**Files:**
- Modify: `basetobase/dispatch/src/run/machine.ts` (`retryAgents` :304-:350, `bypassDesign` :381-:404)
- Test: `basetobase/dispatch/test/machine.test.ts`

**Interfaces:**
- Consumes: Task 3's `advanceStages`.
- Produces (module-private): `reopenSweep(s: RunState, steps: ReadonlySet<StepId>, now: number):
  RunState` — each named step back to `{ id, status: "active", startedAt: step.startedAt ?? now,
  notes: [] }`, run `on_the_hill`, `checkReposts` + 1, `updatedAt: now`.

- [ ] **Step 1: Write the failing tests**

In `describe("retryAgents")` on `STAGED`:
- `it("puts the stages a retried agent had held back to waiting")`: Mainline failed, Corduroy
  skipped; the retry dispatches Mainline only and leaves Corduroy `waiting` with no `summary` and no
  `skippedFor`; a second failure skips it again.
- `it("releases the held stage once the retried agent clears")`.
- `it("never retries a waiting or a skipped agent")`: `retryAgents` by `{ agentId: CORDUROY }` and by
  `{ step: "sweep" }` with only skipped/waiting agents is unchanged, with no dispatch.
- The existing retry tests pass unchanged (the reopen moved into `reopenSweep`).

In `describe("bypassDesign")` on `STAGED`:
- `it("releases stage 2 on a swept run and reopens the sweep once")`: Granite Chief's missing-design
  hazard and Mainline clear → swept, Corduroy skipped; the bypass gives Corduroy `queued` with
  `releasedAt` and no `summary`, one dispatch effect, sweep step `active` with `notes: []` and no
  `finishedAt`, run `on_the_hill`, `checkReposts` one more than before, and no `Skipped:` line in
  `conditionsReport` or `checkRunOf(...).output.summary`.
- `it("raises checkReposts once and rewrites the report when it releases nothing")`: a failed
  Mainline still holds stage 1; the run stays swept and the report's Corduroy line names Mainline
  alone.
- `it("waits for the running stage on an open sweep")`: Granite Chief's hazard in, Mainline running:
  `checkReposts` + 1, no report rewrite, Corduroy `waiting`, run `on_the_hill`. Then Mainline clear
  dispatches Corduroy once with the title `· stage 2 of 2`; with Mainline hazards instead, Corduroy
  is `skipped` and never dispatched.
- `it("releases stage 2 and puts stage 3 back to waiting")` (`THREE` with Granite Chief alone in
  stage 1 held).
- Review Focus 4: `it("bypasses Granite Chief in the last stage")` with `[["mainline"],
  ["granite-chief"]]`: `checkReposts` + 1, run stays `swept`, outcome `clear`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project dispatch dispatch/test/machine.test.ts`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement**

`retryAgents`: replace its steps/status/`checkReposts` block with `reopenSweep`, then run
`advanceStages` and append its effects. `bypassDesign`: set `designBypassedAt`, run
`advanceStages`; when it made a dispatch effect and the run was `swept`, apply `reopenSweep` (its
bump is the bypass's only one); otherwise add the bypass's own `checkReposts` + 1 and, for a closed
sweep, rewrite the report after `advanceStages`. Effects: the log, `index`, the dispatches,
`broadcast`, `check`.

- [ ] **Step 4: Run the whole dispatch suite**

Run: `npx vitest run --project dispatch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A basetobase && git commit -m "basetobase: retry and bypass release and hold review stages"
```

---

### Task 5: RunDO and routes with a staged run

**Files:**
- Modify: `basetobase/dispatch/test/seed.ts`
- Test: `basetobase/dispatch/test/routes-agent.test.ts`, `routes-api.test.ts`, `do.test.ts`

**Interfaces:**
- Produces: `addAgent(stub: ReturnType<typeof runStub>, agent: AgentSnapshot, name: string):
  Promise<void>` in seed.ts (the spec's signature): stores the agent, the nonce
  `` `${agent.id}-nonce` `` and its roster name in the stored state. `addGraniteChief(stub, over)`
  becomes a call to it (no test reads its old `"granite-nonce"`).

- [ ] **Step 1: Write the tests**

- `routes-agent.test.ts`: `it.each` over brief, events, verdict and failure, for Corduroy added at
  `stage: 1` as `waiting` and as `skipped`: 410 `{ error: "no longer wanted", agent: <status> }`,
  state unchanged.
- `routes-api.test.ts`: retry of a skipped Corduroy by id → 409 `{ error: "nothing to retry" }`.
- `do.test.ts`: `it("releases a waiting agent when the stage before it passes")`: start a run, add
  Corduroy `waiting` at stage 1, brief Mainline and send a clear verdict: exactly one new workflow
  dispatch, for Corduroy's id, and the stored Corduroy is `queued` with a `releasedAt`.

- [ ] **Step 2: Run them**

Run: `npx vitest run --project dispatch`
Expected: PASS once `addAgent` exists (the behaviour is Tasks 2-4's); a failure here is a real
defect to fix in machine.ts or do.ts, not in the test.

- [ ] **Step 3: Commit**

```bash
git add -A basetobase && git commit -m "basetobase: route and RunDO tests for waiting and skipped agents"
```

---

### Task 6: Dashboard stage sections, cards, Debug hint and pipeline row

**Files:**
- Modify: `basetobase/dashboard/src/components/PatrolCards.tsx`, `StepDetail.tsx`, `PipelineRow.tsx:50`, `basetobase/dashboard/src/theme.css`
- Test: `basetobase/dashboard/test/RunView.test.tsx`, `PipelineRow.test.tsx`

**Interfaces:**
- Consumes: `AgentSnapshot.stage`, `skippedFor`, statuses `waiting` and `skipped`.
- Produces (StepDetail.tsx): `retryLabel(count: number): string` (`Retry the failed patroller` for
  1, `Retry the ${count} failed patrollers` otherwise), used by the step's retry button and the hint;
  `const BYPASS_LABEL = "Bypass design (emergency)"`, used by the bypass button and the hint.

- [ ] **Step 1: Write the failing tests**

In `RunView.test.tsx`, a new `describe("review stages")` on a run with Granite Chief and Mainline
at stage 0 and Corduroy at stage 1:
- `it("shows a section per stage under the one patrol heading")`: one `h3` "Patrol on this step";
  two `section` elements named by `h4.section-title.section-title-sub` headings, `Stage 1` and
  `Stage 2` with ` · after stage 1 passes` in a `.section-plain` span; a one-stage run has no `h4`.
- `it("marks waiting and skipped cards")`: card text `Waiting` / `Skipped`, class
  `patrol-card-waiting` / `patrol-card-skipped`.
- `it("keeps the selected card when it goes from Waiting to Queued")` (rerender with the new run).
- `it("explains a waiting card in its Debug pane")`: `p.hint` `Starts when stage 1 passes.`; no
  `Full transcript` button, no `GitHub Actions job` link, no retry button and no `No transcript
  uploaded yet.`, even with `hasTranscript: true`.
- `it.each` for the skipped hint, Corduroy `skipped` with summary `Skipped: stage 1 did not pass
  (…).`, each `p.hint` equal to the summary, a space, then:
  1. run `stopped`, `landed` and `failed`: nothing after the summary;
  2. `skippedFor.canPass` false: `Stage 1 cannot pass on this run. Push a fix, and a new run starts
     at stage 1.`;
  3. a failed Mainline and Granite Chief's missing-design hazard: `Stage 1 can still pass: use
     "Retry the failed patroller" and "Bypass design (emergency)" at the top of this step.`;
  4. a failed Mainline only: `Stage 1 can still pass: use "Retry the failed patroller" at the top of
     this step.`, and with two failed agents `"Retry the 2 failed patrollers"`;
  5. the missing-design hazard only: `Stage 1 can still pass: use "Bypass design (emergency)" at
     the top of this step.`
- Review Focus 5: `it("gives a stopped card today's Debug pane")`: a selected waiting Corduroy whose
  run is rerendered stopped shows the transcript button and job link again and no stage hint.

In `PipelineRow.test.tsx`: `it.each` for a done sweep: `hazards` with one skipped →
`hazards flagged · 1 skipped`; `failed` with one error and one skipped → `1 failed · 1 skipped`;
`failed` with no error or stopped agent → `failed`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project dashboard`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement**

- `PatrolCards`: add `patrol-card-${status}` to the class for `waiting` and `skipped`.
- `StepDetail`: group the step's agents by `agent.stage ?? 0`; with more than one stage, render a
  `section` per stage (aria-labelledby its `h4`) holding a `PatrolCards` of its agents, all sharing
  one selection; with one stage, today's markup. Give `DebugPanel` an optional `hint: string`; when
  set, it renders the heading, the name line and `<p className="hint">{hint}</p>` and nothing else.
  Compute the hint only for `waiting` and `skipped` agents, choosing the skipped sentence in the
  spec's order from the run's status, `skippedFor`, `failed.length > 0` and `canBypass` — never from
  agent verdicts. Use `retryLabel(failed.length)` and `BYPASS_LABEL` for both the buttons and the
  sentences.
- `PipelineRow` `outcomeText`: append ` · ${n} skipped` to `hazards flagged` and `N failed` when the
  step has skipped agents; `failed` alone when no agent failed or stopped.
- `theme.css`: `.section-title-sub { font-size: 13px; }`, `.section-title-sub .section-plain {
  font-size: 12px; }`, `.patrol-stages { display: flex; flex-direction: column; gap: 12px; }`,
  `.patrol-stage { display: flex; flex-direction: column; gap: 8px; }`, and `.patrol-card-waiting,
  .patrol-card-skipped { background: #f5f8fb; }`.

- [ ] **Step 4: Run the dashboard tests and build**

Run: `npx vitest run --project dashboard && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A basetobase && git commit -m "basetobase: dashboard shows review stages and why a stage was skipped"
```

---

### Task 7: Docs, and the branch green end to end

**Files:**
- Modify: `basetobase/CLAUDE.md:17-18`, `.basetobase/CLAUDE.md:3`, `basetobase/e2e/CLAUDE.md:9`, `basetobase/dashboard/CLAUDE.md`

- [ ] **Step 1: Update the docs**

- `basetobase/CLAUDE.md` Patrol line: `reviewStages` (`[["granite-chief","mainline"]]`), stages in
  order, a stage released only once every earlier one passes, `waiting` and `skipped`, `skippedFor`,
  `advanceStages` and `passes` as the one pass predicate; `designRoles` validated here and read by
  §3's readers. The `ENABLED_ROLES` line becomes `REVIEW_ROLES` / `withReviewRoles`, pinning one
  stage, plus `addAgent` beside `addGraniteChief`.
- `.basetobase/CLAUDE.md:3`: one template per role in `reviewStages`.
- `e2e/CLAUDE.md:9`: `REVIEW_ROLES` for `ENABLED_ROLES`.
- `dashboard/CLAUDE.md`: stage sections, Waiting and Skipped cards and their Debug hint; the
  dashboard takes a skipped card's next action from `skippedFor` and judges no pass or fail;
  `retryLabel` and `BYPASS_LABEL` shared by the buttons and the hint.

- [ ] **Step 2: Verify everything**

Run: `npm run typecheck && npm test && npm run e2e`
Expected: all PASS. The shipped config is one stage, so every e2e spec passes unchanged.

Run from the repo root: `grep -rn "enabledRoles\|ENABLED_ROLES\|withEnabledRoles" basetobase .basetobase --include=*.ts --include=*.tsx --include=*.json --include=*.md | grep -v node_modules | grep -v /dist/`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add -A basetobase .basetobase && git commit -m "basetobase: docs for review stages"
```
