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
  - A PR with duplicated logic, a broken codebase pattern, a needless abstraction, dead code or
    any other hygiene problem fails the *Base to Base* check on a Corduroy hazard citing file:line.
  - A PR whose end-to-end test fails never dispatches Corduroy; its card reads Skipped.
  - Moving a specialist between phases or stages is a one-line config edit.

## Goals, non-goals, anti-goals

**Goals**
- `designRoles` and `reviewStages` in the config, read by the design skill and by the patrol.
- Ordered review stages, each gated on every earlier stage passing.
- Corduroy's hygiene rules in both phases; Corduroy in stage 2 of the shipped config.

**Non-goals**
- A new roster role (owner: extend Corduroy's scope instead).
- A non-blocking "notes" field in the verdict contract: every problem Corduroy finds is a hazard.
- Turning on PR reviewers beyond Corduroy now; the config allows it later.
- A cost cap on Corduroy's jobs (owner).
- Enforcing a reviewer's tools in the runner (owner).
- Per-repository config for other projects patrolled from this Worker (part 3).
- The huddle and Groomer (M3).

**Anti-goals**
- A Corduroy hazard without evidence: file:line, and the rule or the duplicate it cites.
- A later stage spending a job on code whose earlier stage failed.
- A waiting agent timing out, or holding the check open forever, while an earlier stage runs.
- A skipped agent counting toward a pass.
- Pass or fail derived anywhere but `reviewOutcome`.
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
- `AgentSnapshot` gains `stage: number`, its index in `reviewStages` (0 for the first stage; the
  dashboard shows index + 1), and `releasedAt?: number`, epoch ms like `retriedAt`, set when its
  stage is released. Both reach the dashboard through `snapshotOf`. A stored agent without `stage`
  reads as stage 0, so runs open at deploy finish as one stage.
- `AgentStatus` (`shared/src/types.ts:15`) gains `waiting` (a later stage's agent, not yet
  dispatched) and `skipped` (an earlier stage did not pass), and so does every exhaustive map of it:
  `AGENT_STATUS_LABELS` (`shared/src/labels.ts:48`, "Waiting" and "Skipped") and `AGENT_TONES`
  (`PatrolCards.tsx:6`, both `idle`).
- `skipped` is terminal (`isTerminal`, :597). `waiting` is not terminal, has no deadline
  (`deadlinesOf`, :611) and no job, and is not live (`liveAgent`, :603), so every agent call for it
  is refused with 410. Its nonce is made with the run's, as today, and leaves the RunDO only with
  its dispatch.
- `createRun` (:74) builds every stage's agents on the PR's panels; a stage left empty by the panel
  filter is dropped and the later ones renumbered. Stage 0 starts `queued` and is dispatched as now;
  later stages start `waiting`. A PR whose panels leave no agent at all reads `none`, as today.
- A new step in `closeSweepIfDone` (:788), `advanceStages`, runs after every verdict, failure,
  retry and bypass:
  - Passing is one predicate, `passes(s, agent)`, which `reviewOutcome` uses too: status `clear`,
    or `hazards` with a non-empty list whose every hazard the owner waived (`openHazards` empty).
    `error`, `stopped`, `stalled`, `skipped`, and a `hazards` verdict that lists none, never pass.
  - The first stage with an agent not in, or not passing, is the current one.
  - All its agents in and passing: the next stage's `waiting` or `skipped` agents become `queued`,
    get `releasedAt` and one dispatch effect each; the sweep and the run stay open.
  - All its agents in and any not passing: every later-stage agent not in becomes `skipped`, its
    summary naming the stage that did not pass and its agents, and the sweep closes as today.
- `reviewOutcome` (:529) reads `passes` for every agent. A `skipped` agent never passes: its earlier
  stage already fails the review, and a run whose only non-passing agents are skipped reads
  `failed`, fail-closed.
- `retryAgents`' rebuild of a retried agent (:318) keeps `stage` with its id, role, step and round,
  so a retried stage-2 agent stays in stage 2. `releasedAt` is dropped: `retriedAt` runs its clock.
- `retryAgents` (:304) and `bypassDesign` (:381) end in `advanceStages`, so a stage that turns
  passing releases the skipped stage after it. A skipped agent is not retryable itself
  (`retryableAgents`, :294).
- `deadlinesOf`: a released agent's "never dispatched" clock runs from `releasedAt`
  (`retriedAt ?? releasedAt ?? createdAt`).
- `conditionsReport`, `failureTitle`, `checkSummary`: the tally adds `N skipped` when there are any.
  The in-progress check title is `<run> · patrol sweep`, plus `· stage k of n` while a run with more
  than one stage is on its stage k.
- `halted` (:657, stop and land): `waiting` agents become `stopped` like any agent not in; they have
  no job to cancel. Skipped agents stay skipped.

**RunDO and routes** (`dispatch/src/run/do.ts`, `dispatch/src/routes/agent.ts`)
- No new route. `admit` already answers 410 for an agent that is not live, and a waiting agent is
  not live. A skipped agent is terminal, so a late call for it gets 410 too.
- The dispatch effect is unchanged. A release runs the effects stage 0's start runs, after RunDO
  stores the state: one workflow dispatch call per released agent, one check-run write, one
  broadcast.

**Dashboard** (`basetobase/dashboard/src/components/PatrolCards.tsx`, `StepDetail.tsx`)
- A run with more than one stage shows one section per stage, each holding today's card grid (one
  column at phone width, as today). Each heading uses the existing `.section-title` style: `Stage 1`,
  and `Stage n · after stage n−1 passes` for every later stage, n being the stored index + 1. Tab
  order is stage, then config order. A run with one stage looks as today.
