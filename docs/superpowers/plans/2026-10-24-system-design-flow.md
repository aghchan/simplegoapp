# System Design Before Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship part 1 of the development standard. Every change bigger than a simple bug fix gets a templated system design that the patrol's specialists challenge until quorum. Granite Chief holds the code PR to it, and only the owner can bypass it.

**Architecture:** The template, the specialists' design lenses, the `system-design` skill and the standard's session rules ship as a Claude Code plugin (`standard`) from a marketplace (`simplegoapp`) at this repo's root. It reaches sessions as a claude.ai account plugin (spec §9); projects declare nothing. Base to Base gains Granite Chief on the PR patrol, an owner-only bypass of its missing-design finding, and a list of designs still owed after a bypass.

**Tech Stack:** Claude Code plugins (marketplace.json, plugin.json, hooks, skills), bash, Go tests, TypeScript (Cloudflare Worker, D1, React), Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-10-24-system-design-flow-design.md (approved 2026-10-24).

## Global Constraints

- Marketplace name `simplegoapp`, at `.claude-plugin/marketplace.json`. Plugin name `standard`, at `plugins/standard/`. Skill `standard:system-design`.
- `claude plugin validate . --strict` and `claude plugin validate plugins/standard --strict` pass.
- No `CLAUDE.md` inside `plugins/standard/` (validate warns). Plugin conventions go in `plugins/CLAUDE.md`.
- Agent-read text follows the house style (.basetobase/CLAUDE.md): one imperative rule per line, no preamble, rationale or politeness. Each lens and patrol template has at most 40 non-empty lines.
- Specialist prefixes come from the roster: GOAL, QLT, SCL, INF, SEC, FUN, UX, DSN. The builder lens's prefix is BLD.
- The missing-design hazard title is exactly `No approved design` (`NO_DESIGN_TITLE`).
- A PR names its design with `Design: <path>` or `Design: <path> §<n>`. A bug fix names its promise with `Fixes: <path>`. An after-the-fact design names its PR with `For: #<n>`.
- TypeScript: erasable only, relative `.ts` imports (basetobase/CLAUDE.md). Go: house style (receivers `this`).
- Mutating `/api/*` calls need `Origin` equal to `PUBLIC_URL`'s origin (already enforced).
- Commits end with the session's attribution lines.

## Review Focus

- **A Granite Chief verdict with "No approved design" plus another hazard:** the bypass waives only the first, and the review still fails on the other. Test: Task 7.
- **"For: #12" in a design PR:** it clears PR 12's owed design, never PR 1's or PR 123's. Test: Task 8.
- **A rules file containing quotes, backslashes, tabs or newlines:** the session-start hook still prints valid JSON, and the context matches the file byte for byte. Test: Task 2.
- **A bypass asked for before Granite Chief has reported, or on a stopped or landed run:** answered 409, with nothing changed. Test: Task 7 (machine) and Task 8 (API).
- **A new push after a bypass:** the new run starts unbypassed, and Granite Chief's finding counts again. Test: Task 7.

---

## File structure

```
.claude-plugin/marketplace.json                 marketplace "simplegoapp", lists plugin "standard"
plugins/CLAUDE.md                               conventions for plugins in this repo
plugins/standard/.claude-plugin/plugin.json     manifest: name, version, description, author
plugins/standard/rules.md                       the standard's session rules (agent-read)
plugins/standard/hooks/hooks.json               SessionStart → hooks/session-start
plugins/standard/hooks/session-start            prints rules.md as SessionStart additionalContext
plugins/standard/skills/system-design/SKILL.md  the challenge loop
plugins/standard/skills/system-design/template.md
plugins/standard/skills/system-design/lenses/   _challenge.md, builder.md, one <role-id>.md per specialist
plugins/standard/doc.go, standard_test.go       Go tests: hook output, template, lenses, skill paths
.basetobase/patrol/granite-chief.md             Granite Chief's PR patrol template
basetobase/shared/src/design.ts                 NO_DESIGN_TITLE, coversOf(goal)
basetobase/dispatch/migrations/0003_design_bypass.sql
```

---

### Task 1: Spike: does a repo-enabled plugin install itself in a cloud session?

