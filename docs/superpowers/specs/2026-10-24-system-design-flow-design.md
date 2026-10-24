# System design before code — Design

**Status:** draft, for the owner's review.

## 1. Intent

Every change bigger than a simple bug fix gets a written system design
before its first line of code. The design follows one template. The
patrol's specialists challenge it the way they challenge PRs today, and
Claude answers them in a loop until they all agree. Anything the design
never decided goes to the owner, who signs off on the result. The code PR
is then held to that design.

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
6. **PR check.** Granite Chief holds the code PR to its design (§8).

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

## 2. Goals, non-goals, anti-goals

**Goals**

1. A system design template with a full and a short size (§4).
2. One design-review prompt per specialist, in the patrol's style (§5).
3. A project skill that runs the challenge loop in a Claude Code session
   (§6).
4. A rule, in the root CLAUDE.md, that anything bigger than a simple bug
   fix needs an approved design first (§3).
5. Granite Chief on the PR patrol, holding each PR to its design (§8).

**Non-goals**

- A design run inside Base to Base, with specialists on Actions runners
  and the challenges on the dashboard. That was approach B (§10). It waits
  for the huddle (milestone M3). The prompts here are written so it can
  reuse them unchanged.
- Apps built from the simplegoapp template, such as recruiter. This covers
  simplegoapp itself, Base to Base included.
- Changing the superpowers plugin. It is external; the repo's own skill
  and CLAUDE.md take precedence over it.

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

The rule goes in the root CLAUDE.md, which every session reads. It also
points `docs/BEST_PRACTICES.md` §9 (the new-feature checklist) at the
flow.

## 4. The template

`docs/superpowers/templates/system-design.md` **(designer's call)**. A
finished design is saved as
`docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, as today.

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
13. **Decisions:** the owner's, marked **(owner)**, and Claude's, marked
    **(designer's call)**.
14. **Left to the builder.**
15. **Design review** (appendix, written by the loop): the panel, each
    round's challenges and how each was settled, and the quorum line.

Short size: the same headings, one or two lines each. "None" needs a
reason.

## 5. The specialists' design lenses

One prompt per specialist in `.basetobase/design/<role-id>.md`, plus a
shared `.basetobase/design/_challenge.md` (stance and output contract),
mirroring `.basetobase/patrol/` **(designer's call)**. The roles, prefixes
and names come from the roster (basetobase/config/basetobase.json). Each
file follows the patrol's house style: one imperative rule per line, at
most about 40 lines.

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

A project skill, `.claude/skills/system-design/SKILL.md`
**(designer's call)**, runs it in the session:

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
   Claude's proposed answer. The owner's answers go into §13 as
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

Claude writes the review record (§4.15) as it goes: the panel, each
round's challenges, how each was settled (revised in §n, defended with a
reason, owner decision, withdrawn), and finally "Quorum: GOAL, QLT, SCL,
INF, SEC, FUN clear on revision N".

The skill replaces `superpowers:brainstorming`'s builder check for designs
that go through it: the specialists ask the builder's questions and more
**(designer's call)**. The root CLAUDE.md says so, which makes it win over
the plugin.

## 7. Sign-off

At quorum, Claude hands the owner the design with the list of designer's
calls to check. On the owner's approval, Claude sets the status to
approved, commits the design on its own, and opens a PR containing only
the design. Code starts once that PR is merged **(designer's call)**.

So the approved design is on the default branch before any code PR opens,
and a code PR cannot rewrite the design it is held to (§8).

## 8. The PR check (owner)

The code PR's description carries one line: `Design: <path>`. Base to Base
already reads the PR title and body as the run's goal, so Granite Chief
sees it.

Granite Chief joins the PR patrol (`enabledRoles`), with its first patrol
template, `.basetobase/patrol/granite-chief.md`. Its scope stays goal fit,
and the template adds:

- **No design:** no `Design:` line, and the change is more than a simple
  bug fix (§3) → hazard.
- **Design not approved:** the linked design isn't marked approved on the
  default branch → hazard.
- **Design rewritten:** the PR modifies its own design → hazard. Changes
  to a design go back through the loop.
- **Drift:** the PR does something the design doesn't say, or leaves out
  something it does → hazard. That includes a contract, table, config key,
  dependency or service that the design didn't list.
- **Source:** the design is read as it is on the default branch, never
  from the PR head.

A PR that touches Base to Base's own files is unpatrolled until M5
(`unpatrolledGlobs`), so for those changes only the session rule (§3)
applies.

## 9. What this adds and costs

**New files:**
- the template
- nine lens prompts and `_challenge.md`
- the skill
- Granite Chief's patrol template

**Edits:**
- the root CLAUDE.md
- `docs/BEST_PRACTICES.md` §9
- `.basetobase/CLAUDE.md`, which gains the design folder
- `enabledRoles`

**Cost:**
- No new services or hosting.
- Claude usage: one subagent per specialist per round in the session, about
  six per round for a backend feature.
- Granite Chief adds one Actions runner and one Claude session to every
  patrolled PR, on top of Mainline. That is the only ongoing cost.

## 10. Approaches (owner picked A)

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

## 11. Left to the builder

- How a specialist subagent is prompted beyond its lens and
  `_challenge.md`, and which model it runs on (the session's by default).
- How a revision is identified for quorum, e.g. a number in the review
  record or the file's content hash.
- How Granite Chief reads the default branch's design in the agent job,
  e.g. `git show origin/<default>:<path>` in the PR checkout, which is
  fetched with full history.
- The exact wording of every prompt, within the house style.
