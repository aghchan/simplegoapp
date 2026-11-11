# Review phases by config, and Corduroy's code-hygiene review

- Size: full
- Status: in review
- From: the owner's conversation of 2026-11-11 (https://claude.ai/code/session_01M8sD8mMdENrvRWzJ5M9QMD)

## What we're building

Which specialists review in each phase becomes configuration, and Corduroy (Code quality) takes on
code hygiene in both phases.

- **Two phases, set in `basetobase/config/basetobase.json`:**
  - `designRoles`: the specialists whose lenses challenge a design before code
    (`standard:system-design`).
  - `reviewStages`: the specialists who review a pull request's code after implementation (the
    Base to Base patrol), as ordered stages, e.g. `[["granite-chief", "mainline"], ["corduroy"]]`.
    It replaces `enabledRoles`.
- **Stages run in order.** A stage's agents run together. The next stage starts only once every
  agent of every earlier stage is in and clear, the owner's design bypass included. When a stage
  ends with a hazard or a failed agent, the later stages' agents are `skipped` and never dispatched.
- **Corduroy reviews code hygiene:** following the codebase's own patterns, KISS, DRY, and no
  excess or redundant code.
  - A PR patrol template, `.basetobase/patrol/corduroy.md`, in a second stage after Granite Chief
    and Mainline, the end-to-end test.
  - New rules in its design lens, `plugins/standard/skills/system-design/lenses/corduroy.md`.
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
  - A PR with duplicated logic, a broken codebase pattern, a needless abstraction or dead code fails
    the *Base to Base* check on a Corduroy hazard citing file:line.
  - A PR whose end-to-end test fails never dispatches Corduroy; its card reads skipped.
  - Moving a specialist between phases or stages is a one-line config edit.

## Goals, non-goals, anti-goals

**Goals**
- `designRoles` and `reviewStages` in the config, read by the design skill and by the patrol.
- Ordered review stages, each gated on every earlier stage being clear.
- Corduroy's hygiene rules in both phases; Corduroy in stage 2 of the shipped config.