The spec (§9) makes this a gate. If the answer is no, stop after this task, and bring the owner the fallback options.

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/standard/.claude-plugin/plugin.json`
- Create: `plugins/standard/hooks/hooks.json`
- Create: `plugins/standard/hooks/session-start`
- Create: `plugins/standard/rules.md`
- Create: `plugins/standard/skills/system-design/SKILL.md` (stub)
- Create: `.claude/settings.json`
- Modify: `docs/superpowers/specs/2026-10-24-system-design-flow-design.md` §9 (record the result)

**Interfaces:**
- Produces: the plugin skeleton and settings that Task 2 fills in.

- [ ] **Step 1: Write the manifest, marketplace and settings**

  - **marketplace.json:** `{"name":"simplegoapp","owner":{"name":"aghchan"},"plugins":[{"name":"standard","source":"./plugins/standard","description":"simplegoapp's development standard: system design before code"}]}`.
  - **plugin.json:** `name` `standard`, `version` `0.1.0`, `description`, `author.name` `aghchan`.
  - **hooks.json:** one `SessionStart` entry with matcher `startup|clear|compact`, running the command `"${CLAUDE_PLUGIN_ROOT}"/hooks/session-start` (shell form, double-quoted).
  - **rules.md:** the single line `STANDARD-SPIKE-7f3a`.
  - **SKILL.md stub:** frontmatter `name: system-design` and `description: Spike stub.`
  - **The hook:** emits `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":<rules.md>}}`. Make it executable.
  - **`.claude/settings.json`:** write it with the CLI, which owns its format: `claude plugin marketplace add aghchan/simplegoapp#claude/cicd-always-on-agent-q922hp --scope project`, then `claude plugin install standard@simplegoapp --scope project`. Run them after Step 3's push, since they clone from GitHub.

- [ ] **Step 2: Validate locally**

Run: `claude plugin validate . --strict && claude plugin validate plugins/standard --strict`
Expected: `✔ Validation passed` twice.

Run: `CLAUDE_PLUGIN_ROOT=plugins/standard bash plugins/standard/hooks/session-start | python3 -m json.tool`
Expected: JSON whose `hookSpecificOutput.additionalContext` is `STANDARD-SPIKE-7f3a\n`.

- [ ] **Step 3: Commit and push the skeleton, then add the settings**

Commit and push the plugin files, run the two Step 1 CLI commands, then commit and push `.claude/settings.json`.

- [ ] **Step 4: Ask a fresh cloud session**

Call `mcp__claude-code-remote__create_session` with:
- `source_url`: `https://github.com/aghchan/simplegoapp`
- `source_revision`: `claude/cicd-always-on-agent-q922hp`
- `title`: `Spike: does the standard plugin load?`
- `prompt`: `Change nothing. Answer three lines: 1) Is a skill named standard:system-design available to you (yes/no)? 2) Does your context contain the text STANDARD-SPIKE-7f3a (yes/no)? 3) The output of: claude plugin list`

Read the answer with `mcp__claude-code-remote__list_events` (kinds `assistant`), then archive the session.
Expected: `yes`, `yes`, and `standard@simplegoapp` listed as enabled.

- [ ] **Step 5: Record the result and decide**

Add a "Spike result (date)" paragraph to the spec's §9 with the three answers.
- All three yes: commit and continue to Task 2.
- Anything else: commit the record, stop, and bring the owner the fallback options: a project `SessionStart` hook that installs the plugin, or an account-level install.

---

### Task 2: The standard's rules and the session-start hook

**Files:**
- Modify: `plugins/standard/rules.md`, `plugins/standard/hooks/session-start`
- Create: `plugins/standard/doc.go` (`package standard`, one comment line), `plugins/standard/standard_test.go`
- Create: `plugins/CLAUDE.md`
- Modify: `CLAUDE.md` (root), adding one line naming the plugin as where the standard lives
- Modify: `.github/workflows/ci.yml`, adding job `plugin`

**Interfaces:**
- Produces: `rules.md` as the single source of the session rules, which Task 5's skill refers to.

