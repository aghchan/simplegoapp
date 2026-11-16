# Review phases by config, and Corduroy's code-hygiene review

- Size: full
- Status: in review
- From: the owner's conversation of 2026-11-11 (https://claude.ai/code/session_01M8sD8mMdENrvRWzJ5M9QMD)

## What we're building

Which specialists review in each phase becomes configuration, and Corduroy (Code quality) takes on
code hygiene in both phases.

- **Two phases, set in `basetobase/config/basetobase.json`:**
  - `designRoles`: the specialists whose lenses challenge a design before code
    (`standard:system-design`). Granite Chief (the design gate) and KT-22 (Security) are mandatory.
  - `reviewStages`: the specialists who review a pull request's code after implementation (the
    Base to Base patrol), as ordered stages, e.g. `[["granite-chief", "mainline"], ["corduroy"]]`.
    It replaces `enabledRoles`.
- **Stages run in order.** A stage's agents run together. The next stage starts only once every
  agent of every earlier stage is in and passing, the owner's design bypass included. When a stage
  ends with a hazard or a failed agent, the later stages' agents are `skipped` and never dispatched.
- **Corduroy reviews code hygiene:** following the codebase's own patterns, KISS, DRY, and no
  excess or redundant code. Every problem it finds blocks the merge.
  - A PR patrol template, `.basetobase/patrol/corduroy.md`, in a second stage after Granite Chief
    and Mainline, the end-to-end test.
  - A wider rule in its design lens, `plugins/standard/skills/system-design/lenses/corduroy.md`.
- For the owner, this repo, and every project cloned from it.

## Why

- Redundant or over-built code can merge today. Only Granite Chief (goal fit) and Mainline
  (functionality) review a PR's code; Corduroy reviews designs only, and no lens or patrol rule
  targets excess code.
- A hygiene review is worth its job only on code that works: the owner wants it run only when the
  end-to-end test passes.
- Which specialists review where is fixed in two places: `enabledRoles` for PRs, and the panel
  rules hardcoded in the system-design skill. The owner wants to choose some or all for the design
  phase and others for the post-implementation review.
- Success:
  - A PR whose stage 1 passes, and that has duplicated logic, a broken codebase pattern, a needless
    abstraction, dead code or any other hygiene problem, fails the *Base to Base* check on a
    Corduroy hazard citing file:line.
  - A PR whose stage 1 does not pass, a failed end-to-end test included, never dispatches Corduroy:
    its card reads Skipped and the check fails on stage 1's findings. A hygiene problem in it is
    found by the run that follows their fix.
  - Moving a specialist to another stage is an edit of one list, `reviewStages`. Adding one to the
    design phase, or dropping one from it, is an edit of one list, `designRoles`.
  - A design's panel follows `designRoles`: with a role dropped from it, the skill's panel and
    Granite Chief's design-PR rules both leave that lens out, and Granite Chief and KT-22 stay on.

## Goals, non-goals, anti-goals

**Goals**
- `designRoles` and `reviewStages` in the config, read by the design skill and by the patrol.
- Ordered review stages, each gated on every earlier stage passing.
- Corduroy's hygiene rules in both phases; Corduroy in stage 2 of the shipped config.
- The dashboard shows a run's stages: a section per stage, Waiting and Skipped cards, and on a
  skipped card why its stage was skipped and what to do next. Done when the dashboard tests under
  "How we'll know it works" pass.

