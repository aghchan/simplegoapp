# System design before code — Design

**Status:** approved 2026-10-24 (owner).

**Part 1 of 3** of the development standard every project cloned from this
repo follows (owner). Part 2 is the iOS standard and starter. Part 3 is
making clones work: reusable CI, Base to Base watching every project, and
the regular upgrade.

## 1. Intent

Every change bigger than a simple bug fix gets a written system design
before its first line of code. The design follows one template. The
patrol's specialists challenge it the way they challenge PRs today, and
Claude answers them in a loop until they all agree. Anything the design
never decided goes to the owner, who signs off on the result. The code PR
is then held to that design. Only the owner can let a change skip it, in
an emergency (§8).

This repo is the base every future project is cloned from (owner). Every
project follows this standard exactly, with no rules of its own, and
upgrades by taking this repo's newest release (owner, §9).

Why: Base to Base checks a change only after it exists. By then, a wrong
call on scale, infrastructure or how the change fits the existing code is
a rewrite, not an edit. The same specialists asking the same questions
before the code exists catch those calls when they cost a paragraph.

The flow, start to finish:

1. **Say what we're building.** The what and why, agreed in conversation
   (today via `superpowers:brainstorming`).
2. **System design.** Claude fills in the template (§4).
3. **Challenge.** The specialists challenge it; Claude answers until
   quorum. Questions the design never settled, and deadlocks, go to the
   owner (§6).
4. **Sign-off.** The owner approves; the design lands on main (§7).
5. **Plan and build.** `superpowers:writing-plans`, then implementation.
6. **PR check.** Granite Chief holds the code PR to its design. In an
   emergency the owner can waive a missing design, and only the owner
   (§8).

**Success looks like:**

- No change bigger than a simple bug fix reaches code without an approved
  design on main.
- Every design answers the same questions in the same places: what, why,
  fit with existing features, scaling, infrastructure and dependencies.
- The owner hears only about decisions that are theirs to make, and
  deadlocks. Everything else is settled between Claude and the
  specialists.
- A code PR that drifts from its design fails, the same way a PR with an
  open hazard fails.
- A project cloned from this base has the whole flow without setting
  anything up, and gets each improvement by taking the newest release.

## 2. Goals, non-goals, anti-goals

**Goals**

1. A system design template with a full and a short size (§4).
2. One design-review prompt per specialist, in the patrol's style (§5).
3. A skill that runs the challenge loop in a Claude Code session (§6).
4. The rule that anything bigger than a simple bug fix needs an approved
   design first (§3), stated at the start of every session.
5. Granite Chief on the PR patrol, holding each PR to its design (§8).
6. An emergency bypass that only the owner can grant (§8).
7. All of it delivered as a Claude Code plugin published from this repo,
   so a project gets the flow by enabling it and upgrades by updating it
   (owner, §9).

**Non-goals**

- A design run inside Base to Base, with specialists on Actions runners
  and the challenges on the dashboard. That was approach B (§11). It waits
  for the huddle (milestone M3). The prompts here are written so it can
  reuse them unchanged.
- Base to Base watching other repos, reusable CI workflows, and the bot
  that keeps projects on the newest release. Those belong to part 3. Until
  then, the PR check (§8) runs on this repo.
- Swift rules for the specialists, and screen design for iOS. Those belong
  to part 2. This part writes the lenses so a language's rules sit in their
  own block (§5).
- Rules of a project's own. Every project follows the standard exactly
  (owner).
- Changing the superpowers plugin. It is external; this standard's rules
  take precedence over it (§3).

**Anti-goals — failures even if everything works**

- Claude approving its own design. Claude answers challenges; it never
  votes.
- Code starting while a challenge is still open.
- Claude guessing at a decision the design left open instead of asking the
  owner.
- A template filled with boilerplate. A section that doesn't apply says
  "None" and why, and the specialists can challenge the why.
- Wordy prompts. The patrol's house style applies (.basetobase/CLAUDE.md).

## 3. When a design is required (owner)

Anything more than a simple bug fix.

**A simple bug fix** makes the code do what it already promised, by a
test, a doc, a spec or an API contract. It changes no API contract, no
database schema, no config keys, no dependencies and no infrastructure
**(designer's call, wording of the owner's rule)**. When Claude cannot tell,
it asks the owner before deciding.

**Two sizes (owner approved):**

- **Full:** new features and anything else of substance. The whole panel
  challenges it.