- [ ] **Step 1: Write the failing tests in `standard_test.go`**

  - **`TestSessionStartEmitsRules`:**
    - Runs `bash hooks/session-start` with `CLAUDE_PLUGIN_ROOT` set to the package directory.
    - Unmarshals stdout.
    - Asserts `hookSpecificOutput.hookEventName == "SessionStart"` and `additionalContext ==` the contents of `rules.md`.
  - **`TestSessionStartEscapes`:**
    - Uses a temp plugin root holding a copy of the hook and a `rules.md` of `a "quote" \ back\tslash\nnew line`.
    - Asserts the JSON parses and the context round-trips exactly.
  - **`TestSessionStartWithoutRules`:** a temp root with no `rules.md` still gives valid JSON, and its context contains `rules.md missing`.

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./plugins/standard/ -run SessionStart -v`
Expected: FAIL. The spike hook doesn't handle a missing file, and `rules.md` is still the spike marker.

- [ ] **Step 3: Write `rules.md` and harden the hook**

`rules.md` holds the rules from the spec's §3 and §8, one imperative line each:
- Anything more than a simple bug fix needs an approved design before code.
- What a simple bug fix is (the spec's §3 definition, word for word).
- When unsure, ask the owner.
- Use the skill `standard:system-design`.
- Its builder lens replaces `superpowers:brainstorming`'s builder check.
- Never skip the design on your own. In an emergency, build and say the PR needs the owner's bypass on the dashboard.
- A code PR carries `Design: <path>` (or `§<n>`) lines, or `Fixes: <path>`.
- A code PR never edits a design file.

The hook reads the file with bash builtins and escapes it for JSON the way superpowers' hook does (backslash, quote, newline, carriage return, tab). A missing file emits the context `standard plugin: rules.md missing`.

- [ ] **Step 4: Run the tests and validation**

Run: `go test ./plugins/standard/ -v && go vet ./... && claude plugin validate plugins/standard --strict`
Expected: PASS, and `✔ Validation passed`.

- [ ] **Step 5: Add the CI job and docs**

- **ci.yml job `plugin`:** `actions/checkout@v6`, `actions/setup-node@v6` with Node 24, then `npx -y @anthropic-ai/claude-code@2.1.292 plugin validate . --strict` and the same for `plugins/standard`.
- **`plugins/CLAUDE.md`:**
  - the layout
  - the house style
  - the 40-line limit
  - no CLAUDE.md inside a plugin
  - bump `plugin.json` `version` on each release
  - `go test ./plugins/...` covers the plugin

Run: `/tmp/claude-0/-home-user-simplegoapp/798494db-0e7c-55b7-ab2b-e9a45b95a410/scratchpad/bin/actionlint -shellcheck= .github/workflows/ci.yml`
Expected: no output.

- [ ] **Step 6: Commit**

---

### Task 3: The system design template

**Files:**
- Create: `plugins/standard/skills/system-design/template.md`
- Modify: `plugins/standard/standard_test.go`

**Interfaces:**
- Produces: the 16 headings (exact text below) that Task 4's lenses cite by name and Task 5's skill fills in.

- [ ] **Step 1: Write the failing test `TestTemplateSections`**

It asserts that `template.md` contains these `## ` headings, in this order:
1. `What we're building`
2. `Why`
3. `Goals, non-goals, anti-goals`
4. `Fit with existing features`
5. `API contract`
6. `Data model and migrations`
7. `Scaling`
8. `Infrastructure and dependencies`
9. `Security`
10. `Failure and rollback`
11. `How we'll know it works`
12. `Approaches`
13. `Delivery`
14. `Decisions`
15. `Left to the builder`
16. `Design review`

It also asserts the header block names `Size:` (`full` or `short`), `Status:` (`draft`, `in review`, `approved YYYY-MM-DD`) and `From:`.

- [ ] **Step 2: Run it to see it fail**

Run: `go test ./plugins/standard/ -run TemplateSections -v` → FAIL (no file)

- [ ] **Step 3: Write `template.md`**

- **Each heading** gets a line or two on what goes there, taken from the spec's §4 list, including its examples: requests per second, the `openapi.yml` diff, migrations safe for the version still serving.
- **The size rules** go in one short block at the top:
  - Short means one or two lines per section.
  - "None" needs a reason.
  - Delivery names its parts `§<n>` so PRs can point at them.