**Non-goals**
- A new roster role (owner: extend Corduroy's scope instead).
- A non-blocking "notes" field in the verdict contract: every problem Corduroy finds is a hazard.
- Turning on PR reviewers beyond Corduroy now; the config allows it later.
- A cost cap on Corduroy's jobs (owner).
- Enforcing a reviewer's tools in the runner (owner).
- Per-repository config for other projects patrolled from this Worker (part 3). Until then the
  Worker's bundled `reviewStages` reviews every patrolled PR, and a patrolled repo's own copy is
  ignored. `designRoles` is read from the repo's default branch because the design phase runs in
  that repo's sessions; in this repo both are the same file.
- A retention rule for finished runs' stored logs and index rows, which nothing deletes today
  (see Scaling): its own design, since it changes what the dashboard can show of an old run.
- The huddle and Groomer (M3).

**Anti-goals**
- A Corduroy hazard without evidence: file:line, and the rule or the duplicate it cites.
- A later stage spending a job on code whose earlier stage failed.
- A waiting agent timing out, or holding the check open forever, while an earlier stage runs.
- A skipped agent counting toward a pass.
- Pass or fail decided anywhere but one predicate, `passes`. `reviewOutcome` derives the outcome
  from it on read, and `advanceStages` uses it only to decide which agents to dispatch or skip.
- The design skill, Granite Chief's design-PR rules and the config disagreeing on who sits on a
  design panel.
- A design panel without Granite Chief or KT-22.

## Fit with existing features

**Config** (`basetobase/config/basetobase.json`, `basetobase/shared/src/config.ts`)
- `enabledRoles: RoleId[]` becomes `reviewStages: RoleId[][]`. Validation: each id in the roster
  and not `groomer`; a role at most once across all stages; no empty stage; at least one stage.
- New `designRoles: RoleId[]`: roster ids, not `groomer`, no duplicates, and holding
  `granite-chief` and `kt-22`. Shipped: all eight specialists, today's panel.
- `withEnabledRoles(cfg, csv)` and the test-only `ENABLED_ROLES` binding are renamed
  `withReviewRoles` and `REVIEW_ROLES`, and pin `reviewStages` to one stage of the listed roles.
  Every place that names them changes with them: `dispatch/src/run/do.ts:92`,
  `dispatch/src/env.ts:17-18`, the dispatch vitest binding (`dispatch/vitest.config.ts:21`,
  `"mainline"`), `dispatch/test/machine.test.ts:57`, `dispatch/test/seed.ts:9`. Their runs keep one
  Mainline agent, as now.
- Every reader of `enabledRoles` changes: `dispatch/src/run/machine.ts:87`,
  `shared/test/config.test.ts`, `dispatch/test/machine.test.ts` (fixtures `PATROL` and others).

**Run machine** (`basetobase/dispatch/src/run/machine.ts`)
- `AgentSnapshot` gains `stage: number`, its position among the run's own stages after the panel
  filter drops any emptied stage (0 for the first; the dashboard shows position + 1, and `stage k of
  n` counts the run's stages), and `releasedAt?: number`, epoch ms like `retriedAt`, set when its
  stage is released. Both reach the dashboard through `snapshotOf`. A stored agent without `stage`
  reads as stage 0, so runs open at deploy finish as one stage.
- `AgentStatus` (`shared/src/types.ts:15`) gains `waiting` (a later stage's agent, not yet
  dispatched) and `skipped` (an earlier stage is in and did not pass), and so does every exhaustive
  map of it: `AGENT_STATUS_LABELS` (`shared/src/labels.ts:48`, "Waiting" and "Skipped") and
  `AGENT_TONES` (`PatrolCards.tsx:6`, both `idle`).
- Code changes for the two statuses, each leaving every other status as it is today:
  - `isTerminal` (:597) counts `skipped`, not `waiting`.
  - `liveAgent` (:603) returns nothing for a `waiting` agent, so its callers refuse it:
    `onDispatched` (:156), `onEvents` (:169), `onBriefed` (:190), `onVerdict` (:206) and `onFailure`
    (:224), and through `onFailure` RunDO's `acceptsReports` (`do.ts:543`), which answers 410.
  - `deadlinesOf` (:611) returns no deadline for a `waiting` agent, so `onTick` (:248) never fails
    it and `nextAlarm` (:547) never wakes for it.
  - A waiting agent's nonce is made with the run's, as today, and leaves the RunDO only with its
    dispatch.
- `createRun` (:74) builds every stage's agents on the PR's panels; a stage left empty by the panel
  filter is dropped and the later ones renumbered. Stage 0 starts `queued` and is dispatched as now;
  later stages start `waiting`. A PR whose panels leave no agent at all reads `none`, as today.
- Agent order: stages in `reviewStages` order, and roster order within a stage, as today.
  `createRun` filters the roster for each stage (:84-:88), so the order in which a stage's list, or
  `REVIEW_ROLES`, names its roles does not matter, and the test `creates agents in roster order`
  stays. The `agents` array, the cards, the tab order and the dispatch order all follow it.
- A new step, `advanceStages`, runs first in `closeSweepIfDone` (:788), before `sweptState`, after
  every verdict, failure, retry and bypass. It makes the later stages follow the first stage that
  has not passed:
  - Passing is one predicate, `passes(s, agent)`, which `reviewOutcome` uses too: status `clear`,
    or `hazards` with a non-empty list whose every hazard the owner waived (`openHazards` empty).
    `error`, `stopped`, `stalled`, `skipped`, and a `hazards` verdict that lists none, never pass.
  - "In" is `isTerminal`. A stalled agent is not in: its stage holds the later ones `waiting` until
    it reports or times out into `error`.
  - A stage's agents are released, skipped and put back together, so a stage is in one of four
    states. **Unreleased:** its agents are all `waiting` or all `skipped`. **Running:** released,
    and an agent is not in. **Held:** released, every agent in, and one does not pass.
    **Passed:** released, every agent in and passing. A passed stage stays passed: a verdict is
    final, and a retry takes only `error` agents.
  - The **current stage** is the first that has not passed. It is the `k` of the check title, and
    `advanceStages` acts on its state alone; with every stage passed it does nothing.
    - **Unreleased** (every earlier stage has passed): it is released. Its agents become `queued`,
      get `releasedAt` and one dispatch effect each, and the sweep and the run stay open. Every
      later stage's `skipped` agents go back to `waiting`.
    - **Running:** every later stage's `skipped` agents go back to `waiting`. This is what a retry
      of a failed agent does to the stages it had held.
    - **Held:** every later stage's agents, `waiting` or `skipped`, are `skipped` with the summary
      `Skipped: stage k did not pass (<agent names>).`, naming the agents of stage k that do not
      pass now, and with `skippedFor` (below). Every agent is then terminal, so `sweptState` closes
      the sweep in the same transition.
  - `AgentSnapshot` gains `skippedFor?: { stage: number; canPass: boolean }`, set with the summary
    and only on a skipped agent, so the dashboard shows what to do next without judging pass or
    fail itself. `stage` is the held stage's position, 0 for the first as `AgentSnapshot.stage` is;
    the dashboard shows `stage + 1`, and the `k` of the machine's summary is `stage + 1` too.
    `canPass` says whether the owner can still
    turn that stage on this run: every agent of it that does not pass is a failed one (`error`),
    which a retry runs again, or would pass once the bypass is made, which is `passes` on the state
    with `designBypassedAt` set. A `hazards` verdict with any other open hazard, or with none
    listed, makes it false. It reaches the dashboard through `snapshotOf`.
  - A waiting or skipped agent has never run. The fields a skip adds are `summary` and
    `skippedFor`; it sets no `finishedAt`, which no reader of an agent uses. Both ways out of
    `skipped`, back to `waiting` and released to `queued`, drop both, so a released agent never
    carries a `Skipped:` line into `conditionsReport` or onto its card.
  - A release finds the run `swept` only when a bypass turns the stage that held it passing. The
    run then reopens through one helper, which `retryAgents` now calls in place of its own block
    (:338-:349): the released agents' steps back to `{ status: "active", startedAt, notes: [] }`,
    so the closed sweep's `finishedAt` and Conditions report go; the run back to `on_the_hill`; and
    `checkReposts` + 1 for a new check run, since a completed one cannot reopen. A release from an
    open run changes none of these.
  - Only an unreleased stage is released, and a released one is running, so a repeated verdict or
    event never dispatches an agent twice.
- `reviewOutcome` (:529) reads `passes` for every agent and keeps today's outcomes: a failed or
  stopped agent reads `failed`, a flagged one `hazards`. A `skipped` agent never passes. Skipped
  agents exist only behind a stage that is in and did not pass, which already gives `hazards` or
  `failed`; a run whose only non-passing agents are skipped cannot arise, and reads `failed` if it
  ever does, fail-closed.
- `retryAgents`' rebuild of a retried agent (:318) keeps `stage` with its id, role, step and round,
  so a retried stage-2 agent stays in stage 2. `releasedAt` is dropped: `retriedAt` runs its clock.
- `retryAgents` (:304) and `bypassDesign` (:381) end in `advanceStages`. A skipped or waiting agent
  is not retryable itself: `retryableAgents` (:294) takes only `error` agents, and the retry route
  answers 409 `nothing to retry` for one (`routes/api.ts:106`).
- `bypassDesign` sets `designBypassedAt`, then runs `advanceStages`, and one bypass raises
  `checkReposts` by exactly 1:
  - When that releases a stage, the reopen above makes the bump and clears the sweep's notes.
    `bypassDesign` adds neither its own bump nor its rewrite of the closed sweep's Conditions
    report (:389-:394); the report is written when the sweep closes again.
  - When it releases nothing (one stage, a failed agent or another hazard still holding the stage,
    or a sweep still open), `bypassDesign` does what it does today: its one bump, and for a closed
    sweep the report rewritten, now after `advanceStages` so it carries the skipped agents' fresh
    summaries.
- `deadlinesOf`: a released agent's "never dispatched" clock runs from `releasedAt`
  (`retriedAt ?? releasedAt ?? createdAt`).
- `conditionsReport` (:726): "in" excludes skipped agents as it excludes stopped ones, and the
  tally adds `N skipped` when there are any: `2 of 3 patrollers in · 1 hazard · 0 failed · 1
  skipped`. `checkSummary` carries it, as today.
- `failureTitle` (:755) falls back to `Run failed` whenever no hazard and no failed agent explains
  a failed outcome, the guard case above included.
- The in-progress check title is `<run> · patrol sweep`, plus `· stage k of n` while a run with more
  than one stage is on its stage k.
- `halted` (:657, stop and land): `waiting` agents become `stopped` like any agent not in; they have
  no job to cancel. Skipped agents stay skipped.

**RunDO and routes** (`dispatch/src/run/do.ts`, `dispatch/src/routes/agent.ts`)
- No new route. `admit` already answers 410 for an agent that is not live, and a waiting agent is
  not live. A skipped agent is terminal, so a late call for it gets 410 too.
- The dispatch effect is unchanged. A release runs the effects stage 0's start runs, after RunDO
  stores the state: one workflow dispatch call per released agent, one check-run write, one
  broadcast.
- The transcript upload is unchanged. `PUT /agent/transcript` (`routes/agent.ts:97`) is the one
  agent route outside `admit`: it checks the nonce alone (`checkNonce`, `do.ts:99`), so that a
  stopped run's agents can still upload. No caller can reach it for a waiting or a skipped agent:
  a nonce leaves the RunDO only in its agent's dispatch, neither was dispatched, and a released
  agent never goes back to either. So no status check is added. `hasTranscript` has one reader,
  the Debug pane's transcript button, which a waiting or skipped card does not show.
- The forwarder reads `AgentStatus` too: `GREEN_WHEN_UNWANTED` (`forwarder/src/run.ts:44`) lists the
  statuses on which a job Dispatch answers 410 ends green. It stays `clear` and `stopped`. No job
  exists for a waiting or a skipped agent, since neither was dispatched and a released agent never
  goes back to either, so a 410 naming one ends its job red, fail-closed.

**Dashboard** (`basetobase/dashboard/src/components/PatrolCards.tsx`, `StepDetail.tsx`,
`PipelineRow.tsx`, `theme.css`)
- A run with more than one stage keeps the `Patrol on this step · reviewers` h3 and its hint once,
  and under it shows one `<section>` per stage, labelled by its heading and holding today's card
  grid (one column at phone width, as today). Each heading is an
  `<h4 class="section-title section-title-sub">`: `Stage 1`, and `Stage n` with ` · after stage n−1
  passes` in a `.section-plain` span for every later stage, n being the stored position + 1. The
  new `.section-title-sub` rule steps the h4 down from the h3's 15px to 13px, the size
  `.patrol-role` uses (`theme.css:848`), same face, tracking and `--muted` color. Its sub-label
  steps down with it: `.section-title-sub .section-plain` is 12px, the size `.step-meta` uses
  (`theme.css:703`), so the pair keeps the h3's one step between title and sub-label (15px and
  14px, `theme.css:385` and `:391`) and the sub-label is never the larger. Each stage section
  is a column with the 8px gap of `.detail-block` (`theme.css:780`) between heading and grid, and
  12px between sections. The heading is text and wraps at phone width. Tab order is stage, then
  roster order. A run with one stage keeps today's markup, with no stage heading.
- "Stage" is a plain word with no themed term, so the stage headings are plain-only; the rule that
  a themed label renders with its plain one (`dashboard/CLAUDE.md:3`) is kept by the h3 above
  them, `Patrol on this step · reviewers`. The headings, the waiting hint and the skipped
  sentences are written in the component, as its other hints and its button labels are
  (`StepDetail.tsx`), and the dashboard tests pin them. The two status labels are in
  `AGENT_STATUS_LABELS`, as above. The machine writes its own summary and check title.
- A release re-renders the cards in place (a card goes from Waiting to Queued); the selected card
  and focus are kept, since cards are keyed by agent id.
- Waiting and skipped cards read "Waiting" and "Skipped" and stay selectable. They take the `idle`
  mark, whose ring is already dashed (`Mark.tsx:51`), and the not-yet-run ground the pipeline row
  has: `#f5f8fb`, as `.step-pending` and `.step-skipped` (`theme.css:679-680`), through new
  `.patrol-card-waiting` and `.patrol-card-skipped` rules.
- The Debug pane for a waiting or skipped agent keeps its `Debug` heading and the agent's name, and
  hides the `Full transcript` button, the `GitHub Actions job` link, the retry button and the
  `No transcript uploaded yet.` hint. In place of the actions row it shows one `<p class="hint">`
  of plain text under the name line:
  - waiting: `Starts when stage n−1 passes.`
  - skipped: the agent's summary, `Skipped: stage k did not pass (<agent names>).`, then one
    next-action sentence. The dashboard judges no pass or fail for it: k and the choice between
    "cannot pass" and "can still pass" come from the agent's `skippedFor`, and the buttons named
    are the ones the step's actions row shows, at the top of the step (`StepDetail.tsx:156`), by
    the checks that row already makes (`failed.length > 0` and `canBypass`, :139-:140). The retry
    label comes from one function the button and the sentence share, so `Retry the failed
    patroller` and `Retry the N failed patrollers` never differ between them; the bypass label is
    one constant. Chosen in this order:
    1. The run is not open, neither `on_the_hill` nor `swept`, which is the gate both buttons
       have (`StepDetail.tsx:55-63`): none. That covers a stopped, a landed and a `failed` run.
    2. `skippedFor.canPass` is false: `Stage k cannot pass on this run. Push a fix, and a new run
       starts at stage 1.` A push replaces the run, so nothing else is named.
    3. Both buttons show: `Stage k can still pass: use "Retry the failed patroller" and "Bypass
       design (emergency)" at the top of this step.`
    4. Only the retry button shows: `Stage k can still pass: use "Retry the failed patroller" at
       the top of this step.`
    5. Only the bypass button shows: `Stage k can still pass: use "Bypass design (emergency)" at
       the top of this step.`
  - With `canPass` true on an open run, one button always shows. A failed agent of stage k shows
    the retry button, and a Granite Chief the bypass would turn shows the bypass button. Neither
    button can belong to another stage: the earlier stages passed, and the later ones never ran.
    So the five cases cover every skipped card. The dashboard is the owner's alone (owner session).
  - Once a retry starts, the held cards are Waiting again (`advanceStages`), so a Skipped line never
    describes a stage that is running.
- The radio log scoped to a waiting or skipped card reads `Quiet on the radio.`, as for any agent
  with no lines. With no card selected, the Debug pane shows the first agent, stage 1's, as today.
- `PipelineRow.tsx`'s `outcomeText` (:50): `hazards flagged` and `N failed` each add ` · N skipped`
  when the step has skipped agents; a failed outcome with no failed agent reads `failed`, never
  `0 failed`. A stalled agent is not counted as failed until it times out, as today.
- The retry button (`retryable`) and the bypass button (`bypassable`) are unchanged.

**Patrol templates** (`.basetobase/patrol/`)
- New `corduroy.md`, house style, at most 40 lines:
  - Read only: the diff, the files it touches and the repo's CLAUDE.md files, with `git` and
    `grep`. Never run the app, the tests or any PR code.
  - Every hygiene problem is a hazard, with file:line and its evidence: logic duplicated from
    existing code (both file:lines); a broken codebase pattern (the CLAUDE.md or BEST_PRACTICES
    rule); a layer, interface, wrapper or option no caller needs; dead or redundant code (unused
    function, export, parameter, branch or flag; commented-out code; a hand-rolled copy of a
    function the repo or its dependencies already provide); and any other hygiene problem it can
    show the same way.
  - A PR whose every changed file is under `docs/` (`git diff --name-only --no-renames`): `clear`,
    summary "No code to review." Every other file is reviewed, markdown included: CLAUDE.md files,
    `plugins/**` rules, skills and lenses, and patrol templates are agent instructions.
- `granite-chief.md:29-31`, the design-PR panel rules, read `designRoles` from
  `git show <base SHA>:basetobase/config/basetobase.json`, mapping role ids to prefixes through its
  roster. With no such file on the base, or one without the key, that does not parse, or whose
  `designRoles` lacks `granite-chief` or `kt-22`, `designRoles` is every lens. The base of a
  patrolled PR is the default branch, since only PRs into it are patrolled. The panel must hold BLD,
  GOAL and SEC; for `Size: full`, also the prefix of every other `designRoles` role but
  `magic-carpet` and `bluebird`; for `Size: short`, each other `designRoles` lens whose section is
  not "None"; UX and DSN, when in `designRoles`, when the design adds or changes a screen.

**Design skill and lens** (`plugins/standard/`)
- `skills/system-design/SKILL.md`, "Size and panel": the lenses are `designRoles` from the default
  branch's config, read fresh, never from the working copy, in three commands:
  `git ls-remote --symref origin HEAD`, whose `ref: refs/heads/<name>` line names the default
  branch; `git fetch origin <name>`; and `git show FETCH_HEAD:basetobase/config/basetobase.json`.
  `refs/remotes/origin/HEAD` is not used: a cloud session's clone does not set it, as the design
  session's own clone showed. Every lens when any of the three fails: no remote, no network, or no
  `ref:` line. Then the rule Granite Chief's template holds too, word for word: every lens when
  there is no such file, no key, a file that does not parse, or a list without `granite-chief` or
  `kt-22`.
- A config that changes between the panel's quorum and the design PR's patrol can leave the panel
  short of a new `designRoles` lens: Granite Chief raises the missing prefix, and the fix is that
  lens's sweep and a new quorum. Extra lenses are always fine. Every panel:
  `builder`, `granite-chief` and `kt-22`. Full: every other `designRoles` lens but `magic-carpet`
  and `bluebird`. Short: each other `designRoles` lens whose section is not "None". `magic-carpet`
  and `bluebird`, when in `designRoles`, join when the design adds or changes a screen.
- `lenses/corduroy.md` gains one line after :6, under 40 lines in all: "A new layer, wrapper,
  interface or option that no existing caller in the repo needs → `defend`: name the caller it
  serves, or cut it." Line :6 stays as it is: "A new abstraction, service or table beside an
  existing one that could be extended → `defend`: name the extension and what it costs."
- `standard_test.go` `TestSkillReferences` pins the new panel lines; `plugins/standard` stays
  version 0.1.0 until its first release.

**e2e** (`basetobase/e2e/`)
- The shipped config gives a run three agents in two stages:
  - `stages.spec.ts` (new): the two cases under "How we'll know it works".
  - `bypass.spec.ts`: Granite Chief's `No approved design` and a clear Mainline leave Corduroy
    Skipped, the PR in Wind hold and the check failed. The bypass releases stage 2: Corduroy's job
    is dispatched and the run is back on the hill. Corduroy clears: Swept, check `success` titled
    `All clear · design bypassed`, the PR in Designs owed. The design PR is patrolled clear through
    both stages, then merged: the entry goes.
  - `retry.spec.ts`: Granite Chief clear and Mainline's job failed leave Corduroy Skipped. The retry
    runs Mainline again; it clears, Corduroy is dispatched and clears: `success`, four jobs in all.
  - `live.spec.ts` and `sync.spec.ts`: where a run must end swept, a helper clears each stage in
    order (stage 1's jobs, then Corduroy's once dispatched); where it only has to be open,
    unchanged.
  - `e2e/CLAUDE.md`: three patrollers in two stages, and `REVIEW_ROLES`.

**Duplication:** none new. Stages extend the sweep step; no second review path. Corduroy's new lens
line covers code-level additions only. Its existing :6 and Granite Chief's scope walk
(`lenses/granite-chief.md:9`) can both name one new service or table, as they can today, with
different tests: Corduroy asks why an existing one is not extended, Granite Chief whether the "Why"
justifies it. This design leaves that pair as it is.

**Docs,** each in the PR that changes what it describes:
- §1, which makes the renames, carries every line that names them: `basetobase/CLAUDE.md` (Patrol:
  `reviewStages`, stages, `waiting` and `skipped`, `skippedFor`; `REVIEW_ROLES`),
  `.basetobase/CLAUDE.md:3` (`reviewStages` for `enabledRoles`), `basetobase/e2e/CLAUDE.md:9`
  (`REVIEW_ROLES` for `ENABLED_ROLES`), and `basetobase/dashboard/CLAUDE.md` (stage sections, the
  Waiting and Skipped cards and their Debug hint, the rule that the dashboard takes a skipped
  card's next action from `skippedFor` and judges no pass or fail, and the retry label the button
  and the hint share).
- §2: `.basetobase/CLAUDE.md` (Corduroy's template) and `basetobase/e2e/CLAUDE.md` (three
  patrollers in two stages).
- §3: `plugins/CLAUDE.md` and `.basetobase/CLAUDE.md` (the panel reads `designRoles`).
- No test pins a CLAUDE.md. Each is part of its PR's diff, and Granite Chief holds the PR to this
  section.

This design supersedes `enabledRoles` in the
Base to Base design (2026-10-20, §6) and the fixed panel lists in the system-design flow design
(2026-10-24, §3 and §5); those files are not edited.

## API contract

None. `api/v1/openapi.yml` is untouched: this changes Base to Base, not the Go API. The dashboard's
own `RunSnapshot` gains `agent.stage`, `agent.releasedAt`, `agent.skippedFor` and two statuses; the
Worker serves the SPA it ships with, so both change in one deploy.

## Data model and migrations

None in D1: the `runs` index stores no agents. A RunDO's stored state gains an optional `stage`,
`releasedAt` and `skippedFor` per agent and may hold the two new statuses. Runs stored before the
deploy have no `stage` and read as one stage, so no migration.

## Scaling

- Assumed load: one owner, about 5 PRs a day and 3 pushes each, so about 15 runs a day, at most
  eight agents a run; `advanceStages` walks at most eight agents per event.
- At that load Corduroy adds at most 15 jobs and about 150 runner minutes a day. The repo is public,
  so standard-runner Actions minutes are not metered. Each job writes one transcript to Workers KV:
  about 45 writes a day across three agents, against the free plan's 1,000.
- Transcripts are kept 30 days (`TRANSCRIPT_TTL_SECONDS`, `routes/agent.ts:16`), each at most 25 MB
  (`TRANSCRIPT_MAX_BYTES`, :14). At the assumed load about 1,350 are kept at once, 900 of them
  without Corduroy. Their size has not been measured, since the design session cannot reach KV: the
  free plan's 1 GB is full at an average of about 0.75 MB a transcript. When KV refuses a write,
  only that transcript is lost: the forwarder warns and the verdict still reaches Dispatch
  (`forwarder/src/run.ts:382-387`). The remedy is a shorter TTL or the paid plan. §2's hand check
  records Corduroy's transcript sizes.
- Every patroller job, Corduroy's included, also spends the Worker's own daily allowances. The
  repo does not record the Cloudflare plan, so the figures are set against Workers Free, the
  stricter case: 100,000 Worker requests a day, and for `RunDO`, a SQLite-backed Durable Object
  (`wrangler.jsonc`, `new_sqlite_classes`), 100,000 requests, 100,000 rows written and 13,000 GB-s
  of duration a day, about 28 hours awake at 128 MB. These are Cloudflare's published figures as
  the designer knows them; the design session could not reach Cloudflare's pages to read them again.
- What a job spends, from the code: it posts its events at most once every 2 s
  (`forwarder/src/batcher.ts`, `intervalMs`) for at most 20 minutes (`forwarder/CLAUDE.md:12`), so
  at most 600 posts, and about 150 to 300 in a 5 to 10 minute job. Each post is one Worker request,
  one `RunDO` call, one stored state (`do.ts:300`) and one `log` row per event with its unique-index
  entry (`do.ts:84`, `:506`). How many events a job logs has not been measured.
- At the assumed load, 45 jobs a day, 15 of them Corduroy's: about 13,500 requests a day at 300
  posts a job, and 27,000 if every job ran its full 20 minutes, plus the cron's 288; about 5 hours
  of `RunDO` awake. All under their allowances. The rows-written allowance is about 2,200 rows a
  job, roughly 1,000 logged events each.
- At 10x (150 runs and 450 jobs a day): about 450 KV writes a day, still under 1,000. On Workers
  Free the Worker's own allowances bind first: about 135,000 requests a day at 300 posts a job,
  about 50 hours of `RunDO` awake, and 220 rows written a job. Then KV storage, unless transcripts
  average under about 75 KB; then the Claude subscription behind `CLAUDE_CODE_OAUTH_TOKEN`, whose
  usage limits fail a job the owner then retries; then GitHub's cap of 20 concurrent jobs on a free
  account, which queues jobs inside `JOB_START_MS`. Accepted (owner: no cap).
- Past a daily allowance Cloudflare refuses the calls until 00:00 UTC: jobs fail, and the owner
  retries them after it. The remedy is the Workers Paid plan, which lifts all of them; a longer
  batch interval cuts requests and stored states, not log rows. No change now. §2's hand check
  records the day's usage from the Cloudflare dashboard: Worker requests; Durable Object requests,
  rows written, duration and stored bytes; D1 rows read and written; and KV stored bytes.
- D1 does not bind, and this design adds no row and no read to it. A run's `runs` row is upserted
  on its start, sweep close, retry, bypass, stop and land (the `index` effects in `machine.ts`),
  never per agent or per event, and a staged run adds an upsert only when a bypass reopens it,
  which the bypass owes today. That is about 2 to 4 upserts a run: about 60 a day at the assumed
  load and 600 at 10x, against Workers Free's 100,000 D1 rows written a day. The cron and the
  dashboard read `runs` as they do today.
- D1 reads are today's, and this design adds none. They grow with the `runs` table, which nothing
  prunes. Workers Free allows 5 million rows read a day (the designer's figure, as above). Three
  reads scan the table, in `dispatch/src/runs/index.ts`: each call of `/api/runs` reads every row
  (`listRuns`, :74, whose sort no index serves); each call of `/api/owed-designs` every open and
  landed row (`listOwedDesigns`, :96); and each run started every row once (`runNamesFor`, :118,
  its second query, which filters on `rating` and sorts on `created_at` with no index for either).
  The dashboard calls the first two on load, on each open of its lobby socket, and every 5 s while
  that socket is down and the tab is visible (`dashboard/src/useRunsLive.ts`, `POLL_MS`;
  `useOwedDesigns` follows the list). `runs` holds about 5,500 rows after a year at 15 runs a day
  and 55,000 at 150.
  - Socket up, one tab open: a day reads at most rows × (2 × loads + frames + runs). A load makes
    both list calls. A lobby frame, one per index write and so 2 to 4 a run, refetches
    `/api/owed-designs`, since `mergeRuns` returns a new list on every frame
    (`useRunsLive.ts:96`) and `useOwedDesigns(runs)` follows it (`pages/RunsList.tsx:186`). A run
    started scans once. It is an upper bound: the owed-designs read skips stopped rows, a share of
    the table not measured. At the assumed load, 50 loads, 60 frames and 15 runs read at most
    about 960,000 rows at 5,500 rows. At 10x, 50 loads, 600 frames and 150 runs make up to 850
    reads of the table a day, which pass 5 million at about 5,900 rows, in about 6 weeks. Each
    further open tab adds its own frames and loads.
  - Socket down: one visible tab reads about twice the table every 5 s. At 5,500 rows that is
    5 million rows in about 38 minutes.
  - Past the allowance D1 refuses reads until 00:00 UTC, and the runs list and run starts fail
    until then.
  - Accepted for now as today's exposure, which this design leaves as it is, with the retention
    non-goal: that design owns the three queries and the poll. The hand check compares the day's D1
    rows read with 5 million.
- Nothing deletes a finished run's `RunDO` storage, its state and `log` rows, or its `runs` row;
  only transcripts expire. That is so today, and this design adds Corduroy's log rows to every run
  whose stage 1 passes, about half again at the shipped stages. A row's text is at most 2,000
  characters (`EVENT_TEXT_MAX`, `shared/src/stream.ts:3`); how many rows a job logs, and their
  size, have not been measured. At 1,000 rows of 1 KB a job, 45 jobs a day store about 45 MB a day
  and fill Workers Free's 5 GB of Durable Object storage in about 110 days, 11 at 10x. At 200 rows
  of 300 bytes it is under 3 MB a day, about 5 years. Past the allowance writes are refused and
  runs fail. Accepted for now: the hand check records the stored bytes, and a retention rule is a
  non-goal here.
- A run per pushed head (a newer push supersedes it), plus one job per retry. Each run whose
  stage 1 passes adds one Actions job (Corduroy, sonnet, about 5 to 10 minutes).
- A release costs one workflow dispatch call per released agent, one check-run write and one
  broadcast, the same as a run's start.
- Review time is the sum of the stages, each as long as its slowest job. A job is capped at 25
  minutes on GitHub (`.github/workflows/basetobase-agent.yml:36`) and 30 on the Worker's clock
  (`AGENT_TIMEOUT_MS`, `machine.ts:24`), after up to 30 minutes in GitHub's queue (`JOB_START_MS`).
  Typical two-stage review: about 15 to 20 minutes. Worst case: about 50 minutes of jobs plus
  queueing.
- The stage count is capped at eight by validation: a role at most once, and eight specialists.
  Worst case at that cap, one role a stage: 8 × 25 = 200 minutes of jobs, plus up to 8 × 30 minutes
  of queueing. Accepted, since the owner sets the stages. Nothing caps a run's total time beyond
  each agent's deadlines; a waiting agent has none, and is bounded by the earlier stages'.
- Corduroy reads the diff and the files it touches: a large PR costs more tokens, bounded by the
  25-minute job cap. A job that times out fails the review, and the owner retries it.

## Infrastructure and dependencies

- No new service or library.
- Config keys: `enabledRoles` is replaced by `reviewStages`; `designRoles` is new.
- One binding, test-only: `REVIEW_ROLES`, renamed from `ENABLED_ROLES`. It is set in the dispatch
  vitest config alone and never in `wrangler.jsonc`, so production runs the shipped
  `reviewStages`. No new binding, secret or variable.
- Cloudflare allowances the added job spends, and what binds first: under Scaling.
- One CI trigger: `basetobase-ci.yml` gains `plugins/standard/skills/system-design/SKILL.md` in its
  `push` and `pull_request` paths, so the test that holds the skill and Granite Chief's template
  to one fallback sentence runs when either file changes. A commit of that file alone deploys
  nothing: it is outside what the Worker ships (`WORKER_PATHSPEC`).
- Cost: one more Claude (sonnet) job and its Actions minutes per run whose stage 1 passes. No cap
  (owner): the job cap bounds each run.
- Off switch: a one-line config PR removing Corduroy's stage; main deploys itself on merge.

## Security

- Corduroy's job is a patroller like the others: the same OIDC token, nonce,
  `--setting-sources user`, and PR text and code read as data. Its template keeps it read-only; the
  runner does not enforce it, as for every patroller today (owner).
- No call for a waiting or a skipped agent can be made: every agent route needs the agent's nonce,
  and a nonce leaves the RunDO only in its agent's dispatch, which neither has had. Besides that,
  brief, events, verdict and failure answer 410 for an agent that is not live. The transcript
  upload checks the nonce alone, as today, and answers 403 without it.
- Granite Chief and KT-22 sit on every design panel: config validation refuses a `designRoles`
  without them.
- The config changes only through a PR to `basetobase/**`, which the patrol leaves unpatrolled
  until M5; the owner alone merges those, as today (owner).
- No new secrets or personal data.

## Failure and rollback

- A stage-1 hazard or failed agent: stage 2 is skipped, and the check fails on stage 1's findings.
- Corduroy's job fails or times out: the review fails on a failed agent, and the owner retries it.
- A dispatch of a released agent lost: "never dispatched" fires from `releasedAt`.
- The owner bypasses after stage 2 was skipped: stage 1 turns passing and stage 2 is released.
- A daily Cloudflare allowance is spent: calls are refused until 00:00 UTC, jobs fail, and the
  owner retries them after it.
- Durable Object storage full: writes are refused and runs fail until the plan changes or old
  runs' storage is deleted by hand. No retention rule yet (non-goal).
- Corduroy's cost or noise spikes: a one-line config PR removes its stage.
- KV storage full: a transcript upload fails with a warning and the review's verdict stands.
- A runs-in-flight deploy: their agents have no `stage`, read as one stage, and finish as before.
- Rollback (`wrangler rollback`): the config is bundled per version, so the old config comes back
  with the old code. A run the new code opened with `waiting` agents fails on the old code's "never
  dispatched" clock; the owner pushes again. No D1 change to undo.

## How we'll know it works

- **Config tests:** shipped `reviewStages` and `designRoles`. Refused in each list: an unknown role
  and `groomer`. Refused in `reviewStages`: a duplicate role across stages, an empty stage, zero
  stages, and a value that is not a list of lists (a flat list left from `enabledRoles`). Refused in
  `designRoles`: a duplicate, and a list without `granite-chief` or `kt-22`. A config still holding
  `enabledRoles` is refused, so a stale one fails loudly. `withReviewRoles` pins one stage.
- **Machine tests:**
  - Stage 2 starts `waiting`: no dispatch and no deadline.
  - Stage 1 all passing: stage 2 queued and dispatched, check still in progress, titled
    `· stage 2 of 2`.
  - Stage 1 hazards or a failed agent: stage 2 skipped, its summary naming stage 1's agents, outcome
    `hazards` or `failed`.
  - A stage is held only once every agent of it is in. Granite Chief reports hazards while Mainline
    still runs: Corduroy stays `waiting` with no summary, the run stays `on_the_hill` and the check
    in progress. Mainline then reports clear: Corduroy is `skipped`, its summary names Granite
    Chief alone, and the sweep closes in that transition. The same with the reports in the other
    order.
  - `skippedFor` on a skipped agent: `stage` is the held stage's position, 0 when stage 1 holds,
    beside a summary that reads `stage 1`. `canPass` is true for a
    failed agent, for Granite Chief's lone missing-design hazard before a bypass, and for both
    together. It is false for any other open hazard, for a `hazards` verdict that lists none, for
    a second missing-design hazard, and for a failed agent beside any of those. Both ways out of
    `skipped` drop it.
  - Agents are in stage order, and roster order within a stage, whatever order a stage's list
    names its roles.
  - A bypass that turns stage 1 passing releases stage 2 straight from `skipped`: its agents are
    `queued` with `releasedAt` and no summary, and neither the Conditions report nor the check
    summary holds a `Skipped:` line. A retry puts stage 2 back to `waiting`, and the retried
    agent's clear verdict then releases it.
  - A panel filter that empties a stage drops it, on a roster fixture with a frontend-only role.
    Stage 1 emptied of two: the stage-2 agent is the run's only one, at stage 0 and `queued`, with
    one dispatch effect and a check title without `stage k of n`. The middle of three emptied: the
    agents sit at stages 0 and 1, the title reads `· stage 1 of 2`, and the last stage is released
    when the first passes, its title then `· stage 2 of 2`.
  - A skipped agent never passes.
  - Stop and land halt waiting agents, and leave skipped ones as they are.
  - A stored agent without `stage` reads as stage 0.
  - A stage-2 agent's hazards or failure decide the outcome; a retried stage-2 agent keeps its stage
    and stage 1 is not re-run.
  - A stage-1 `hazards` verdict that lists none holds stage 2, as `reviewOutcome` fails it.
  - Three stages: stage 3 is skipped when stage 2 fails, and released only once stages 1 and 2
    pass. With stage 1 held and stages 2 and 3 skipped, a bypass releases stage 2 and puts stage 3
    back to `waiting`.
  - A release sets `queued`, `releasedAt` and one dispatch effect per agent; "never dispatched"
    fires from `releasedAt`; a repeated verdict dispatches nothing twice.
  - A bypass on a swept run whose stage 2 was skipped reopens the sweep (step `active`, notes
    empty, no `finishedAt`), sets `on_the_hill`, dispatches stage 2 and raises `checkReposts` by
    exactly 1.
  - A bypass on a swept run that releases nothing, a failed agent still holding stage 1, raises
    `checkReposts` by exactly 1 too, leaves the run swept, and rewrites the Conditions report with
    stage 2's summary naming only the agent that still does not pass.
  - A bypass on an open sweep, Granite Chief's missing-design hazard in and Mainline still
    running: `checkReposts` rises by exactly 1, no report is rewritten, Corduroy stays `waiting`
    and the run `on_the_hill`. Mainline's clear verdict then dispatches Corduroy once, with the
    title `· stage 2 of 2`. With Mainline reporting hazards instead, stage 1 is held and Corduroy
    is `skipped`, never dispatched.
  - A retry's reopen through the shared helper is what today's retry tests assert, unchanged.
  - The tally and the failure title with skipped agents; the title `· stage 1 of 2` and `· stage 2
    of 2`, and a one-stage run's title unchanged.
  - A stalled stage-1 agent holds stage 2 `waiting` until it reports or times out.
  - A retry of a failed stage-1 agent puts stage 2's skipped agents back to `waiting`, their
    summaries cleared, and dispatches only the retried agent; a second failure skips them again.
  - A retry aimed at a skipped or a waiting agent, by id or by step, changes nothing and dispatches
    nothing.
  - `liveAgent` and `deadlinesOf` for a waiting agent and for a skipped one: a dispatch result, a
    brief, events, a verdict or a failure for it change nothing, a brief starts no clock, and no
    alarm is set for it.
  - The tally `2 of 3 patrollers in · … · 1 skipped`; the failure title's `Run failed` fallback for
    a hand-built run whose only non-passing agents are skipped, whose outcome is `failed`.
  - Not tested: the rollback case, which needs the old code; accepted.
- **Route and RunDO tests:** the dispatch test binding starts one-Mainline runs, so a staged run
  comes from the stored state. `dispatch/test/seed.ts` gains `addAgent(stub, agent, name)`, which
  stores an agent with a nonce and its roster name; `addGraniteChief` becomes a call to it. A test
  adds Corduroy at stage 1, `waiting` or `skipped`. `REVIEW_ROLES` stays a flat list.
  - `GET /agent/brief` and `POST /agent/events`, `/agent/verdict` and `/agent/failure` each answer
    410 for a waiting agent and for a skipped one.
  - A retry of a skipped agent by id gets 409 `nothing to retry`.
  - Mainline's clear verdict on a run with a waiting Corduroy dispatches Corduroy's workflow once
    and stores its `releasedAt`.
- **Forwarder tests** (`forwarder/test/run.test.ts`), both tables that turn Dispatch's status on a
  410 into an exit code. `... for a retried verdict` (:644) gains `["valid", "waiting", 1]` and
  `["valid", "skipped", 1]`; `... for the failure report` (:674) gains `["waiting", 1]` and
  `["skipped", 1]`.
- **Dashboard tests:** stage sections with `h4.section-title-sub` headings under the one `Patrol on
  this step` h3, the sub-label in its `.section-plain` span; Waiting and Skipped cards and their
  classes; the Debug pane's `p.hint` for a waiting agent and for each of the five skipped cases in
  their order, case 1 on a stopped, a landed and a `failed` run, case 2 from `canPass` false, each
  sentence naming stage k from `skippedFor` and carrying the buttons' own labels, with one failed
  patroller and with two; no transcript button, job link, retry button or transcript hint, even
  with `hasTranscript` true; the pipeline row's
  `N failed · N skipped`, `hazards flagged · N skipped` and bare `failed`; a card that goes from
  Waiting to Queued keeps its selection; a one-stage run unchanged.
- **Text pins.** Each ships in the PR that ships its text, in the suite that tests that kind of
  file today:
  - Plugin files, in Go (`plugins/standard/standard_test.go`). §2: Corduroy's new lens line, word
    for word, with :6 unchanged and the file at most 40 lines. §3: `TestSkillReferences`, the panel
    lines read `designRoles` with the three git commands above and always name `builder`,
    `granite-chief` and `kt-22`.
  - Patrol templates, in vitest (`basetobase/shared/test/`). §2: a new `patrol.test.ts` for
    `corduroy.md`'s read-only rule, hazard classes and `docs/` rule, at most 40 lines. §3:
    `design.test.ts`, which pins `granite-chief.md` today: its panel rules name `designRoles`, BLD,
    GOAL and SEC, and UX and DSN only "when in `designRoles`".
  - One fallback rule in both readers, §3: a test in `design.test.ts` reads `SKILL.md` and
    `granite-chief.md` and fails unless both hold the same every-lens fallback sentence, since the
    two readers are prompts with no shared code. The Go CI skips a PR of `.basetobase/**` alone
    (`ci.yml:5-7`) and `basetobase-ci` one of `plugins/**` alone, so `basetobase-ci` gains
    `SKILL.md`'s path and the test runs when either file changes.
- **e2e:** a new `stages.spec.ts`:
  - A PR dispatches Granite Chief and Mainline, and no Corduroy job; both clear → Corduroy is
    dispatched; it clears → success.
  - A Mainline hazard → Corduroy never dispatched, its card reads Skipped, and the check fails.
  - The other specs adapted.
- **Evidence after deploy:** the first patrolled code PR shows Corduroy dispatched only after
  Mainline cleared.
- **Hand check right after §2 deploys,** since a model's judgment has no fixed output to assert:
  - Four throwaway PRs, one each with duplicated logic, a broken repo pattern, a needless wrapper
    and dead code, each fail on a Corduroy hazard citing file:line and the rule or duplicate.
  - A clean code PR reads `clear`; a docs-only PR reads `clear` with "No code to review."
  - The results go in §2's PR, with the size of each Corduroy transcript and the day's Cloudflare
    usage named under Scaling. Any miss: the off switch removes Corduroy's stage until a fix lands.
- **Hand check after §3 deploys:**
  - The next design PR's panel holds BLD, GOAL and SEC, and Granite Chief's design-PR rules pass it.
  - In a scratch clone whose `origin` default branch holds a config with `summit-six` dropped from
    `designRoles`, the skill's panel step names no SCL and still names GOAL and SEC.
  - Granite Chief's side of a `designRoles` edit shows on the first design PR after the owner makes
    one; until then the template test pins its rule text.

## Approaches

1. **Stages inside the sweep step (picked, owner):** one config list of ordered stages, gated in
   one place; any number of stages; the dashboard stays one review step.
2. **A new run step after the sweep:** its own dashboard row, but a new step type across the
   machine, labels, dashboard and tests, and fixed at two phases.
3. **A new roster role for hygiene:** rejected by the owner, who chose to extend Corduroy; it would
   also have split one reviewer's work between two.

## Delivery

Three PRs. Order: §1 first; §2 and §3 after it, in either order. §2's shipped `reviewStages` and
§3's `designRoles` reader need §1's config keys on main, and §2's hand check needs its own deploy.

- §1 Review phases by config: `reviewStages` and `designRoles`, the staged sweep, the `waiting` and
  `skipped` statuses, the dashboard's stage sections, and the config, machine, route, RunDO,
  forwarder and dashboard tests. Shipped `reviewStages` stays one stage,
  `[["granite-chief", "mainline"]]`, so nothing changes for PRs yet.
- §2 Corduroy's hygiene review: `.basetobase/patrol/corduroy.md`, its lens rule, their two text
  pins, shipped `reviewStages` `[["granite-chief", "mainline"], ["corduroy"]]`, and the e2e specs.
- §3 The design side reads the config: `SKILL.md`'s panel rules, Granite Chief's design-PR panel
  rules, their text pins, the one-fallback-rule test and its `basetobase-ci` path.

## Decisions

- Extend Corduroy's scope instead of adding a specialist. **(owner)**
- Corduroy reviews every PR's code as well as designs. **(owner)**
- Each phase's specialists are configurable: some or all for the design phase, others for the
  post-implementation review. **(owner)**
- Corduroy's PR review is a step after the end-to-end test and runs only when the tests pass.
  **(owner)**
- Stages inside the sweep step, any number of them, `reviewStages` replacing `enabledRoles`
  (approach 1). **(owner)**
- Granite Chief (the design gate) and KT-22 (Security) sit on every design panel. **(owner)**
- Every hygiene problem Corduroy finds blocks the merge. **(owner)**
- No cost cap on Corduroy's jobs; a config PR is the off switch. **(owner)**
- Corduroy is read-only by its template; the runner does not enforce it. **(owner)**
- The dashboard: a section per stage, "Waiting" and "Skipped" cards, a one-line reason in the detail
  pane, and `· stage k of n` in the check title. **(owner)**
- Waiting agents get their nonce with the run and are not live until released; `releasedAt` starts
  a released agent's clock; Corduroy passes design-only and docs-only PRs; §1 lands first; cost
  counts a run per push plus retries. **(owner)**
- The owner alone merges config changes, as today. **(owner)**

The owner delegated the remaining open questions to the designer on 2026-11-16 ("thoughtfully
decide and close out outstanding issues"). Each is marked **(owner, delegated)** for the owner to
check at sign-off:
- Both design-panel readers use the default branch's config, read fresh; no file, no key, an
  unparsable file or a list without Granite Chief and KT-22 means every lens; a config that changed
  since quorum costs that lens's sweep and a new quorum. No config version is recorded in the
  design. **(owner, delegated)**
- "Docs-only" for Corduroy is every changed file under `docs/`; all other markdown is reviewed.
  **(owner, delegated)**
- Assumed load is 5 PRs a day at 3 pushes each, with the 10x case worked under Scaling.
  **(owner, delegated)**
- Dashboard details: h4 stage headings under the one patrol h3, the muted ground for Waiting and
  Skipped cards, the Debug pane's contents, the skipped line per cause, and `N skipped` in the
  pipeline row. **(owner, delegated)**
- A stalled agent is not "in": its stage holds the later ones until it reports or times out.
  **(owner, delegated)**
- The e2e steps per spec, as listed under "Fit with existing features". **(owner, delegated)**
- The rollback case is accepted untested. **(owner, delegated)**
- A later stage's agents follow the stage that holds them: Waiting while it runs, Skipped once it
  is in and did not pass, so a retry puts them back to Waiting. **(owner, delegated)**
- The skipped line's next action follows a fixed order: none on a closed run, push a fix when a
  hazard the bypass cannot clear holds the stage, a `hazards` verdict that lists none included,
  otherwise the retry, the bypass or both. Each sentence names stage k and the buttons by their own
  labels. **(owner, delegated)**
- "In" in the tally excludes skipped agents; the total stays every agent. **(owner, delegated)**
- Corduroy's lens line :6 stays as it is; the new line covers code-level additions only, and its
  overlap with Granite Chief's scope walk on services and tables is left as today.
  **(owner, delegated)**
- Stage headings step down to 13px (`.section-title-sub`) and their sub-label to 12px; the Debug
  pane's reason is a `p.hint`. **(owner, delegated)**
- Scaling is set against Workers Free, the stricter plan, since the repo does not record the plan.
  At 10x its request, row-write and duration allowances bind first, then KV storage. No change to
  the plan, the batch interval or the TTL now; §2's hand check records transcript sizes and the
  day's Cloudflare usage. **(owner, delegated)**
- The design phase's success: a design's panel follows a `designRoles` edit, with Granite Chief and
  KT-22 kept. Moving a specialist is an edit of one list. **(owner, delegated)**
- A bypass that releases a stage gives the sweep step the retry's reset, its notes and `finishedAt`
  cleared, and any bypass raises `checkReposts` by exactly 1. **(owner, delegated)**
- D1 does not bind: a run upserts its index row a few times, never per agent or event.
  **(owner, delegated)**
- Finished runs' stored logs and index rows are kept, as today. The growth is accepted for now and
  measured at §2's hand check; a retention rule is its own design. **(owner, delegated)**
- Route and RunDO tests get a staged run from a seed helper, `addAgent`; `REVIEW_ROLES` stays a
  flat list. **(owner, delegated)**
- Agents are in roster order within a stage, as today; the order a stage's list names its roles
  does not matter. **(owner, delegated)**
- Each text pin ships with its text, plugin files in the Go suite and patrol templates in vitest;
  the one-fallback-rule test is in vitest, with `SKILL.md` added to `basetobase-ci`'s paths.
  **(owner, delegated)**
- A job refused for a waiting or a skipped agent ends red: the forwarder's green list stays
  `clear` and `stopped`, pinned in both of its 410 exit tables. **(owner, delegated)**
- D1 reads grow with the `runs` table, as today; accepted with the retention non-goal, and the
  hand check compares a day's reads with the allowance. **(owner, delegated)**
- The empty-stage test covers a first stage emptied and the middle of three emptied.
  **(owner, delegated)**
- Each CLAUDE.md changes in the PR that changes what it describes, the dashboard's included; no
  test pins them. **(owner, delegated)**
- The skill names the default branch with `git ls-remote --symref origin HEAD` and reads the config
  from `FETCH_HEAD`; a failed read means every lens. **(owner, delegated)**
- "Stage" has no themed term: stage headings are plain-only, and their text and the hints' are
  written in the component. **(owner, delegated)**
- `skippedFor.stage` is 0-based, as `AgentSnapshot.stage` is. **(owner, delegated)**
- The dashboard's reads of `runs` can spend D1's daily allowance: in under an hour of polling
  while its socket is down once the table is large, and within about 6 weeks at 10x with the
  socket up. That is today's exposure, stated with its worst-case count and left to the retention
  design. **(owner, delegated)**
- "The tests pass" means every agent of every earlier stage passes, not Mainline alone, and the
  owner's bypass counts. **(designer's call)**
- `designRoles` lives in the same config file and is read from the default branch; with no file,
  every lens. **(designer's call)**
- `ENABLED_ROLES` and `withEnabledRoles` are renamed `REVIEW_ROLES` and `withReviewRoles`, and pin
  one stage. **(designer's call)**
- One predicate, `passes`, decides both the stage gate and `reviewOutcome`. **(designer's call)**
- A retried agent keeps its stage. **(designer's call)**
- A role appears at most once across stages; neither list takes `groomer`. **(designer's call)**
- Skipped agents fail closed, and are released when their earlier stages turn passing.
  **(designer's call)**
- A PR whose panels leave no agent at all reads `none`, as today. **(designer's call)**
- Shipped `designRoles`: all eight specialists. **(designer's call)**
- One current stage, the first that has not passed, drives both the gate and the check title; a
  waiting or skipped stage is unreleased, never in. **(designer's call)**
- A skip adds only a summary, dropped on the way out of `skipped`, and no `finishedAt`.
  **(designer's call)**
- `retryAgents` and a release reopen a run through one helper. **(designer's call)**
- The dashboard's stage view is a goal of its own. **(designer's call)**
- The machine tells the dashboard what a skipped card can do next (`skippedFor`); the dashboard
  holds no copy of `passes`. **(designer's call)**
- The skipped line's case 1 is the buttons' own gate: a run that is not open. **(designer's call)**
- Corduroy's success line holds for a PR whose stage 1 passes. **(designer's call)**
- The transcript upload stays gated by the nonce alone, with no status check for waiting or
  skipped agents: Security asked for one or for the claim to be corrected, Goal fit asked for no
  code a goal does not need, and nobody can hold such an agent's nonce. **(owner, delegated)**

## Left to the builder

- Config validation messages.

## Design review

Panel: GOAL, INF, SCL, SEC, FUN, QLT, UX, DSN, BLD. Why: full design that changes the dashboard's patrol cards, a screen.

Round 1:
- GOAL-1 Goal ships Corduroy as a PR reviewer; a non-goal says not to turn on more: revised Goals, non-goals, anti-goals
- GOAL-2 No test separates a Corduroy hazard from taste: owner: every hygiene problem Corduroy finds blocks, with file:line evidence
- GOAL-3 Granite Chief design-PR rule undefined when config file is absent, so panels can disagree: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- GOAL-4 Arbitrary N ordered stages where one gated Corduroy step meets the success line: owner: any number of stages (approach 1)
- INF-1 Job timeout cited as 30 minutes; the workflow sets 25: revised Scaling
- INF-2 Cost has no unit price and no monthly total: owner: no cost cap; the job cap bounds each run, a config PR is the off switch, a timed-out job is retried
- INF-3 Pay-per-use Corduroy job has no volume or spend cap: owner: no cost cap; the job cap bounds each run, a config PR is the off switch, a timed-out job is retried
- INF-4 No way to switch the paid Corduroy stage off without a deploy: owner: no cost cap; the job cap bounds each run, a config PR is the off switch, a timed-out job is retried
- SCL-1 Stated 30-minute job timeout contradicts the workflow's 25 minutes: revised Scaling
- SCL-2 Stage count is unbounded, so review latency grows linearly and is not worked at 10x: revised Scaling
- SCL-3 Corduroy's input size is bounded by time, not by diff size: owner: no cost cap; the job cap bounds each run, a config PR is the off switch, a timed-out job is retried
- SCL-4 Cost is stated per PR, but the unit of dispatch may be a run per push: owner: nonce with the run and not live until released, releasedAt, docs-only PRs clear, §1 first, a run per push plus retries
- SCL-5 Outbound calls per verdict event in advanceStages are not named: owner: nonce with the run and not live until released, releasedAt, docs-only PRs clear, §1 first, a run per push plus retries
- SEC-1 Config change control is a PR to basetobase/**, which the patrol never reviews: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- SEC-2 Security floor of the design panel moves from a fixed list to editable config: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- SEC-3 Config validation leaves fail-open values open: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- SEC-4 Corduroy job's tools, credentials and checkout are not stated: owner: Corduroy is read-only by its template, not enforced by the runner
- FUN-1 Retry drops `stage`, so a retried stage-2 agent reads as stage 0: revised Fit with existing features
- FUN-2 Stage gate's 'clear' disagrees with reviewOutcome's 'flagged': revised Fit with existing features
- FUN-3 No test shows Corduroy flagging the code defects named as success: revised How we'll know it works
- FUN-4 Failure and edge cases of the staged sweep with no test: revised How we'll know it works
- FUN-5 designRoles: required members and empty list undefined; patrol rule untested: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- QLT-1 advanceStages derives 'clear' separately from reviewOutcome, so the two can disagree: revised Fit with existing features
- QLT-2 retryAgents rebuilds the agent without stage; the design never says retry keeps it: revised Fit with existing features
- QLT-3 Design-panel rules are moved to designRoles in one line and left hardcoded in four others: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- QLT-4 designRoles and reviewStages validation admits groomer, which has no lens or panel: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- QLT-5 Exhaustive AgentStatus maps in shared/ are not named; the 'Waits for stage 1' label has no home: revised Fit with existing features
- QLT-6 New Corduroy lens rule duplicates the Granite Chief lens, and 'Duplication: none' does not say so: owner: delegated; lens line :6 stays as it is, the new line covers code-level additions only, and its overlap with Granite Chief's scope walk is left as today
- QLT-7 withEnabledRoles and ENABLED_ROLES keep names that no longer describe what they pin: revised Fit with existing features
- UX-1 Stage groups: heading semantics, keyboard order and 320 px layout not stated: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- UX-2 'Waits for stage 1' label is wrong for stage 3 or later and its source is unnamed: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- UX-3 Detail view for a selected waiting or skipped card is not stated: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- UX-4 Next action for a failed run with skipped cards is not shown to the person: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- UX-5 Progress shown while stage 2 runs and total-time expectation are not stated: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- UX-6 Grouping cards by stage versus keeping the flat grid with a per-card stage tag: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- DSN-1 Stage group headings have no stated look, layout or contrast: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- DSN-2 The `waiting` label depends on the stage, but status labels are static: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- DSN-3 What a selected waiting or skipped card shows in the detail pane is not drawn: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- BLD-1 retryAgents rebuilds the agent without `stage`, so a retried agent drops to stage 0: revised Fit with existing features
- BLD-2 `releasedAt` is used but never declared on AgentSnapshot: owner: nonce with the run and not live until released, releasedAt, docs-only PRs clear, §1 first, a run per push plus retries
- BLD-3 advanceStages needs a nonce source that bypassDesign and closeSweepIfDone do not have: owner: nonce with the run and not live until released, releasedAt, docs-only PRs clear, §1 first, a run per push plus retries
- BLD-4 designRoles validation and how the design skill combines it with its size, screen and builder rules: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- BLD-5 Granite Chief's rewritten panel rule is silent on short designs, a missing config, and id-to-prefix mapping: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- BLD-6 corduroy.md has no rule for design PRs, which stage 2 will dispatch it on: owner: nonce with the run and not live until released, releasedAt, docs-only PRs clear, §1 first, a run per push plus retries
- BLD-7 Skipped summary is both fixed and left to the builder: revised Left to the builder
- BLD-8 Stage numbering mixes 0-based storage and 1-based prose, and the heading for stage 3 and later is open: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- BLD-9 Order between §1, §2 and §3 is left open, and §3 depends on §1: owner: nonce with the run and not live until released, releasedAt, docs-only PRs clear, §1 first, a run per push plus retries

Round 2:
- GOAL-5 Anti-goal 'pass or fail derived only in reviewOutcome' is broken by the new passes/advanceStages path: revised Goals, non-goals, anti-goals
- GOAL-6 Panel agreement between the skill and Granite Chief holds only if both read the same config at the same time: owner: delegated; both readers use the default branch's config read fresh, and a config changed since quorum costs that lens's sweep and a new quorum
- GOAL-7 designRoles is read per patrolled repository while a non-goal excludes per-repository config: owner: delegated; the Worker's bundled reviewStages reviews every patrolled PR until part 3, and designRoles is read from the repo's default branch
- INF-5 Actions minutes and KV transcript writes have no stated free-tier limit against the Scaling numbers: owner: delegated; the repo is public so Actions minutes are unmetered, and KV writes stay under the free plan's 1,000 a day at 10x
- SCL-6 Load is stated as 'a few PRs a day' with no number, so 10x cannot be worked: owner: delegated; 5 PRs a day at 3 pushes each, 15 runs a day, with the 10x case worked
- SEC-5 designRoles reader rules cover an absent file, not a file without the key or a stale default branch: owner: delegated; no file, no key, an unparsable file or a list without Granite Chief and KT-22 means every lens, in both readers
- SEC-6 "Design or docs files only" is undefined, and agent-instruction markdown is patrolled: owner: delegated; docs-only is every changed file under docs/, and all other markdown is reviewed
- FUN-6 Config refusal tests do not say which list each refusal covers: revised How we'll know it works
- FUN-7 e2e adaptations of four specs have no concrete steps or expected states: owner: delegated; the steps per spec are listed under Fit with existing features
- FUN-8 Panel rules do not say what happens when the base config exists but has no designRoles key: owner: delegated; a missing key or invalid list means every lens, pinned by a test that both readers hold the same sentence
- QLT-8 Patrol rule and skill disagree on whether UX and DSN need to be in designRoles: revised Fit with existing features
- QLT-9 A bypass on a swept run releases stage 2 into a run that is not live and emits no dispatch: revised Fit with existing features
- UX-7 Skipped line says a retry runs it, but retry exists only for error agents; hazards leave no next action: revised Fit with existing features
- UX-8 Detail pane for waiting and skipped cards is not stated against the Debug panel's current markup: owner: delegated; the Debug pane keeps its heading and the agent's name, hides the transcript button, job link, retry button and hint, and shows the one line
- UX-9 Stage heading level and live release of a stage are not stated: owner: delegated; h4 stage headings in a section per stage under the one patrol h3, and a release re-renders in place keeping selection and focus
- UX-10 Pipeline row's failure text is not updated for the new statuses: owner: delegated; the pipeline row adds N skipped, and a stalled agent is not counted as failed
- DSN-4 Stage headings: heading level and title/sub-label split against the established pattern are not stated: owner: delegated; h4.section-title with the sub-label in a .section-plain span, the hint once on the parent h3
- DSN-5 Waiting and Skipped patrol cards have no stated look beside the established not-yet-run style: revised Fit with existing features
- BLD-10 AgentSnapshot.stage is both the reviewStages index and a renumbered index: revised Fit with existing features
- BLD-11 One PR for §1 to §3 contradicts Delivery's order and §2's hand check: revised Delivery
- BLD-12 'In' is undefined for a stalled agent, so the stage gate's timing is open: owner: delegated; in is isTerminal, so a stalled agent holds its stage until it reports or times out
- BLD-13 The skill's 'default branch' read has no ref or command: owner: delegated; git fetch origin, then git show origin/<default branch>:basetobase/config/basetobase.json

Round 3:
- SCL-7 Transcript storage in KV has no byte figure against the free plan's 1 GB: owner: delegated; KV storage is named as the limit that may bind first, a refused write loses only the transcript, and the hand check measures sizes
- FUN-9 'A skipped agent is not retryable' has no test, nor do waiting or skipped agents in the retry route: revised How we'll know it works
- QLT-10 A waiting agent is live and has a deadline in the current code; the design cites those functions as if they already refuse it: revised Fit with existing features
- QLT-11 The conditionsReport tally and sweep-close predicates still count a skipped agent as in: owner: delegated; in excludes skipped agents, the total stays every agent, and the failure title falls back to Run failed
- UX-11 Skipped line's next action is undefined when stage k holds mixed causes or a stopped agent: owner: delegated; a fixed order: none on a closed run, fix and push for any other hazard, otherwise the retry, the bypass or both
- UX-12 State and text of skipped cards while a retry or bypass is already running the stage that held them: owner: delegated; skipped agents go back to waiting while the stage that held them runs
- UX-13 Pipeline row can read '0 failed · N skipped': revised Fit with existing features
- DSN-6 Stage h4 headings take the h3's look, so the hierarchy is flat: revised Fit with existing features
- DSN-7 Debug pane's one-line reason has no stated element, class or style: owner: delegated; one p.hint of plain text under the name line, in place of the actions row
- BLD-14 Tally's 'N of M patrollers in' would count skipped agents as in: owner: delegated; in excludes skipped agents and the total stays every agent
- BLD-15 Status and summary of stage-2 agents while a stage-1 retry is running is open: owner: delegated; they go back to waiting with the summary cleared, and advanceStages runs before sweptState
- BLD-16 Skipped line's next action is undefined when a stage has mixed causes: owner: delegated; a fixed order of five cases under Fit with existing features

Round 4:
- GOAL-8 Delivery §1 ships a dashboard no goal asks for: revised Goals, non-goals, anti-goals
- GOAL-9 Success line has no check for the design phase: owner: delegated; a design's panel follows a designRoles edit with Granite Chief and KT-22 kept, and a move is an edit of one list
- INF-6 Worker and Durable Object free-tier request limits are not stated against the added Corduroy job traffic: owner: delegated; set against Workers Free, whose request, row-write and duration allowances bind first at 10x, with no change now and the day's usage recorded at the hand check
- INF-7 The renamed REVIEW_ROLES binding is not listed beside the config keys: revised Infrastructure and dependencies
- FUN-10 A release straight from `skipped` (the bypass path) keeps the stale skip summary, and no test catches it: revised Fit with existing features
- FUN-11 Waiting-agent tests cover 3 of the 5 callers the design says must refuse a waiting agent: revised How we'll know it works
- QLT-12 Sweep reopen on release copies retryAgents' block, and bypassDesign already bumps checkReposts: revised Fit with existing features
- UX-14 Skipped line has no next action when stage k is held by a hazards verdict that lists no hazard: owner: delegated; it takes case 2, push a fix, and each sentence names the buttons by their labels at the top of the step
- DSN-8 Stage h4 sub-label (14px .section-plain) is larger than its 13px heading: revised Fit with existing features
- DSN-9 Skipped hint's next-action wording differs from the existing button labels and is ambiguous: revised Fit with existing features
- BLD-17 advanceStages' 'current stage' makes its release branch unreachable: revised Fit with existing features
- BLD-18 Skipped line has no sentence for a stage held by a hazards verdict that lists none: owner: delegated; case 2 covers it, and the dashboard tests cover both causes
- BLD-19 Bypass-driven reopen of a swept run leaves sweep notes, finishedAt and the repost count open: owner: delegated; the sweep step gets the retry's reset, notes and finishedAt cleared, and one bypass raises checkReposts by exactly 1

Round 5:
- GOAL-10 First success line promises a Corduroy hazard on any hygiene-problem PR; the stage gate makes it conditional: revised Why
- INF-8 D1 free-tier limits are not stated against the writes each added job drives: owner: delegated; D1 does not bind, since a run upserts its index row a few times and never per agent or event, and the hand check records D1 usage
- SCL-8 Per-run RunDO log and state storage has no retention rule; only KV transcripts have a TTL: owner: delegated; kept as today, the growth is stated and accepted for now, the hand check records stored bytes, and a retention rule is a non-goal with its own design
- FUN-12 Route tests for waiting and skipped agents name no way to build such a run: owner: delegated; a seed helper, addAgent, stores a staged agent in a started run, and REVIEW_ROLES stays a flat list
- QLT-13 Skipped-card next-action cases need a dashboard copy of passes/openHazards/waivable, with no stated home: revised Fit with existing features
- QLT-14 Forwarder's AgentStatus consumer GREEN_WHEN_UNWANTED is not named, and its outcome for waiting and skipped is not stated: owner: delegated; the list stays clear and stopped, so a job refused for a waiting or skipped agent ends red, pinned by a forwarder test
- UX-15 Skipped hint's case 1 covers only stopped or landed runs, so a `failed` run is told to use buttons that are not on screen: revised Fit with existing features
- BLD-20 Order of agents inside a stage is open: roster order or reviewStages list order: owner: delegated; roster order within a stage, as today, and the order a list names its roles does not matter
- BLD-21 Host file for patrol-template tests, and which PR carries the lens-line pin, are not named: owner: delegated; each pin ships with its text, plugin files in the Go suite and patrol templates in vitest, and the one-fallback-rule test is in vitest with SKILL.md added to basetobase-ci's paths

Round 6:
- INF-9 D1 read allowance is not stated; the runs table grows unbounded and dashboard queries scan all of it: owner: delegated; the allowance and the three full-table reads are stated, the growth is accepted with the retention non-goal, and the hand check compares a day's D1 reads with 5 million
- SEC-7 Claim that no call for a waiting agent is admitted is false for PUT /agent/transcript: revised Security
- FUN-13 No test for a stage with one agent in and hazardous while a sibling still runs: revised How we'll know it works
- FUN-14 The empty-stage panel-filter test states no expected state: owner: delegated; both cases, a first stage emptied and the middle of three emptied, with their stages, statuses, dispatches and titles
- QLT-15 Docs list omits basetobase/dashboard/CLAUDE.md, which documents the retry/bypass predicates and Debug panel this design changes: owner: delegated; added, each CLAUDE.md changes in the PR that changes what it describes, and no test pins them
- BLD-22 The skill's read of `origin/<default branch>` never says where the branch name comes from or what a failed fetch does: owner: delegated; git ls-remote --symref origin HEAD names the branch, the config is read from FETCH_HEAD, and a failed read means every lens

Round 7:
- GOAL-11 Transcript upload refusal for waiting and skipped agents guards a case the design says cannot occur: revised Fit with existing features
- INF-10 The three runs/index.ts line citations for the full-table D1 reads do not match the file: revised Scaling
- SCL-9 D1 read budget assumes 50 list loads a day; the dashboard's 5 s poll fallback breaks it, and the 10x date counts one scan: owner: delegated; after two answers, the worst-case count now includes the poll and every lobby frame's owed-designs read, and the exposure is today's, accepted and left to the retention design
- SCL-10 Cited file:line for the three full-table D1 reads is off: revised Scaling
- QLT-16 Docs put §1's renames in §2's PR, leaving three CLAUDE.md lines stale between the merges: revised Fit with existing features
- DSN-10 Stage headings and check-title wording have no themed·plain pairing, which the dashboard requires: owner: delegated; Stage has no themed term, the headings are plain-only under the themed h3, and their text and the hints' are written in the component and pinned by the dashboard tests
- BLD-23 `skippedFor.stage` is 'the held stage's position': 0-based or 1-based is not stated, and the hint's `k` comes from it: owner: delegated; 0-based as AgentSnapshot.stage is, shown as stage + 1 by the dashboard and in the machine's summary

Round 8:
- FUN-15 Bypass on an open sweep with stage 1 still running has no test, though Fit with existing features states its behaviour
- FUN-16 Forwarder test is named as one test, but there are two tables that map an agent status to an exit code: owner: delegated; both tables gain waiting and skipped rows, each exit 1