- **Short:** chores, dependency bumps, docs-only and small changes, such
  as the Actions version bump in PR #8. It uses the same sections, with a
  line or two each. Its panel is Granite Chief plus the specialists whose
  sections are not "None" **(designer's call)**. Claude names the panel and
  why in the review record, and the owner can add anyone.

The rule reaches every session through the plugin (§9). A session-start
hook states it, together with the standard's other rules: the design comes
first, and this standard's loop wins over `superpowers:brainstorming`'s
builder check. A project's own CLAUDE.md never needs a copy of it.
`docs/BEST_PRACTICES.md` §9 (the new-feature checklist) points at the
flow.

In a session, Claude never skips the design on its own. If the owner says
a change is an emergency, Claude builds it without one and says the PR
will need the owner's bypass (§8).

## 4. The template

The template ships in the plugin (§9). A finished design is saved in the
project as `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, as today.

Header: title, size (full or short), status (draft, in review, approved
YYYY-MM-DD), and a link to the conversation or issue it came from.

Sections, in order. The owner named the first four groups; the rest are
the designer's call, each grounded in how the repo already works:

1. **What we're building:** the feature, and who it is for.
2. **Why:** the problem, why now, and what success looks like.
3. **Goals, non-goals, anti-goals.**
4. **Fit with existing features** (owner: interoperability): every
   service, controller, endpoint, `pkg/` integration, table and config key
   it touches or changes, and what each existing caller sees afterwards.
   Duplication with an existing feature is named here.
5. **API contract:** the diff to `api/v1/openapi.yml`, or "None". Public
   endpoints are spec-first here, so the contract is part of the design,
   not something worked out during implementation.
6. **Data model and migrations:** tables, columns and indexes, and whether
   each migration also works with the version still serving. Base to
   Base's deploy already requires that of D1 migrations.
7. **Scaling** (owner): load and data growth as numbers (requests per
   second, rows, payload sizes), the hot paths, concurrency and locking,
   and what breaks first as those numbers grow.
8. **Infrastructure and dependencies** (owner): new services, libraries
   with versions, config keys, secrets, and anything that costs money or
   uses up a free tier.
9. **Security:** who can call it, input validation at the edge, and where
   secrets and personal data go, logs and error messages included.
10. **Failure and rollback:** each dependency being down, partial
    failures, and how a bad release is undone, data included.
11. **How we'll know it works:** the end-to-end tests to commit, and the
    evidence a reviewer will see. The patrol already flags new behaviour
    without committed end-to-end tests.
12. **Approaches:** two or three, what each trades off, which was picked
    and why.
13. **Delivery:** how the work splits into PRs or milestones, each named so
    a PR can point at it (§8).
14. **Decisions:** the owner's, marked **(owner)**, and Claude's, marked
    **(designer's call)**.
15. **Left to the builder.**
16. **Design review** (appendix, written by the loop): the panel, each
    round's challenges and how each was settled, and the quorum line.

Short size: the same headings, one or two lines each. "None" needs a
reason.

## 5. The specialists' design lenses

One prompt per specialist, plus a shared `_challenge.md` (stance and output
contract), all shipped in the plugin (§9) and laid out like
`.basetobase/patrol/` **(designer's call)**. The roles, prefixes and names
come from the roster (basetobase/config/basetobase.json). Each file
follows the patrol's house style: one imperative rule per line, at most
about 40 lines.

Rules that depend on a language sit in their own block in each lens, such
as Go's dependency directions in Corduroy's **(designer's call)**. A
specialist applies the blocks for the languages the design touches. Part 2
adds the Swift blocks.

| Specialist | Prefix | Challenges in the design |
|---|---|---|
| Granite Chief (goal fit) | GOAL | The what and why can be judged against a finished PR; nothing in scope that the why doesn't justify. |
| Corduroy (code quality) | QLT | Fit with existing features: duplication, dependency directions (`domain/` never imports `api/`, `pkg/http` or `apierror`; `pkg/` never imports `domain/` or `app/`), `main.go` as the only composition root. |
| Summit Six (scalability) | SCL | The scaling numbers are stated, and the design holds at them: unbounded queries, N+1 access, hot paths, locking. |
| Gold Coast (infra & cost) | INF | Every service, library, config key and secret is listed, with its cost and free-tier impact. |
| KT-22 (security) | SEC | Who can call it, validation at the edge, secrets, personal data, what errors and logs reveal. |
| Mainline (functionality) | FUN | "How we'll know it works" is a concrete list of end-to-end tests that would catch the failures the design describes. |
| Magic Carpet (UX) | UX | Only when the design adds or changes a screen: flows, loading/empty/error states, keyboard, phone width. |
| Bluebird (design) | DSN | Only for screens: consistency with the established look, hierarchy, WCAG AA contrast. |
| Builder | BLD | Always on the panel: could a builder plan from this without guessing? Places where a wrong guess would matter. |

The builder lens is `superpowers:brainstorming`'s builder check, moved into
the loop so it re-checks every revision like the others
**(designer's call)**. It is a design-only lens, not a roster role: it never
reviews PRs. It ships in the plugin with the other lenses.

`_challenge.md` carries the patrol's adversarial stance (from
`patrol/_verdict.md`), adapted to a document:

- The design is wrong until the challenge fails.
- The role is the specialist's only lens.
- Every challenge cites the section and quotes the line, or names the
  missing section.
- "Clear" only after the attacks failed; the summary lists them.
- A defence closes a challenge only with evidence from the design or the
  repo, not by restating the choice.

Its output contract is one JSON object, shaped like the patrol verdict so a
later Base to Base design run can parse both the same way **(designer's
call)**:

- `role`, `revision` (the revision it read), `status` (`clear` or
  `challenges`) and `summary` (one paragraph).
- `challenges`, each with:
  - `id`: prefix-number, e.g. `SCL-2`
  - `section`
  - `kind`
  - `title`
  - `detail`
  - `reply`: on re-checks, to Claude's answer
- `kind` is one of:
  - **`unspecified`:** the design is silent or ambiguous on something the
    role needs settled.
  - **`flaw`:** the design states something that fails the role's lens.
  - **`defend`:** a decision in the role's area that the design doesn't
    justify.

## 6. The challenge loop (owner)

The plugin's `system-design` skill **(designer's call)** runs it in the
session:

1. **Draft.** Claude fills in the template from the agreed what and why,
   reading the code each section touches.
2. **Sweep.** Claude starts one subagent per specialist on the panel, all
   at once. Each reads its lens, `_challenge.md` and the design, sees no
   other specialist's challenges, and returns its JSON.
3. **Answer.** For each open challenge:
   - **`unspecified`** goes to the owner (owner rule). Claude doesn't
     guess. It may propose an answer with its reason, for the owner to
     correct.
   - **`flaw` or `defend`:** Claude either revises the design or defends
     it in a written reply with evidence from the design or the repo.
   - **Deadlock:** a challenge still open after Claude has answered it
     twice goes to the owner **(designer's call: two rounds)**.
4. **Owner questions.** One message, most important first, each giving the
   challenge, the specialist, why the design doesn't settle it, and
   Claude's proposed answer. The owner's answers go into §14 as
   **(owner)**. An owner ruling closes its challenge: the specialists
   re-check everything else, but not that point.
5. **Re-check.** Every specialist on the panel reads the revised design,
   all at once. Unlike the sweep, each now sees all the challenges and
   Claude's replies. Each closes its own challenges, keeps them open with
   a reply, or raises new ones. Every specialist re-checks, not only those
   with open challenges, because a revision for one lens can break
   another.
6. **Quorum:** every specialist on the panel returns `clear` for the same
   revision. Otherwise, back to step 3.

The loop never gives up on its own (owner). Whatever it can't settle goes
to the owner, and it carries on until quorum. The owner is the tiebreaker,
not a timeout.

Claude writes the review record (§4.16) as it goes: the panel, each
round's challenges, how each was settled (revised in §n, defended with a
reason, owner decision, withdrawn), and finally "Quorum: GOAL, QLT, SCL,
INF, SEC, FUN, BLD clear on revision N".

The builder lens (§5) takes the place of `superpowers:brainstorming`'s
separate builder check for designs that go through this loop
**(designer's call)**. The plugin's session-start rules say so (§3).

## 7. Sign-off

At quorum, Claude hands the owner the design with the list of designer's
calls to check. On the owner's approval, Claude sets the status to
approved, commits the design on its own, and opens a PR containing only
the design. Code starts once that PR is merged **(designer's call)**.

So the approved design is on the default branch before any code PR opens,
and a code PR cannot rewrite the design it is held to (§8).

**Changing an approved design** **(designer's call)**. A design is a living
document, but it changes only through the loop:
- The revision is drafted on a branch, and the panel challenges it. The
  review record gains a new round.
- The owner approves it, and it lands in its own design PR before any code
  that depends on it.
- main always holds the last approved version. Code PRs that point at the
  design are held to that version until the revision merges.
- A code PR never edits any design file. As-built notes, which the Base to
  Base spec carries today, go in through a design PR as well.

## 8. The PR check (owner)

The code PR's description names its design: `Design: <path>`, or
`Design: <path> §<n>` for one part from the design's delivery section
(§4.13). Several lines are allowed when a PR delivers parts of several
designs **(designer's call)**. Base to Base already reads the PR title and
body as the run's goal, so Granite Chief sees them.

A simple bug fix has no design. Its PR names the promise it restores
instead, `Fixes: <path>`: the test, doc, spec or contract that says what the
code should do **(designer's call)**. Granite Chief can't ask anyone, so it
checks that claim rather than guessing.

Granite Chief joins the PR patrol (`enabledRoles`), with its first patrol
template, `.basetobase/patrol/granite-chief.md`. Its scope stays goal fit,
and the template adds:

- **No design:** no `Design:` line, and either no `Fixes:` line or a
  change beyond the fix it names → hazard. The second case covers a
  contract, schema, config key, dependency or service changed by a
  "simple bug fix".
- **Design not approved:** the linked design isn't marked approved on the
  default branch → hazard.
- **Design edited:** a code PR modifies any design file → hazard. Changes
  to a design go back through the loop (§7).
- **Drift:** the PR does something outside the parts it names, or leaves
  out something those parts include → hazard. That includes a contract,
  table, config key, dependency or service that the design didn't list.
- **Source:** the design is read as it is on the default branch, never
  from the PR head.

**Design PRs** **(designer's call)**. A PR whose every file is a design under
`docs/superpowers/specs/` gets Granite Chief's design rules instead:
- the status is approved
- the review record ends in a quorum line on the final revision
- no challenge is left open
- the panel follows the size rule (§3)

This is the automated check that a design didn't skip the loop. Adding the
specs folder to `unpatrolledGlobs` was rejected: one matching file makes a
whole PR unpatrolled, so a code PR that also touched a spec would skip the
patrol.

A PR that touches Base to Base's own files is unpatrolled until M5
(`unpatrolledGlobs`), so for those changes only the session rule (§3)
applies.

**Emergency bypass (owner).** Only the owner can let a PR skip its design:
- **Where:** the run's page on the Base to Base dashboard. Its sign-in is
  the owner's own GitHub login, which Claude cannot use. A comment or a
  line in the PR wouldn't do: Claude opens PRs and comments under the
  owner's GitHub account, so the patrol couldn't tell the owner from
  Claude.
- **The control:** a run with Granite Chief's missing-design finding shows
  "Bypass design (emergency)". It is the dashboard's
  existing owner-only, same-origin API. It asks for no reason (owner).
- **What it waives:** that one finding on that one PR. Every other hazard
  and failure still counts, and Granite Chief's other rules still apply.
- **Record:** the run records the bypass and its time, and the check run
  says so.
- **Owed design (designer's call, owner approved):** a bypassed change owes
  a short design written after the fact, naming the PR, so its decisions
  still get challenged. The dashboard lists bypasses whose design is still
  owed, and an entry clears when that design lands.

## 9. Delivery and upgrades (owner)

The flow ships as a Claude Code plugin published from this repo
**(designer's call, within the owner's choice of remote references)**:
- **Contents:** the template, the lenses with `_challenge.md`, the
  `system-design` skill, and the session-start hook carrying the rules
  (§3).
- **This repo** hosts the marketplace that lists the plugin.
- **The owner's claude.ai account** carries the plugin (owner, after the
  spike below). Add it once under claude.ai → Customize → Plugins → Add →
  Add marketplace, entering `aghchan/simplegoapp`, with **Sync automatically**
  on.
- **Every session** signed in to that account then gets the plugin as a
  synced plugin: terminal, desktop and cloud sessions, in any repository.
  This cloud session already loads the owner's account-synced superpowers
  plugin the same way.
- **Projects** declare nothing and hold no copies. A project
  `.claude/settings.json` entry would load a second copy beside the synced
  one, so there is none.

**Upgrades (owner).** Projects keep up by taking this repo's newest release.
Releases are version tags with a short upgrade note **(designer's call)**.
The account's Sync automatically pulls each new plugin `version` from this
repo's default branch. A release bumps `plugin.json`'s version. Part 3's
weekly bot moves each project's other references (CI workflows, the Go
module) to the newest release.

**Spike first (designer's call):** confirm that a plugin enabled in a
repo's settings installs itself in a Claude Code cloud session, without
anyone confirming it. If it doesn't, settle the fallback before building
the rest. The fallback might be a setup hook in the project or an
account-level install.

**Spike result (2026-10-24): failed.** A fresh cloud session on the branch,
with the plugin declared in `.claude/settings.json`, answered no on all
three checks: no `standard:system-design` skill, no rules in its context,
and `claude plugin list` printed "No plugins installed". Project-declared
marketplaces register only after the folder-trust dialog, and a headless
cloud session never shows it. The fallback goes to the owner before any
further work.

**Fallback decided (owner, 2026-10-27): the account plugin.** A
project-declared plugin never loads in a cloud session. Claude Code's
docs confirm it: cloud sessions load account-synced and
organization-managed plugins only. The check that the account plugin
reaches a fresh session happens after merge, once the owner has added the
marketplace. If it fails, the next fallback is the cloud environment's
setup script installing the plugin at user scope.

**Patrol prompts stay in this repo.** The design lenses ship in the plugin,
and the PR patrol's prompts (`.basetobase/patrol/`, Granite Chief's
included) stay where Base to Base reads them. Reading them for other
repos is part 3.

## 10. What this adds and costs

**New files:**
- the plugin, with its marketplace entry: the template, eight specialist
  lenses, the builder lens and `_challenge.md`, the skill, and the
  session-start hook
- Granite Chief's patrol template

**Edits:**
- the root `CLAUDE.md`: where the standard lives, and the owner's one-time
  account-plugin setup (§9)
- `docs/BEST_PRACTICES.md` §9
- `enabledRoles`
- Dispatch and the dashboard: the bypass (an API route, a machine
  transition that waives one finding, the run's record, the owed-designs
  list)

**Cost:**
- No new services or hosting. The plugin is served from this GitHub repo.
- Claude usage: one subagent per lens per round in the session, about seven
  per round for a backend feature.
- Granite Chief adds one Actions runner and one Claude session to every
  patrolled PR, on top of Mainline. That is the only ongoing cost.

## 11. Approaches

**The loop (owner picked A):**

- **A. The loop runs in the Claude Code session (picked).**
  - How: a repo skill starts the specialists as subagents, Claude answers
    them, and questions come to the owner in the chat.
  - For: buildable now with nothing new to host; seconds per round; the
    owner's answers go straight back into the loop.
  - Against: the review history lives in the design doc and its commit,
    not on the dashboard, and it relies on the session following the skill.
    The PR check (§8) is the backstop.
- **B. A Base to Base design run on a design PR.**
  - How: specialists on Actions runners, a designer agent answering them,
    and questions in Needs you and as PR comments.
  - For: fully observable.
  - Against: it needs the huddle loop (M3) and a way for the owner's
    answers to reach agents, and neither exists. Each round spins up
    runners and spends the owner's Claude usage.
  - Path: it can come later on the same lens prompts and contract.
- **Considered and dropped:** a design as a GitHub issue rather than a
  file. It isn't versioned with the code, and the PR check couldn't read it
  from the default branch.

**Delivery to projects (owner picked remote references):**
- **Remote references (picked).** CI calls this repo's workflows, the flow
  is a plugin, and Base to Base reads prompts from this repo. Nothing is
  copied. The owner accepted keeping several references current, which the
  regular upgrade handles.
- **Synced copies.** A tool in this repo writes the standard's files into
  each project at the version in its `go.mod`, and CI blocks local edits.
  It had one version pin, but left copies in every project.
- **Git submodule.** Ruled out: GitHub won't run workflows from a
  submodule, and Claude Code won't load skills from one.

## 12. Left to the builder

- How a specialist subagent is prompted beyond its lens and
  `_challenge.md`, and which model it runs on (the session's by default).
- How a revision is identified for quorum, e.g. a number in the review
  record or the file's content hash.
- How Granite Chief reads the default branch's design in the agent job,
  e.g. `git show origin/<default>:<path>` in the PR checkout, which is
  fetched with full history.
- The exact wording of every prompt, within the house style.
- How Dispatch recognises the missing-design finding it may waive, e.g. a
  fixed hazard id or title from Granite Chief's template.
- How an after-the-fact design names the PR it covers, and how the owed
  list learns it has landed.
- The plugin's name and layout.