- **The Design review section** shows the record's format: the panel and why; per round, each challenge id, title, and how it was settled (`revised §n`, `defended: …`, `owner: …`, `withdrawn`); and the final `Quorum: <prefixes> clear on revision N`.

- [ ] **Step 4: Run the test** → PASS

- [ ] **Step 5: Commit**

---

### Task 4: The specialists' design lenses

**Files:**
- Create: `plugins/standard/skills/system-design/lenses/_challenge.md`, `builder.md`, `granite-chief.md`, `corduroy.md`, `summit-six.md`, `gold-coast.md`, `kt-22.md`, `mainline.md`, `magic-carpet.md`, `bluebird.md`
- Modify: `plugins/standard/standard_test.go`

**Interfaces:**
- Consumes: Task 3's section headings.
- Produces: the challenge JSON contract in `_challenge.md`, which Task 5's skill parses:
  - `role`, `revision`, `status` (`clear` or `challenges`), `summary` (≤1000 chars)
  - `challenges[]`: `id` (`<PREFIX>-<n>`), `section` (a heading from Task 3), `kind` (`unspecified`, `flaw` or `defend`), `title` (≤120 chars), `detail` (≤4000 chars), and `reply` (on re-checks)

- [ ] **Step 1: Write the failing tests**

- **`TestLensPerRole`:** reads `basetobase/config/basetobase.json`. For every roster entry except `groomer`, `lenses/<id>.md` exists. `builder.md` exists too.
- **`TestLensStyle`:** every lens file has at most 40 non-empty lines and starts with a line `Lens: <roster name> — <roster role>` (`Lens: Builder — Plannability` for `builder.md`).
- **`TestChallengeContract`:** `_challenge.md` names every contract field above, the three kinds, and the length limits.
- **`TestGoBlock`:** `corduroy.md` has a `## Go` block naming `domain/`, `api/`, `pkg/http`, `apierror`, `app/` and `main.go`.

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./plugins/standard/ -run 'Lens|Challenge|GoBlock' -v` → FAIL

- [ ] **Step 3: Write the lenses**

- **`_challenge.md`:** the stance from the spec's §5. Adapt `.basetobase/patrol/_verdict.md`'s stance lines to a document, then the contract.
- **Each role lens:** the scope from the spec's §5 table, as attack lines against the sections that lens owns.
- **Language rules** go under a `## Go` heading (Corduroy's dependency directions; KT-22 and Summit Six may add Go lines).
- **`magic-carpet.md` and `bluebird.md`:** first rule, "Only screens. A design with none: clear."
- **`builder.md`:** "Could a builder plan from this without guessing? Each place a wrong guess would matter: one `unspecified` challenge."

- [ ] **Step 4: Run the tests** → PASS

- [ ] **Step 5: Commit**

---

### Task 5: The `system-design` skill

**Files:**
- Modify: `plugins/standard/skills/system-design/SKILL.md`
- Modify: `plugins/standard/standard_test.go`

**Interfaces:**
- Consumes: Task 2's `rules.md`, Task 3's `template.md`, and Task 4's lenses and contract.

- [ ] **Step 1: Write the failing test `TestSkillReferences`**

  - The frontmatter has `name: system-design` and a `description` starting `Use after the what and why are agreed`.
  - Every `${CLAUDE_PLUGIN_ROOT}/…` path in the body exists under `plugins/standard/`.
  - The body names `template.md`, `lenses/_challenge.md` and the panel rule for each size.

- [ ] **Step 2: Run it to see it fail** → FAIL (stub)

- [ ] **Step 3: Write `SKILL.md`**

It follows the spec's §3 and §5–§7, one imperative line each, and references files as `${CLAUDE_PLUGIN_ROOT}/skills/system-design/…`.
- **Size and panel:**
  - Full: every lens except `magic-carpet` and `bluebird`, which join only for screens.
  - Short: `granite-chief` plus the lenses whose sections aren't "None".
  - `builder` always.
  - Name the panel in the record.