- Waiting and skipped cards read "Waiting" and "Skipped" and stay selectable. Their detail pane
  hides the job link and the transcript control and shows one line instead:
  - waiting: `Starts when stage n−1 passes.`
  - skipped: `Skipped: stage k did not pass (<agent names>). A retry there runs it.`, or, when
    Granite Chief's missing-design hazard is all that holds stage k, `… The design bypass there runs
    it.`
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
  - A PR of design or docs files only: `clear`, summary "No code to review."
- `granite-chief.md:29-31`, the design-PR panel rules, read `designRoles` from
  `git show <base SHA>:basetobase/config/basetobase.json`, mapping role ids to prefixes through its
  roster. With no such file on the base, `designRoles` is every lens. The panel must hold BLD,
  GOAL and SEC; for `Size: full`, also the prefix of every other `designRoles` role but `magic-carpet`
  and `bluebird`; for `Size: short`, each other `designRoles` lens whose section is not "None";
  UX and DSN when the design adds or changes a screen, as today.

**Design skill and lens** (`plugins/standard/`)
- `skills/system-design/SKILL.md`, "Size and panel": the lenses are `designRoles` from the default
  branch's `basetobase/config/basetobase.json`, or every lens when the file is absent. Every panel:
  `builder`, `granite-chief` and `kt-22`. Full: every other `designRoles` lens but `magic-carpet`
  and `bluebird`. Short: each other `designRoles` lens whose section is not "None". `magic-carpet`
  and `bluebird`, when in `designRoles`, join when the design adds or changes a screen.
- `lenses/corduroy.md` extends its rule at :6 in place, under 40 lines: a new abstraction, service,
  table, layer, wrapper, option or config key that no existing caller or stated need in the repo
  requires → `defend`. Scope beyond the goals stays Granite Chief's (`lenses/granite-chief.md:10`).
- `standard_test.go` `TestSkillReferences` pins the new panel lines; `plugins/standard` stays
  version 0.1.0 until its first release.

**e2e** (`basetobase/e2e/`)
- The shipped config gives a run three agents in two stages. `bypass.spec.ts`, `retry.spec.ts`,
  `live.spec.ts` and `sync.spec.ts` patrol Corduroy once stage 1 passes, or expect it skipped.

**Duplication:** none. Stages extend the sweep step; no second review path. Corduroy's lens rule
extends its own rule rather than restating Granite Chief's scope rule.

**Docs:** `basetobase/CLAUDE.md` (Patrol, `REVIEW_ROLES`), `.basetobase/CLAUDE.md`,
`basetobase/e2e/CLAUDE.md`, `plugins/CLAUDE.md`. This design supersedes `enabledRoles` in the
Base to Base design (2026-10-20, §6) and the fixed panel lists in the system-design flow design
(2026-10-24, §3 and §5); those files are not edited.

## API contract

None. `api/v1/openapi.yml` is untouched: this changes Base to Base, not the Go API. The dashboard's
own `RunSnapshot` gains `agent.stage`, `agent.releasedAt` and two statuses; the Worker serves the
SPA it ships with, so both change in one deploy.

## Data model and migrations

None in D1: the `runs` index stores no agents. A RunDO's stored state gains an optional `stage` and
`releasedAt` per agent and may hold the two new statuses. Runs stored before the deploy have no
`stage` and read as one stage, so no migration.

## Scaling

- One owner, a few PRs a day, at most eight agents a run; `advanceStages` walks at most eight
  agents per event.
- A run per pushed head (a newer push supersedes it), plus one job per retry. Each run whose
  stage 1 passes adds one Actions job (Corduroy, sonnet, about 5 to 10 minutes).
- A release costs one workflow dispatch call per released agent, one check-run write and one
  broadcast, the same as a run's start.
- Review time is the sum of the stages, each as long as its slowest job. A job is capped at 25
  minutes on GitHub (`.github/workflows/basetobase-agent.yml:36`) and 30 on the Worker's clock
  (`AGENT_TIMEOUT_MS`, `machine.ts:24`), after up to 30 minutes in GitHub's queue (`JOB_START_MS`).
  Typical two-stage review: about 15 to 20 minutes. Worst case: about 50 minutes of jobs plus
  queueing.
- The stage count is not capped: worst-case review time grows by one job cap per stage. Accepted,
  since the owner sets the stages.
- Corduroy reads the diff and the files it touches: a large PR costs more tokens, bounded by the
  25-minute job cap. A job that times out fails the review, and the owner retries it.

## Infrastructure and dependencies

- No new service or library.
- Config keys: `enabledRoles` is replaced by `reviewStages`; `designRoles` is new.
- Cost: one more Claude (sonnet) job and its Actions minutes per run whose stage 1 passes. No cap
  (owner): the job cap bounds each run.
- Off switch: a one-line config PR removing Corduroy's stage; main deploys itself on merge.

## Security

- Corduroy's job is a patroller like the others: the same OIDC token, nonce,
  `--setting-sources user`, and PR text and code read as data. Its template keeps it read-only; the
  runner does not enforce it, as for every patroller today (owner).
- A waiting agent is not live, so no call for it is admitted before its release.
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
- Corduroy's cost or noise spikes: a one-line config PR removes its stage.
- A runs-in-flight deploy: their agents have no `stage`, read as one stage, and finish as before.
- Rollback (`wrangler rollback`): the config is bundled per version, so the old config comes back
  with the old code. A run the new code opened with `waiting` agents fails on the old code's "never
  dispatched" clock; the owner pushes again. No D1 change to undo.

## How we'll know it works

- **Config tests:** shipped `reviewStages` and `designRoles`. Refused: an unknown role, `groomer`,
  a duplicate role across stages, an empty stage, zero stages, and a `designRoles` without
  `granite-chief` or `kt-22`. `withReviewRoles` pins one stage.
- **Machine tests:**
  - Stage 2 starts `waiting`: no dispatch and no deadline.
  - Stage 1 all passing: stage 2 queued and dispatched, check still in progress, titled
    `· stage 2 of 2`.
  - Stage 1 hazards or a failed agent: stage 2 skipped, its summary naming stage 1's agents, outcome
    `hazards` or `failed`.
  - The bypass and a retry each release a skipped stage once stage 1 turns passing.
  - A panel filter that empties a stage drops it.
  - A skipped agent never passes.
  - Stop and land halt waiting agents, and leave skipped ones as they are.
  - A stored agent without `stage` reads as stage 0.
  - A stage-2 agent's hazards or failure decide the outcome; a retried stage-2 agent keeps its stage
    and stage 1 is not re-run.
  - A stage-1 `hazards` verdict that lists none holds stage 2, as `reviewOutcome` fails it.
  - Three stages: stage 3 is skipped when stage 2 fails, and released only once stages 1 and 2
    pass.
  - A release sets `queued`, `releasedAt` and one dispatch effect per agent; "never dispatched"
    fires from `releasedAt`.
- **Route tests:** an agent call for a waiting agent and a late one for a skipped agent get 410.
- **Dashboard tests:** stage sections and headings; Waiting and Skipped cards; the detail pane's
  one-line reasons, with no job link or transcript control; a one-stage run unchanged.
- **Plugin tests:** the panel lines read `designRoles` and always name `builder`, `granite-chief`
  and `kt-22`; Corduroy's lens rule; at most 40 lines.
- **Patrol template tests:** `corduroy.md`'s read-only rule, hazard classes and docs-only rule, at
  most 40 lines; `granite-chief.md`'s panel rules name `designRoles`, BLD, GOAL and SEC.
- **e2e:** a new `stages.spec.ts`:
  - A PR dispatches Granite Chief and Mainline, and no Corduroy job; both clear → Corduroy is
    dispatched; it clears → success.
  - A Mainline hazard → Corduroy never dispatched, its card reads Skipped, and the check fails.
  - The other specs adapted.
- **Evidence after deploy:** the first patrolled code PR shows Corduroy dispatched only after
  Mainline cleared.
- **Hand check after §2 deploys,** since a model's judgment has no fixed output to assert: four
  throwaway PRs, one each with duplicated logic, a broken repo pattern, a needless wrapper, and dead
  code, each fail on a Corduroy hazard citing file:line. The results go in §2's PR.
- **Hand check after §3 deploys:** the next design PR's panel holds BLD, GOAL and SEC, and Granite
  Chief's design-PR rules pass it.

## Approaches

1. **Stages inside the sweep step (picked, owner):** one config list of ordered stages, gated in
   one place; any number of stages; the dashboard stays one review step.
2. **A new run step after the sweep:** its own dashboard row, but a new step type across the
   machine, labels, dashboard and tests, and fixed at two phases.
3. **A new roster role for hygiene:** rejected by the owner, who chose to extend Corduroy; it would
   also have split one reviewer's work between two.

## Delivery

Order: §1 first; §2 and §3 after it, in either order. §2's shipped `reviewStages` and §3's
`designRoles` reader need §1's config keys on main.

- §1 Review phases by config: `reviewStages` and `designRoles`, the staged sweep, the `waiting` and
  `skipped` statuses, the dashboard's stage sections, and tests. Shipped `reviewStages` stays one
  stage, `[["granite-chief", "mainline"]]`, so nothing changes for PRs yet.
- §2 Corduroy's hygiene review: `.basetobase/patrol/corduroy.md`, its lens rule, shipped
  `reviewStages` `[["granite-chief", "mainline"], ["corduroy"]]`, and the e2e specs.
- §3 The design side reads the config: `SKILL.md`'s panel rules, Granite Chief's design-PR panel
  rules, and the plugin tests.

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

## Left to the builder

- Whether §1 to §3 land as one PR or three.
- Config validation messages.

## Design review

Panel: GOAL, INF, SCL, SEC, FUN, QLT, UX, DSN, BLD. Why: full design that changes the dashboard's patrol cards, a screen.

Round 1:
- GOAL-1 Goal ships Corduroy as a PR reviewer; a non-goal says not to turn on more
- GOAL-2 No test separates a Corduroy hazard from taste: owner: every hygiene problem Corduroy finds blocks, with file:line evidence
- GOAL-3 Granite Chief design-PR rule undefined when config file is absent, so panels can disagree: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- GOAL-4 Arbitrary N ordered stages where one gated Corduroy step meets the success line: owner: any number of stages (approach 1)
- INF-1 Job timeout cited as 30 minutes; the workflow sets 25
- INF-2 Cost has no unit price and no monthly total: owner: no cost cap; the job cap bounds each run, a config PR is the off switch, a timed-out job is retried
- INF-3 Pay-per-use Corduroy job has no volume or spend cap: owner: no cost cap; the job cap bounds each run, a config PR is the off switch, a timed-out job is retried
- INF-4 No way to switch the paid Corduroy stage off without a deploy: owner: no cost cap; the job cap bounds each run, a config PR is the off switch, a timed-out job is retried
- SCL-1 Stated 30-minute job timeout contradicts the workflow's 25 minutes
- SCL-2 Stage count is unbounded, so review latency grows linearly and is not worked at 10x
- SCL-3 Corduroy's input size is bounded by time, not by diff size: owner: no cost cap; the job cap bounds each run, a config PR is the off switch, a timed-out job is retried
- SCL-4 Cost is stated per PR, but the unit of dispatch may be a run per push: owner: nonce with the run and not live until released, releasedAt, docs-only PRs clear, §1 first, a run per push plus retries
- SCL-5 Outbound calls per verdict event in advanceStages are not named: owner: nonce with the run and not live until released, releasedAt, docs-only PRs clear, §1 first, a run per push plus retries
- SEC-1 Config change control is a PR to basetobase/**, which the patrol never reviews: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- SEC-2 Security floor of the design panel moves from a fixed list to editable config: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- SEC-3 Config validation leaves fail-open values open: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- SEC-4 Corduroy job's tools, credentials and checkout are not stated: owner: Corduroy is read-only by its template, not enforced by the runner
- FUN-1 Retry drops `stage`, so a retried stage-2 agent reads as stage 0
- FUN-2 Stage gate's 'clear' disagrees with reviewOutcome's 'flagged'
- FUN-3 No test shows Corduroy flagging the code defects named as success
- FUN-4 Failure and edge cases of the staged sweep with no test
- FUN-5 designRoles: required members and empty list undefined; patrol rule untested: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- QLT-1 advanceStages derives 'clear' separately from reviewOutcome, so the two can disagree
- QLT-2 retryAgents rebuilds the agent without stage; the design never says retry keeps it
- QLT-3 Design-panel rules are moved to designRoles in one line and left hardcoded in four others: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- QLT-4 designRoles and reviewStages validation admits groomer, which has no lens or panel: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- QLT-5 Exhaustive AgentStatus maps in shared/ are not named; the 'Waits for stage 1' label has no home
- QLT-6 New Corduroy lens rule duplicates the Granite Chief lens, and 'Duplication: none' does not say so
- QLT-7 withEnabledRoles and ENABLED_ROLES keep names that no longer describe what they pin
- UX-1 Stage groups: heading semantics, keyboard order and 320 px layout not stated: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- UX-2 'Waits for stage 1' label is wrong for stage 3 or later and its source is unnamed: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- UX-3 Detail view for a selected waiting or skipped card is not stated: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- UX-4 Next action for a failed run with skipped cards is not shown to the person: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- UX-5 Progress shown while stage 2 runs and total-time expectation are not stated: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- UX-6 Grouping cards by stage versus keeping the flat grid with a per-card stage tag: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- DSN-1 Stage group headings have no stated look, layout or contrast: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- DSN-2 The `waiting` label depends on the stage, but status labels are static: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- DSN-3 What a selected waiting or skipped card shows in the detail pane is not drawn: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- BLD-1 retryAgents rebuilds the agent without `stage`, so a retried agent drops to stage 0
- BLD-2 `releasedAt` is used but never declared on AgentSnapshot: owner: nonce with the run and not live until released, releasedAt, docs-only PRs clear, §1 first, a run per push plus retries
- BLD-3 advanceStages needs a nonce source that bypassDesign and closeSweepIfDone do not have: owner: nonce with the run and not live until released, releasedAt, docs-only PRs clear, §1 first, a run per push plus retries
- BLD-4 designRoles validation and how the design skill combines it with its size, screen and builder rules: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- BLD-5 Granite Chief's rewritten panel rule is silent on short designs, a missing config, and id-to-prefix mapping: owner: designRoles must hold Granite Chief and KT-22, is read from main by the skill and Granite Chief alike, every lens without the file; groomer refused; the owner merges config
- BLD-6 corduroy.md has no rule for design PRs, which stage 2 will dispatch it on: owner: nonce with the run and not live until released, releasedAt, docs-only PRs clear, §1 first, a run per push plus retries
- BLD-7 Skipped summary is both fixed and left to the builder
- BLD-8 Stage numbering mixes 0-based storage and 1-based prose, and the heading for stage 3 and later is open: owner: a section per stage, Waiting and Skipped labels, a one-line reason in the detail pane, stage k of n in the check title
- BLD-9 Order between §1, §2 and §3 is left open, and §3 depends on §1: owner: nonce with the run and not live until released, releasedAt, docs-only PRs clear, §1 first, a run per push plus retries