**Non-goals**
- A new roster role (owner: extend Corduroy's scope instead).
- A non-blocking "notes" field in the verdict contract: taste-level points go in Corduroy's summary.
- Turning on PR reviewers beyond Corduroy now; the config allows it later.
- Per-repository config for other projects patrolled from this Worker (part 3).
- The huddle and Groomer (M3).

**Anti-goals**
- Corduroy blocking merges on taste, naming or formatting.
- A later stage spending a job on code whose earlier stage failed.
- A waiting agent timing out, or holding the check open forever, while an earlier stage runs.
- A skipped agent counting toward a pass.
- Pass or fail derived anywhere but `reviewOutcome`.
- The design skill, Granite Chief's design-PR rules and the config disagreeing on who sits on a
  design panel.

## Fit with existing features

**Config** (`basetobase/config/basetobase.json`, `basetobase/shared/src/config.ts`)
- `enabledRoles: RoleId[]` becomes `reviewStages: RoleId[][]`. Validation: each id in the roster;
  a role at most once across all stages; no empty stage; zero stages allowed (outcome `none`, as an
  empty `enabledRoles` is today).
- New `designRoles: RoleId[]`: roster ids, no duplicates. Shipped: all eight specialists, today's
  panel.
- `withEnabledRoles(cfg, csv)` and the test-only `ENABLED_ROLES` binding are renamed
  `withReviewRoles` and `REVIEW_ROLES`, and pin `reviewStages` to one stage of the listed roles.
  Every place that names them changes with them: `dispatch/src/run/do.ts:92`,
  `dispatch/src/env.ts:17-18`, the dispatch vitest binding (`dispatch/vitest.config.ts:21`,
  `"mainline"`), `dispatch/test/machine.test.ts:57`, `dispatch/test/seed.ts:9`. Their runs keep one
  Mainline agent, as now.
- Every reader of `enabledRoles` changes: `dispatch/src/run/machine.ts:87`,
  `shared/test/config.test.ts`, `dispatch/test/machine.test.ts` (fixtures `PATROL` and others).

**Run machine** (`basetobase/dispatch/src/run/machine.ts`)
- `AgentSnapshot` gains `stage: number`, its index in `reviewStages`. A stored agent without it
  reads as stage 0, so runs open at deploy finish as one stage.
- `AgentStatus` (`shared/src/types.ts:15`) gains `waiting` (a later stage's agent, not yet
  dispatched) and `skipped` (an earlier stage did not pass), and so does every exhaustive map of it:
  `AGENT_STATUS_LABELS` (`shared/src/labels.ts:48`) and `AGENT_TONES` (`PatrolCards.tsx:6`). `skipped` is terminal (`isTerminal`, :597); `waiting` is not, and has no
  deadline (`deadlinesOf`, :611), no nonce and no job.
- `createRun` (:74) builds every stage's agents on the PR's panels; a stage left empty by the panel
  filter is dropped and the later ones renumbered. Stage 0 starts `queued` and is dispatched as now;
  later stages start `waiting`.
- A new step in `closeSweepIfDone` (:788), `advanceStages`, runs after every verdict, failure,
  retry and bypass:
  - Passing is one predicate, `passes(s, agent)`, which `reviewOutcome` uses too: status `clear`,
    or `hazards` with a non-empty list whose every hazard the owner waived (`openHazards` empty).
    `error`, `stopped`, `stalled`, `skipped`, and a `hazards` verdict that lists none, never pass.
  - The first stage with an agent not in, or not passing, is the current one.
  - All its agents in and all clear: the next stage's `waiting` or `skipped` agents become
    `queued`, get a nonce, `releasedAt` and a dispatch effect; the sweep and the run stay open.
  - All its agents in and any not clear: every later-stage agent not in becomes `skipped`, summary
    `Skipped: an earlier stage did not pass.`, and the sweep closes as today.
- `reviewOutcome` (:529) reads `passes` for every agent. A `skipped` agent never passes: its earlier
  stage already fails the review, and a run whose only non-passing agents are skipped reads
  `failed`, fail-closed.
- `retryAgents`' rebuild of a retried agent (:318) keeps `stage` with its id, role, step and round,
  so a retried stage-2 agent stays in stage 2. `releasedAt` is dropped: `retriedAt` runs its clock.
- `retryAgents` (:304) and `bypassDesign` (:381) end in `advanceStages`, so a stage that turns clear
  releases the skipped stage after it. A skipped agent is not retryable itself (`retryableAgents`,
  :294).
- `deadlinesOf`: a released agent's "never dispatched" clock runs from `releasedAt`
  (`retriedAt ?? releasedAt ?? createdAt`).
- `conditionsReport`, `failureTitle`, `checkSummary`: the tally adds `N skipped` when there are any;
  the in-progress check title stays `<run> · patrol sweep`.
- `halted` (:657, stop and land): `waiting` agents become `stopped` like any agent not in; they have no job
  to cancel.

**RunDO and routes** (`dispatch/src/run/do.ts`, `dispatch/src/routes/agent.ts`)
- No new route. A `waiting` agent has no nonce, so any agent call for it gets 403 (`authorize`).
- The dispatch effect is unchanged; a released agent's dispatch is the same call as stage 0's.

**Dashboard** (`basetobase/dashboard/src/components/PatrolCards.tsx`, `StepDetail.tsx`)
- Patrol cards group by stage when a run has more than one: `Stage 1`, `Stage 2 · after stage 1
  passes`.
- Tones (`AGENT_TONES`, `PatrolCards.tsx:6`): `waiting` idle with the label "Waits for stage 1",
  `skipped` idle with "Skipped".
- The retry button (`retryable`) and the bypass button (`bypassable`) are unchanged.

**Patrol templates** (`.basetobase/patrol/`)
- New `corduroy.md`, house style, at most 40 lines. Hazards: logic duplicated from existing code
  (both file:lines); a broken codebase pattern (the CLAUDE.md rule it breaks); a needless layer,
  interface, wrapper or option no caller needs; dead or redundant code (unused function, export,
  parameter, branch or flag; commented-out code; a hand-rolled copy of a function the repo or its
  dependencies already provide). Taste, naming and formatting go in its summary, never a hazard.
- `granite-chief.md:29`, the design-PR panel rule, reads `designRoles` on the base instead of a
  fixed prefix list: the panel must hold BLD, and for `Size: full` the prefix of every
  `designRoles` role but `magic-carpet` and `bluebird`.

**Design skill and lens** (`plugins/standard/`)
- `skills/system-design/SKILL.md`, "Size and panel": the lenses come from `designRoles` in
  `basetobase/config/basetobase.json` when that file exists, else every lens. The size, screen and
  builder rules apply within them.
- `lenses/corduroy.md` extends its rule at :6 in place, under 40 lines: a new abstraction, service,
  table, layer, wrapper, option or config key that no existing caller or stated need in the repo
  requires → `defend`. Scope beyond the goals stays Granite Chief's (`lenses/granite-chief.md:10`).
- `standard_test.go` `TestSkillReferences` pins the new panel lines; `plugins/standard` stays
  version 0.1.0 until its first release.

**e2e** (`basetobase/e2e/`)
- The shipped config gives a run three agents in two stages. `bypass.spec.ts`, `retry.spec.ts`,
  `live.spec.ts` and `sync.spec.ts` patrol Corduroy once stage 1 clears, or expect it skipped.

**Duplication:** none. Stages extend the sweep step; no second review path. Corduroy's lens rule
extends its own rule rather than restating Granite Chief's scope rule.

**Docs:** `basetobase/CLAUDE.md` (Patrol, `ENABLED_ROLES`), `.basetobase/CLAUDE.md`,
`basetobase/e2e/CLAUDE.md`, `plugins/CLAUDE.md`. This design supersedes `enabledRoles` in the
Base to Base design (2026-10-20, §6) and the fixed panel lists in the system-design flow design
(2026-10-24, §3 and §5); those files are not edited.

## API contract

None. `api/v1/openapi.yml` is untouched: this changes Base to Base, not the Go API. The dashboard's
own `RunSnapshot` gains `agent.stage` and two statuses; the Worker serves the SPA it ships with, so
both change in one deploy.

## Data model and migrations

None in D1: the `runs` index stores no agents. A RunDO's stored state gains an optional `stage` per
agent and may hold the two new statuses. Runs stored before the deploy have no `stage` and read as
one stage, so no migration.

## Scaling

- One owner, a few PRs a day, at most eight agents a run; `advanceStages` walks at most eight
  agents per event.
- Per patrolled PR: one more Actions job (Corduroy, sonnet, about 5 to 10 minutes), only when
  stage 1 passes.
- Review time is the sum of the stages, each as long as its slowest job. A job is capped at 25
  minutes on GitHub (`.github/workflows/basetobase-agent.yml:36`) and 30 on the Worker's clock
  (`AGENT_TIMEOUT_MS`, `machine.ts:24`), after up to 30 minutes in GitHub's queue (`JOB_START_MS`).
  Typical two-stage review: about 15 to 20 minutes. Worst case: about 50 minutes of jobs plus
  queueing.
- The stage count is not capped: worst-case review time grows by one job cap per stage. Accepted,
  since the owner sets the stages.
- Corduroy reads the diff and the files it touches: a large PR costs more tokens, bounded by the
  25-minute job cap.

## Infrastructure and dependencies

- No new service or library.
- Config keys: `enabledRoles` is replaced by `reviewStages`; `designRoles` is new.
- Cost: one more Claude (sonnet) job and its Actions minutes per patrolled PR whose stage 1 passes.

## Security

- Corduroy's job is a patroller like the others: the same OIDC token, nonce,
  `--setting-sources user`, and PR text and code read as data.
- A waiting agent has no nonce until released, so no job can report for it early.
- The config changes only through a PR to `basetobase/**`.
- No new secrets or personal data.

## Failure and rollback

- A stage-1 hazard or failed agent: stage 2 is skipped, and the check fails on stage 1's findings.
- Corduroy's job fails: the review fails on a failed agent, and the owner retries it as today.
- A dispatch of a released agent lost: "never dispatched" fires from `releasedAt`.
- The owner bypasses after stage 2 was skipped: stage 1 turns clear and stage 2 is released.
- A runs-in-flight deploy: their agents have no `stage`, read as one stage, and finish as before.
- Rollback (`wrangler rollback`): the config is bundled per version, so the old config comes back
  with the old code. A run the new code opened with `waiting` agents fails on the old code's "never
  dispatched" clock; the owner pushes again. No D1 change to undo.

## How we'll know it works

- **Config tests:** shipped `reviewStages` and `designRoles`; an unknown role, a duplicate role
  across stages, and an empty stage are refused; `withEnabledRoles` pins one stage.
- **Machine tests:**
  - Stage 2 starts `waiting`: no dispatch, no deadline, no nonce.
  - Stage 1 all clear: stage 2 queued and dispatched, check still in progress.
  - Stage 1 hazards or a failed agent: stage 2 skipped, outcome `hazards` or `failed`.
  - The bypass and a retry each release a skipped stage once stage 1 turns clear.
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
- **Route test:** an agent call for a waiting agent gets 403.
- **Dashboard tests:** stage groups; waiting and skipped cards.
- **Plugin tests:** the panel lines read `designRoles`; Corduroy's lens rules; at most 40 lines.
- **Patrol template test:** `corduroy.md`'s hazard classes, and at most 40 lines.
- **e2e:** a new `stages.spec.ts`:
  - A PR dispatches Granite Chief and Mainline, and no Corduroy job; both clear → Corduroy is
    dispatched; it clears → success.
  - A Mainline hazard → Corduroy never dispatched, its card reads Skipped, and the check fails.
  - The other specs adapted.
- **Evidence after deploy:** the first patrolled code PR shows Corduroy dispatched only after
  Mainline cleared.
- **Hand check after §2 deploys,** since a model's judgment has no fixed output to assert: four
  throwaway PRs, one each with duplicated logic, a broken repo pattern, a needless wrapper, and dead
  code, each fail on a Corduroy hazard citing file:line; a fifth with only naming and formatting
  changes passes. The results go in §2's PR.

## Approaches

1. **Stages inside the sweep step (picked, owner):** one config list of ordered stages, gated in
   one place; any number of stages; the dashboard stays one review step.
2. **A new run step after the sweep:** its own dashboard row, but a new step type across the
   machine, labels, dashboard and tests, and fixed at two phases.
3. **A new roster role for hygiene:** rejected by the owner, who chose to extend Corduroy; it would
   also have split one reviewer's work between two.

## Delivery

- §1 Review phases by config: `reviewStages` and `designRoles`, the staged sweep, the `waiting` and
  `skipped` statuses, the dashboard's stage groups, and tests. Shipped `reviewStages` stays one
  stage, `[["granite-chief", "mainline"]]`, so nothing changes for PRs yet.
- §2 Corduroy's hygiene review: `.basetobase/patrol/corduroy.md`, its lens rules, shipped
  `reviewStages` `[["granite-chief", "mainline"], ["corduroy"]]`, and the e2e specs.
- §3 The design side reads the config: `SKILL.md`'s panel rules, Granite Chief's design-PR panel
  rule, and the plugin tests.

## Decisions

- Extend Corduroy's scope instead of adding a specialist. **(owner)**
- Corduroy reviews every PR's code as well as designs. **(owner)**
- Each phase's specialists are configurable: some or all for the design phase, others for the
  post-implementation review. **(owner)**
- Corduroy's PR review is a step after the end-to-end test and runs only when the tests pass.
  **(owner)**
- Stages inside the sweep step, `reviewStages` replacing `enabledRoles` (approach 1). **(owner)**
- "The tests pass" means every agent of every earlier stage is clear, not Mainline alone, and the
  owner's bypass counts. **(designer's call)**