- **Draft:** fill in the template from the agreed what and why, reading the code each section touches. Save it as `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
- **Sweep:** dispatch one subagent per lens in one message, in parallel. Each gets its lens, `_challenge.md`, the design path and the revision number, and returns the JSON only.
- **Answer:**
  - `unspecified` goes to the owner with a proposed answer.
  - `flaw` and `defend`: revise, or reply with evidence.
  - Open after two answers: goes to the owner.
- **Owner questions:** one message, most important first, each with the challenge, specialist, why the design doesn't settle it, and the proposed answer. Rulings go into Decisions as **(owner)** and close their challenge.
- **Re-check:** every lens on the panel, in parallel, now with all the challenges and replies.
- **Quorum:** every lens `clear` on the same revision. Never give up on your own.
- **Record:** the Design review format from Task 3.
- **Sign-off:** hand the owner the design and the designer's calls. On approval, set the status, commit the design alone, open a PR with only the design, and start code after it merges.
- **Revisions** of an approved design go through the same loop and land before dependent code.
- **After a bypass:** a short design whose PR description says `For: #<n>`.

- [ ] **Step 4: Run the test and validation**

Run: `go test ./plugins/standard/ -v && claude plugin validate plugins/standard --strict` → PASS

- [ ] **Step 5: Commit**

---

### Task 6: Granite Chief joins the PR patrol

**Files:**
- Create: `.basetobase/patrol/granite-chief.md`
- Create: `basetobase/shared/src/design.ts`
- Modify: `basetobase/config/basetobase.json` (`enabledRoles`: `["granite-chief", "mainline"]`)
- Modify: `basetobase/shared/src/config.ts` (add `withEnabledRoles`)
- Modify: `basetobase/dispatch/src/env.ts` (declare `ENABLED_ROLES?: string`, tests only)
- Modify: `basetobase/dispatch/src/run/do.ts` (`start` uses `withEnabledRoles(config, this.env.ENABLED_ROLES)`)
- Modify: `basetobase/dispatch/vitest.config.ts` (binding `ENABLED_ROLES: "mainline"`)
- Test: `basetobase/shared/test/config.test.ts`, `basetobase/shared/test/design.test.ts`

**Interfaces:**
- Produces:
  - `NO_DESIGN_TITLE = "No approved design"` in `shared/src/design.ts`
  - `withEnabledRoles(cfg: B2BConfig, csv: string | undefined): B2BConfig`: returns `cfg` unchanged for `undefined` or `""`; throws `invalid config: ENABLED_ROLES[<i>] must be one of …` for an id not in the roster.

- [ ] **Step 1: Write the failing tests**

- **config.test.ts:**
  - `"enables Granite Chief and Mainline"` expects `config.enabledRoles` to equal `["granite-chief", "mainline"]`.
  - `"withEnabledRoles pins the roles"` maps `"mainline"` to `["mainline"]`.
  - `undefined` leaves `cfg` unchanged.
  - `"nope"` throws `/ENABLED_ROLES\[0\]/`.
- **design.test.ts:** reads the repo root's `.basetobase/patrol/granite-chief.md` (`new URL("../../../.basetobase/patrol/granite-chief.md", import.meta.url)`) and asserts that it:
  - contains `No approved design`, `Design:`, `Fixes:`, `git show` and `docs/superpowers/specs/`
  - has at most 40 non-empty lines

- [ ] **Step 2: Run them to see them fail**

Run: `cd basetobase && npx vitest run shared/test/config.test.ts shared/test/design.test.ts` → FAIL

- [ ] **Step 3: Write the template and the seam**

`granite-chief.md` scope (spec §8), one line each:
- **Goal fit:** the change does all of what the goal says, and nothing unasked for.
- **The design:** read each `Design:` line's file as it is on the base: `git show <base SHA>:<path>`. The base SHA is in the prompt's `git diff` line.
- **No design:** no `Design:` line, and either no `Fixes:` line or a change beyond that fix. The fix limit covers contract, schema, config key, dependency and service. Raise exactly one hazard titled `No approved design`.
- **Not approved:** the design isn't marked approved → hazard.
- **Design edited:** a code PR touching any `docs/superpowers/specs/` file → hazard.
- **Drift:** outside the named parts, or leaving out what they include → hazard.
- **Design PRs** (every file under `docs/superpowers/specs/`): status approved, a quorum line on the final revision, no open challenge, and the panel follows the size rule. Otherwise hazard.

Then:
- Set `enabledRoles` in the config.
- Implement `withEnabledRoles` with the existing `oneOf`.
- Wire it into `RunDO.start`.
- Add the vitest binding, so dispatch tests keep their one-agent runs whatever ships.

- [ ] **Step 4: Run the gates**

Run: `cd basetobase && npm run typecheck && npm test`
Expected: PASS. Dispatch tests stay on Mainline through the seam.

- [ ] **Step 5: Commit**

---

### Task 7: The bypass in the run machine

**Files:**
- Modify: `basetobase/shared/src/types.ts` (`RunSnapshot.designBypassedAt?: number`)
- Modify: `basetobase/dispatch/src/run/machine.ts`
- Test: `basetobase/dispatch/test/machine.test.ts`

**Interfaces:**
- Consumes: `NO_DESIGN_TITLE` (Task 6).
- Produces:
  - `canBypassDesign(s: RunState): boolean`
  - `bypassDesign(s: RunState, now: number): Transition`
  - `RunState.designBypassedAt?: number`, also in `snapshotOf`

- [ ] **Step 1: Write the failing tests in a `describe("bypassDesign")`**

Fixture: the `PATROL` config (granite-chief and kt-22). Granite Chief reports hazards whose titles you choose.

- **`"waives the missing-design finding, and the review clears"`:**
  - Setup: Granite Chief `[No approved design]`, KT-22 clear, run swept, outcome `hazards`.
  - After `bypassDesign`:
    - outcome `clear`
    - `designBypassedAt` set to `now`
    - `checkReposts` +1
    - effects `[log "design bypassed by the owner", index, broadcast, check]`
    - `checkRunOf` concludes `success`, and its summary contains `Design bypassed by the owner`
- **`"leaves every other hazard standing"`:** Granite Chief `[No approved design, Something else]`. After the bypass, the outcome is `hazards` and the failure title says `1 hazard flagged`.
- **`"waives only Granite Chief's"`:** KT-22 reports a hazard titled `No approved design`. The bypass is refused (`canBypassDesign` false), and the outcome stays `hazards`.
- **`"a bypass made while the sweep is out applies when it closes"`:** Granite Chief reported the finding and KT-22 is still out. Bypass, then KT-22 clear → swept, outcome `clear`.
- **`canBypassDesign` is false for each of these, and `bypassDesign` leaves the state unchanged:**
  - no finding
  - already bypassed
  - stopped
  - landed
  - Granite Chief not yet reported
- **`"a fresh run starts unbypassed"`:** `createRun` has no `designBypassedAt`.
- **Purity:** add `bypassDesign` to the purity list.

- [ ] **Step 2: Run them to see them fail**

Run: `cd basetobase && npx vitest run dispatch/test/machine.test.ts -t bypassDesign` → FAIL

- [ ] **Step 3: Implement**

- **`openHazards(s, agent)`** (internal): drops the hazards titled `NO_DESIGN_TITLE` on the `granite-chief` agent once `designBypassedAt` is set.
- **Use open hazards wherever hazards are read:**
  - `reviewOutcome`, where an agent with status `hazards` and no open hazards counts as clear
  - `conditionsReport`
  - `failureTitle`
  - `checkSummary`
  - `closeSweepIfDone`'s count
- **`conditionsReport`** adds `Design bypassed by the owner (emergency).` when bypassed.
- **`canBypassDesign`:** the run is `on_the_hill` or `swept`, it isn't yet bypassed, and the granite-chief agent has a hazard with that title.

- [ ] **Step 4: Run the machine tests** → PASS (all of `machine.test.ts`)

- [ ] **Step 5: Commit**

---

### Task 8: The bypass in Dispatch, and the designs owed

**Files:**
- Create: `basetobase/dispatch/migrations/0003_design_bypass.sql` (`ALTER TABLE runs ADD COLUMN design_bypassed_at INTEGER;` and `ALTER TABLE runs ADD COLUMN covers TEXT;`)
- Modify: `basetobase/shared/src/design.ts` (add `coversOf`)
- Modify: `basetobase/shared/src/types.ts` (add `OwedDesign`)
- Modify: `basetobase/dispatch/src/runs/index.ts` (`upsertRun` writes both columns; add `listOwedDesigns`)
- Modify: `basetobase/dispatch/src/run/do.ts` (`bypassDesign()`)
- Modify: `basetobase/dispatch/src/routes/api.ts`
- Test: `basetobase/shared/test/design.test.ts`, `basetobase/dispatch/test/runs.test.ts`, `do.test.ts`, `routes-api.test.ts`