- Taste-level points go in Corduroy's summary; hazards only for duplication, a broken codebase
  pattern, a needless abstraction, and dead or redundant code. **(designer's call)**
- `designRoles` lives in the same config file; the skill uses every lens when the file is absent.
  **(designer's call)**
- `ENABLED_ROLES` and `withEnabledRoles` are renamed `REVIEW_ROLES` and `withReviewRoles`, and pin
  one stage. **(designer's call)**
- One predicate, `passes`, decides both the stage gate and `reviewOutcome`. **(designer's call)**
- A retried agent keeps its stage. **(designer's call)**
- A role appears at most once across stages. **(designer's call)**
- Skipped agents fail closed, and are released when their earlier stages turn clear.
  **(designer's call)**
- A waiting agent gets its nonce when released, not when created. **(designer's call)**
- Shipped `designRoles`: all eight specialists. **(designer's call)**

## Left to the builder

- Whether §1 to §3 land as one PR or three.
- Config validation messages.

## Design review

Panel: GOAL, INF, SCL, SEC, FUN, QLT, UX, DSN, BLD. Why: full design that changes the dashboard's patrol cards, a screen.

Round 1:
- GOAL-1 Goal ships Corduroy as a PR reviewer; a non-goal says not to turn on more
- GOAL-2 No test separates a Corduroy hazard from taste
- GOAL-3 Granite Chief design-PR rule undefined when config file is absent, so panels can disagree
- GOAL-4 Arbitrary N ordered stages where one gated Corduroy step meets the success line
- INF-1 Job timeout cited as 30 minutes; the workflow sets 25
- INF-2 Cost has no unit price and no monthly total
- INF-3 Pay-per-use Corduroy job has no volume or spend cap
- INF-4 No way to switch the paid Corduroy stage off without a deploy
- SCL-1 Stated 30-minute job timeout contradicts the workflow's 25 minutes
- SCL-2 Stage count is unbounded, so review latency grows linearly and is not worked at 10x
- SCL-3 Corduroy's input size is bounded by time, not by diff size
- SCL-4 Cost is stated per PR, but the unit of dispatch may be a run per push
- SCL-5 Outbound calls per verdict event in advanceStages are not named
- SEC-1 Config change control is a PR to basetobase/**, which the patrol never reviews
- SEC-2 Security floor of the design panel moves from a fixed list to editable config
- SEC-3 Config validation leaves fail-open values open
- SEC-4 Corduroy job's tools, credentials and checkout are not stated
- FUN-1 Retry drops `stage`, so a retried stage-2 agent reads as stage 0
- FUN-2 Stage gate's 'clear' disagrees with reviewOutcome's 'flagged'
- FUN-3 No test shows Corduroy flagging the code defects named as success
- FUN-4 Failure and edge cases of the staged sweep with no test
- FUN-5 designRoles: required members and empty list undefined; patrol rule untested
- QLT-1 advanceStages derives 'clear' separately from reviewOutcome, so the two can disagree
- QLT-2 retryAgents rebuilds the agent without stage; the design never says retry keeps it
- QLT-3 Design-panel rules are moved to designRoles in one line and left hardcoded in four others
- QLT-4 designRoles and reviewStages validation admits groomer, which has no lens or panel
- QLT-5 Exhaustive AgentStatus maps in shared/ are not named; the 'Waits for stage 1' label has no home
- QLT-6 New Corduroy lens rule duplicates the Granite Chief lens, and 'Duplication: none' does not say so
- QLT-7 withEnabledRoles and ENABLED_ROLES keep names that no longer describe what they pin
- UX-1 Stage groups: heading semantics, keyboard order and 320 px layout not stated
- UX-2 'Waits for stage 1' label is wrong for stage 3 or later and its source is unnamed
- UX-3 Detail view for a selected waiting or skipped card is not stated
- UX-4 Next action for a failed run with skipped cards is not shown to the person
- UX-5 Progress shown while stage 2 runs and total-time expectation are not stated
- UX-6 Grouping cards by stage versus keeping the flat grid with a per-card stage tag
- DSN-1 Stage group headings have no stated look, layout or contrast
- DSN-2 The `waiting` label depends on the stage, but status labels are static
- DSN-3 What a selected waiting or skipped card shows in the detail pane is not drawn
- BLD-1 retryAgents rebuilds the agent without `stage`, so a retried agent drops to stage 0
- BLD-2 `releasedAt` is used but never declared on AgentSnapshot
- BLD-3 advanceStages needs a nonce source that bypassDesign and closeSweepIfDone do not have
- BLD-4 designRoles validation and how the design skill combines it with its size, screen and builder rules
- BLD-5 Granite Chief's rewritten panel rule is silent on short designs, a missing config, and id-to-prefix mapping
- BLD-6 corduroy.md has no rule for design PRs, which stage 2 will dispatch it on
- BLD-7 Skipped summary is both fixed and left to the builder
- BLD-8 Stage numbering mixes 0-based storage and 1-based prose, and the heading for stage 3 and later is open
- BLD-9 Order between §1, §2 and §3 is left open, and §3 depends on §1