**Interfaces:**
- Consumes: Task 7's `canBypassDesign` and `bypassDesign`.
- Produces:
  - `coversOf(goal: string): number[]`: PR numbers from lines matching `^For: #(\d+)\s*$`, in order, without duplicates.
  - `OwedDesign = { repo: string; prNumber: number; prTitle: string; runId: string; bypassedAt: number }`.
  - `listOwedDesigns(db: D1Database): Promise<OwedDesign[]>`: the newest bypassed run per PR, newest first, excluding a PR that any landed run's `covers` names. Match with comma bounds: `',' || covers || ','` LIKE `'%,' || pr_number || ',%'`.
  - `RunDO.bypassDesign(): Promise<boolean | null>`: `null` when the run never started, `false` when there's nothing to bypass.
  - `POST /api/runs/:id/bypass-design` answers 202 `{"bypassed":true}`, 409 `{"error":"nothing to bypass"}`, or 404.
  - `GET /api/owed-designs` answers `OwedDesign[]`.

- [ ] **Step 1: Write the failing tests**

- **design.test.ts:**
  - `coversOf("x\nFor: #12\nFor: #12\nFor: #7 ")` → `[12, 7]`.
  - `coversOf("Before: #3")` → `[]`.
- **runs.test.ts:**
  - `"lists a bypassed PR until a landed design covers it"`: covered by a landed run's `For: #58`, not by an open or stopped run's.
  - `"For: #5 does not cover PR 58 or 5x"`.
  - `"one entry per PR, its newest bypass"`.
- **do.test.ts, `"bypassDesign"`:** dispatch tests run Mainline only (Task 6's seam), so seed the stored state through `runInDurableObject`, as `backdate` does. Give it a swept run whose agents include a granite-chief agent holding the `No approved design` hazard. Then assert:
  - `true`, and a check repost POST with `conclusion: "success"`
  - a second call → `false`
  - a never-started run → `null`
  - D1 `design_bypassed_at` is set
- **routes-api.test.ts:** 202, 409, 404, 401 without a session, 403 from another origin, and `GET /api/owed-designs` shape.

- [ ] **Step 2: Run them to see them fail** → FAIL

- [ ] **Step 3: Implement**

- `upsertRun` gains `design_bypassed_at` and `covers` (comma-joined `coversOf(snapshot.goal)`, or `NULL`).
- `bypassDesign` in the DO mirrors `retry`: check `load`, then `step(bypassDesign)`, and report whether it changed.
- Add the routes, beside retry.

- [ ] **Step 4: Run the gates**

Run: `cd basetobase && npm run typecheck && npm test` → PASS

- [ ] **Step 5: Commit**

---

### Task 9: The dashboard: bypass button, bypassed chip, designs owed

**Files:**
- Create: `basetobase/dashboard/src/components/ActionButton.tsx` (replaces `RetryButton.tsx`)
- Modify: `basetobase/dashboard/src/components/StepDetail.tsx`, `src/pages/RunView.tsx`, `src/pages/RunsList.tsx`, `src/theme.css`
- Create: `basetobase/dashboard/src/useOwedDesigns.ts`
- Test: `basetobase/dashboard/test/RunView.test.tsx`, `test/RunsList.test.tsx`

**Interfaces:**
- Consumes: `NO_DESIGN_TITLE`, `OwedDesign`, and the Task 8 routes.
- Produces:
  - `ActionButton(p: { path: string; label: string; busyLabel: string; failure: string })`: RetryButton's behaviour, generalized.
  - `useOwedDesigns(refreshKey: unknown): OwedDesign[]`: refetches `/api/owed-designs` whenever `refreshKey` changes, and sends a `SignedOutError` to sign-in.

- [ ] **Step 1: Write the failing tests**

- **RunView `describe("design bypass")`:**
  - **When it shows:** `"Bypass design (emergency)"` shows on the sweep step only when Granite Chief has a `No approved design` hazard, the run is open, and it isn't bypassed. It posts to `/api/runs/r1/bypass-design`.
  - **When it's hidden:** stopped, landed, already bypassed, or the finding raised by another role.
  - **After a bypass:** the header chip `Design bypassed (emergency)` shows when `designBypassedAt` is set.
- **RunView existing retry tests:** still pass through `ActionButton`, with labels unchanged.
- **RunsList:**
  - a `Designs owed` section lists `#58 <title>` linking to `/runs/<runId>`
  - no section when the list is empty

- [ ] **Step 2: Run them to see them fail** → FAIL

- [ ] **Step 3: Implement**

- `ActionButton` replaces `RetryButton`. The retry labels stay: `Retrying…` and `Could not retry:`. The bypass uses `Bypassing…` and `Could not bypass:`.
- `RunsList` calls `useOwedDesigns(runs)`. The section heading uses the dashboard's section styles; add only what it needs to `theme.css`.

- [ ] **Step 4: Run the gates**

Run: `cd basetobase && npm run typecheck && npm test` → PASS

- [ ] **Step 5: Commit**

---

### Task 10: End to end with two patrollers, and the bypass

**Files:**
- Modify: `basetobase/e2e/github.ts`: `pullRequest(n, title, body?)`, and `jobOf(runId, role): Promise<Job>`
- Modify: `basetobase/e2e/retry.spec.ts` and any spec that counts jobs or takes `jobsOf(...)[0]`, so they select by role
- Create: `basetobase/e2e/bypass.spec.ts`
- Modify: `basetobase/e2e/CLAUDE.md`

**Interfaces:**
- Consumes: everything above. The e2e stack runs the shipped config (Granite Chief and Mainline). It doesn't set `ENABLED_ROLES`.

- [ ] **Step 1: Run the e2e suite to see what two patrollers break**

Run: `cd basetobase && npm run e2e`
Expected: failures only where a spec assumes one job.

- [ ] **Step 2: Fix those specs to select jobs by role** → `npm run e2e` PASS

- [ ] **Step 3: Write `bypass.spec.ts` test `a:`**

1. Open PR `prNumber(testInfo, 31)`.
2. `patrol(jobOf(runId, "granite-chief"), ["No approved design"])` and `patrol(jobOf(runId, "mainline"))`.
3. Expect:
   - the PR in `Wind hold · needs you`
   - the newest check `failure`
4. On its run page, click `Bypass design (emergency)`. Within `LIVE_MS`, expect:
   - the chip
   - the PR in `Swept · patrol done`
   - the newest check `success`
   - `Designs owed` listing `#<pr>`
5. Open PR 32 with body `For: #<pr 31>`, patrol both jobs clear, then `close(pull, mergeSha)`.
6. Expect the `Designs owed` entry gone without a reload.

- [ ] **Step 4: Run it** → PASS on phone and desktop

- [ ] **Step 5: Commit**

---

### Task 11: Docs, and the whole branch green

**Files:**
- Modify: `docs/BEST_PRACTICES.md` §9 (point at `standard:system-design`)
- Modify: `basetobase/CLAUDE.md`: Granite Chief on the patrol; the bypass and `designs owed`; the `ENABLED_ROLES` test seam; migration 0003
- Modify: `.basetobase/CLAUDE.md`: `granite-chief.md`, and design lenses live in `plugins/standard`
- Modify: `basetobase/dashboard/CLAUDE.md`: `ActionButton` and `useOwedDesigns`
- Modify: `docs/superpowers/specs/2026-10-20-base-to-base-design.md`: §6 notes Granite Chief enabled with design rules; §9 the bypass and designs owed

- [ ] **Step 1: Write the docs, and point the settings at the default branch**

`.claude/settings.json` no longer declares the plugin (removed in Task 2, owner chose the account plugin). Add the owner's one-time setup to the root CLAUDE.md line: claude.ai → Customize → Plugins → Add → Add marketplace `aghchan/simplegoapp`, Sync automatically on.

- [ ] **Step 2: Run every gate**

Run: `go build ./... && go vet ./... && go test ./... -count=1`, then `cd basetobase && npm run typecheck && npm test && npm run e2e`, then `claude plugin validate . --strict && claude plugin validate plugins/standard --strict`
Expected: every command passes.

- [ ] **Step 3: Commit and push**
