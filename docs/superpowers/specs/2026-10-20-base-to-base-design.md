# Base to Base — agent CI/CD with a live dashboard — Design

Status: draft · 2026-10-20

Dashboard mockup (clickable): https://claude.ai/artifact/V9dkyJTXo7Wz6wvtHr7PP2

Decisions the owner made are stated plainly. Decisions the designer made are
marked **(designer's call)** — they are defaults the owner has not explicitly
approved and may change. §18 lists what is left to the builder.

---

## 1. Intent

Automate the development workflow with agents, starting from the end of the
pipeline: a gate that decides whether a change is actually right — and
actually working — before it ships.

The owner opens a PR. A panel of specialist agents (the **patrol**) reviews it
independently, then **huddles** over every concern raised, with an implementer
agent fixing or disputing each one, until every patroller agrees the change
works and meets its own criteria. The change is then re-verified on a fresh
environment, merged, and deployed — with no approval click.

An always-on coordinator (**Dispatch**) drives this, and a **dashboard** makes
every step and every agent observable and debuggable: what step a PR is on,
how long it has been there versus usual, what each agent is doing, its logs,
and the controls to intervene.

**Success looks like:**

- Opening a PR on a watched repo is the only human action needed for a good
  change to reach production.
- Opening the dashboard mid-run shows the current step with notes, logs, and
  time-on-step versus usual, and offers ways to debug it.
- "It works" is shown by evidence — real end-to-end requests for backend
  changes, real browser screenshots for frontend changes — never by an agent's
  say-so.
- Hosting costs nothing. The only spend is the owner's existing Claude
  subscription.

## 2. Goals, non-goals, anti-goals

**Goals (v1)**

1. Dispatch: always reachable, never sleeps, drives every run to a terminal
   state, never leaves a run stuck without visible state.
2. The patrol + huddle loop (§6, §7) on every PR from the owner on a watched
   repo.
3. Summit check, merge, and deploy (§8), fully automatic.
4. The dashboard (§9) with live logs, evidence, and debug controls.
5. First watched repo: `aghchan/simplegoapp` (public), which is also where
   Base to Base itself lives (monorepo, §3).
6. **Parallel wherever work is independent** (owner). Every patroller on a
   panel runs at the same time, each on its own runner; re-checks in the
   huddle run at the same time; separate PRs run at the same time. Work is
   serialized only where it must be (§7, §11).

**Non-goals (v1)**

- Multiple users or teams. The owner is the only user.
- Private repos as watched repos (GitHub Actions minutes are capped there).
  Designed so adding one later is configuration, not a rewrite.
- Agents that start work from issues/tickets. v1 starts at "PR opened".
- Notifications beyond GitHub's own (PR comments @mention the owner).
- Auto-rollback of a bad deploy.

**Anti-goals — failures even if everything "technically works"**

- An agent approving its own work. The implementer never votes.
- Merging or deploying anything not verified end-to-end on the exact commit
  that ships.
- A run that silently hangs, or a dashboard that shows a state that isn't true.
- Any paid resource appearing without the owner opting in.
- Draining the owner's Claude subscription so they can't use Claude
  themselves (see Lift closed and the global cap, §11).
- Theme over meaning: every themed label must also show its plain meaning.
- Agents running on code from a fork with the owner's credentials.

## 3. Constraints

- **Free hosting, no credit card** (owner). Researched 2026-10-20; summary in
  §15.
- **Claude usage paid by the owner's Claude subscription** (owner), via a
  Claude Code OAuth token from `claude setup-token`. No Anthropic API key.
  Consequence: every LLM call happens inside a Claude Code process on a
  GitHub Actions runner. Dispatch itself never calls Claude.
- **Dashboard and Dispatch are TypeScript** (owner approved TS for the
  dashboard; Dispatch is TS in the same Cloudflare app **(designer's call)**).
- **Go code quality = Google Go Style Guide, with the house style as approved
  exceptions** (owner): receivers named `this` (staticcheck ST1006 is already
  disabled in `staticcheck.conf`) and anything else `docs/BEST_PRACTICES.md`
  and the repo's CLAUDE.md files prescribe. Where they conflict with Google
  style, the house rule wins.
- **Monorepo** (owner): Base to Base lives in `aghchan/simplegoapp` under
  `basetobase/` (layout and isolation rules in §13). The Go module stays at
  the repo root unchanged — consumers such as the `recruiter` repo import
  `github.com/aghchan/simplegoapp/pkg/...`, so moving it would break them.
- **Snowboard/ski naming and visual theme** (owner), inspired by Ikon Pass
  mountains — Palisades Tahoe and Alpine Meadows are examples, not
  requirements. Lift, lodge, and run names are all fair game.

## 4. Architecture

```
            pull_request webhook
  GitHub ───────────────────────────►  Dispatch  (Cloudflare Worker, TS)
    ▲  ▲                                 │  one Durable Object per run:
    │  │ merge, check run, comments      │  state machine · SQLite event log ·
    │  └─────────────────────────────────┤  alarms (wind hold, watchdog) ·
    │                                    │  WebSocket fan-out
    │  workflow_dispatch(role, run, sha) │
    │◄───────────────────────────────────┤        D1: runs index
    │                                    │        R2: transcripts, evidence
    ▼                                    │
  GitHub Actions job (fresh runner)      │  WebSocket
  Claude Code headless + forwarder ──────┤──────────────►  Dashboard (static
  Docker: Postgres · app · Chromium      │  events,           assets on the
  ("Alpine" = this ephemeral env)        │  verdicts,         same Worker)
                                         │  evidence (OIDC-authenticated)
                                         │
                                         └──► Render deploy hook ──► Palisades
                                              (Go app on Render free + Neon)
```

| Part | Runs on | Why (§15 has the comparison) |
|---|---|---|
| Dispatch + dashboard | Cloudflare Workers + Durable Objects + static assets | Never sleeps; real WebSockets; per-run state with built-in alarms; free, no card. |
| Run index | Cloudflare D1 | Durable Objects can't be listed; D1 backs the runs list and "usual" durations. |
| Transcripts, evidence | Cloudflare R2 | Free 10 GB; dashboard shows screenshots inline. |
| Agents | GitHub Actions (one job per agent invocation) | Unlimited minutes for public repos; 6 h job cap; Docker and Chromium available. |
| Alpine (test env) | The Actions runner itself (docker compose) | Fresh every time, free. |
| Palisades (production) | Render free web service + Neon free Postgres | Only free no-card host for a Go server; sleeping is acceptable for the app. Neon doesn't expire (Render's free Postgres is deleted after 30 + 14 days). |

## 5. The pipeline

| # | Themed name | Plain name | What happens | Leaves when |
|---|---|---|---|---|
| 1 | Lift line | PR opened | Owner's same-repo PR opened, reopened, or marked ready. Forks and drafts ignored. | Run created |
| 2 | Trail map | Triage | Pick panels by path. Rate. Name the run. Goal = PR title + body. | Panels dispatched |
| 3 | Patrol sweep | Independent review | All patrollers at once, one runner each. Each sees diff, repo, goal, own criteria — not each other's findings. | All verdicts in → **Swept** |
| 4 | Patrol huddle | Quorum | Loop in §7. | All clear on one SHA → **All clear**. 30 min → wind hold |
| 5 | Summit check | Final verify | Full end-to-end suite, fresh env (Alpine), merge ref. §8. | Pass → **Summit**. Fail → huddle |
| 6 | Drop in | Merge | Squash, pinned to the verified SHA. §8. | Merged |
| 7 | Send it | Deploy | Deploy what the changed paths need; health check. §8. | Healthy → **Open**. Fail → Needs you |

**Panel classification in the monorepo** **(designer's call; globs in
config)**:

- `basetobase/dashboard/**` → frontend panel
- everything else, including Dispatch (`basetobase/dispatch/**`, a
  TypeScript backend) and all Go code → backend panel
- a PR touching both → both panels, run together

Run terminal states: **Open** (deployed), **Stopped** (owner stopped it or
closed the PR), **Failed** (deploy failed — sits in Needs you). **Wind hold**
is not terminal: it waits for the owner (§7).

## 6. The patrol

### Roster

| Name | Role | Panels |
|---|---|---|
| Granite Chief | Goal fit | backend, frontend |
| Gold Coast | Infra & cost | backend |
| Summit Six | Scalability | backend |
| KT-22 | Security | backend, frontend |
| Mainline | Functionality | backend, frontend |
| Corduroy | Code quality | backend, frontend |
| Magic Carpet | UX | frontend |
| Bluebird | Design | frontend |
| Groomer | Implementer — fixes or disputes hazards, **never votes** | — |

A change touching both kinds of paths gets the union of both panels. Names
are configurable; these are the designer's picks. Granite Chief and Corduroy
on the frontend panel are **(designer's call)** — the owner named the
frontend weights (functionality, UX, security, design) and said general
engineering practice applies everywhere.

### Weights

- **Frontend:** functionality > UX > security > design (owner), then goal fit
  and code quality **(designer's call)**.
- **Backend:** functionality first (owner: "most importantly, is it
  working"); goal fit, infra & cost, scalability, security, code quality
  otherwise equal **(designer's call)**.

Weights do three things: they order Groomer's work (highest-weight hazards
first); they settle conflicts between patrollers (when satisfying one hazard
would violate another's, the higher weight wins and the lower-weight
patroller must withdraw or restate its hazard); and functionality alone is
re-verified at the summit check. Conflicts between equal weights that
Groomer can't satisfy simply run out the clock and go to the owner.

### What each patroller checks

Each patroller's criteria live as a versioned prompt file in the watched repo
(`.basetobase/patrol/<name>.md`), so they're reviewed like code
**(designer's call)**.

**Agent-facing templates are terse** (owner). This covers patroller
prompts, the Groomer prompt, and the steps in the agent workflow.

- One imperative rule per line.
- No preamble, no rationale, no politeness, no restating what CLAUDE.md or
  `docs/BEST_PRACTICES.md` already say. Point at them instead.
- Each patroller file stays under about 40 lines **(designer's call)**.
- Wording that adds no rule gets cut. Corduroy enforces this on changes to
  the templates.

The lists below are the *scope* each template covers, not its wording.

- **Granite Chief (goal fit):** the change does what the goal says, all of it,
  and nothing unasked for. If the PR description gives no judgeable goal, that
  itself is a hazard.
- **Gold Coast (infra & cost):** new services, resources, config, or paid
  usage; impact against the free-tier limits of the deployed stack (declared
  in config, §15); cost per request.
- **Summit Six (scalability):** concurrency and locking, unbounded queries
  and pagination, N+1 access, hot paths, assumptions about load.
- **KT-22 (security):** authn/authz, input validation at the edge, secrets in
  code or config, injection, unsafe dependencies, data exposure in errors and
  logs. (It should, for example, flag the real-looking Ticketmaster API key
  committed in `config.yml` today.)
- **Mainline (functionality):** proves it works by running it.
  - Backend: starts the app against a real Postgres on the runner, calls the
    changed endpoints end to end, and records every request/response as
    evidence.
  - Frontend: drives the real UI in a real browser (Playwright + Chromium) and
    records screenshots as evidence.
  - If the change lacks committed end-to-end tests for what it adds, that is a
    hazard; Groomer writes them, so CI keeps exercising them afterwards.
- **Corduroy (code quality):** SOLID, DRY, hexagonal architecture, and the
  language's best practices. For Go: Google Go Style Guide with the house
  exceptions (§3), plus the dependency directions simplegoapp already
  prescribes — `domain/` never imports `api/`, `pkg/http`, or `apierror`;
  `pkg/` never imports `domain/` or `app/`; `main.go` is the only composition
  root. For TypeScript: strict mode and the repo's lint config.
- **Magic Carpet (UX):** flows are obvious, states (loading, empty, error)
  exist, keyboard and screen reader basics, works at phone width.
- **Bluebird (design):** visual consistency with the established look,
  hierarchy, contrast (WCAG AA), spacing.

### Verdicts

Every patroller run ends with a structured verdict **(designer's call — exact
schema is the builder's)**:

- the head SHA it reviewed
- `clear` or `hazards`
- new hazards: id (role prefix + number, e.g. `SEC-1`), title, detail,
  evidence references
- for hazards it raised earlier: confirmed fixed, withdrawn (with reason), or
  still open (with a reply to Groomer)
- a one-paragraph plain-English summary, which feeds the dashboard's
  Conditions report

## 7. The huddle (quorum loop)

Each round:

1. Dispatch hands every open hazard to Groomer in one job. For each, Groomer
   either fixes it (commits and pushes to the PR branch) or disputes it with
   written reasoning. Groomer is a single job because it is the only writer
   to the branch — two writers would conflict. Inside that job it works on
   independent hazards in parallel, using Claude Code's own subagents, then
   pushes once for the round **(designer's call)**.
2. Every patroller on the panel re-checks the new head, **all at once**,
   each on its own runner: confirms or keeps
   open its own hazards (it may withdraw one if Groomer's dispute convinces
   it), and reviews the change since its last verdict for new hazards in its
   area. In the huddle — unlike the sweep — patrollers see all hazards and
   Groomer's replies.
3. **All clear** = every patroller on the panel returns `clear` for the same
   head SHA. Otherwise, next round.

If the sweep itself comes back with every patroller clear, the huddle is
skipped and the run goes straight to *All clear*.

**Wind hold (owner): the huddle gives up after 30 minutes.** The clock is
huddle wall time, excluding time spent in *Lift closed* (§11)
**(designer's call)**. On wind hold, Dispatch cancels in-flight jobs, moves
the run to *Needs you*, and comments on the PR listing open hazards and
@mentioning the owner. From the dashboard the owner can **(designer's call)**:

- **Resume** — another 30 minutes.
- **Accept open hazards** — an owner override, recorded on the run; proceeds
  to the summit check.
- **Stop** — ends the run; the PR stays open for the owner.

Other events during a run **(designer's call)**:

- The owner pushes to the PR → a new huddle round on the new head with the
  30-minute clock reset.
- The PR is closed → run Stopped, in-flight jobs cancelled.
- Base branch moves → nothing during the huddle; the summit check uses the
  merge ref (§8). If the PR no longer merges cleanly (GitHub produces no
  merge ref), resolving the conflict becomes a Groomer task in the next
  huddle round — Groomer merges the base branch into the PR branch; it never
  rebases or force-pushes.

## 8. Summit check, Drop in, Send it

**Summit check (final verify on Alpine).** The owner's requirement: once the
quorum agrees, re-verify functionality before deploying. On a fresh runner
with a fresh Postgres, build the app from the PR's merge ref
(`refs/pull/N/merge`) at the all-clear head and run the **full** committed
end-to-end suite — which, by Mainline's rule in §6, covers what the change
adds. The summit check is deterministic (a test run, not a Claude session),
so it costs no subscription quota. Nothing is reused from the huddle.
Failure goes back to the huddle as a Mainline hazard, with whatever clock
remains; an expired clock means wind hold.

**Drop in (merge).** Via the GitHub API with `sha` pinned to the verified
head, so a push after verification makes the merge fail instead of shipping
unverified code. If the base branch moved since the summit check, re-run the
summit check on the new merge ref first. Merge method: squash
**(designer's call)**. No approval is needed (owner).

**Send it (deploy).** Per watched repo, a deploy adapter. v1 needs:

- **Render** (simplegoapp → Palisades): trigger the service's deploy hook,
  poll Render's API until the deploy is live, then `GET /health` on the
  Palisades URL (the framework registers `/health` automatically). Healthy →
  **Open**.
- **Cloudflare** (Base to Base itself, `basetobase/**`): `wrangler deploy`
  from an Actions job, then a health check on Dispatch. Because a bad
  Dispatch deploy can break the thing that deploys it, the owner keeps a
  manual fallback (`wrangler rollback`). PRs that touch `basetobase/` are
  not patrolled or auto-deployed until milestone 5 (§17); until then Base to
  Base is deployed by hand.

Adapters are chosen by changed paths (monorepo): Go changes deploy to
Render, `basetobase/` changes deploy to Cloudflare, and a PR touching both
deploys both, in parallel. The run is **Open** only when every deploy it
needed is healthy.

A failed deploy marks the run Failed in *Needs you*. Render keeps the
previous deploy serving when a build fails; no auto-rollback in v1.

## 9. Dashboard

The mockup is the reference for layout and behavior:
https://claude.ai/artifact/V9dkyJTXo7Wz6wvtHr7PP2 . It's a design artifact,
not code to port.

**Runs list:** three groups — *Wind hold · needs you*, *On the hill*
(running), *Open* (recently deployed). Each entry: trail-rating symbol, run
name, PR number and title, current status.

**Run view:**

- PR header: number, title, branch, head SHA, Backend/Frontend run, rating
  and run name, link to the PR.
- The pipeline row: the seven steps, each with themed name, plain name,
  status, duration (or live elapsed); milestone flags. Clicking a step shows
  its detail.
- On open, the **current step is selected**, showing:
  - time on step vs. **usual** (median of past runs for that step;
    designer's call) and a *Longer than usual* flag beyond 1.5× the median
    **(designer's call)**; with fewer than 3 past runs, "usual" is simply not
    shown
  - in the huddle, a bar and countdown to wind hold
  - **Conditions report**: plain summaries from the verdicts and Dispatch
  - **Patrol on this step**: one card per agent with status and detail;
    clicking a card filters the Radio log to that agent
  - **Hazards flagged**: id, raised by, text, status (open / being groomed /
    cleared in `<sha>` / withdrawn / accepted by owner)
  - **Radio log**: the live, time-ordered event stream
  - **Evidence**: request/response transcripts and screenshots, inline
- **Debug** controls (the owner asked for "the ability to debug"; the
  specific set is the designer's proposal and the owner hasn't picked):
  - Full transcript of any agent's Claude Code session (rendered from
    stream-json)
  - Link to the GitHub Actions job (raw runner logs)
  - Re-run this step on a fresh runner
  - Wind hold (pause): finish the current step, then hold; Resume
  - Radio a patroller: send a message into a running agent's session — later
    milestone, not v1 **(designer's call)**

**Global states shown:** Dispatch freshness ("last event Ns ago"), *Lift
closed — reopens at HH:MM* when Claude usage limits pause all runs, queued
agents waiting for a concurrency slot.

**Access:** sign in with GitHub, allowlist of one (the owner). All reads and
every mutating action require it **(designer's call)**.

**Quality bar:** WCAG AA contrast, real buttons and links, works at phone
width, live updates without reload.

**Look:** night-navy header with a ridgeline, snow-white panels, condensed
uppercase headings like trail signage, monospace logs on dark. Trail-rating
symbols are standard: green circle, blue square, black diamond, double black
diamond. Milestones use flags (diamonds are taken by ratings).

## 10. Naming and trail ratings

**Vocabulary** (designer's picks, owner approved the direction):

| Themed | Means |
|---|---|
| Base to Base | the product (after the gondola joining Palisades and Alpine Meadows) |
| Dispatch | the coordinator |
| Alpine | the ephemeral test environment |
| Palisades | production |
| Patrol / patroller | reviewer agents |
| Groomer | implementer agent |
| Hazard | a concern raised by a patroller |
| Huddle | quorum loop |
| Wind hold | 30-minute give-up, or owner pause |
| Lift closed | paused for Claude usage limits |
| Radio log | logs |
| Conditions report | step notes |
| Steps & milestones | §5 |

**Trail ratings.** At the trail map step, Dispatch rates every PR by size
and risk, and gives it a run name in that color (owner's idea: short greens
for simple PRs, then blue, black, double black runs for bigger ones).

Starting thresholds **(designer's call; configurable)**:

| Rating | Rule |
|---|---|
| Green circle | ≤ 50 lines changed, ≤ 3 files, no risk paths |
| Blue square | ≤ 300 lines changed, no risk paths |
| Black diamond | > 300 lines, or touches a risk path (auth, money, data migrations, secrets/config) |
| Double black | > 1,000 lines, or schema/infra/CI changes, or spans ≥ 4 top-level directories |

Risk paths are globs per repo in config.

**Run names** are a config list per rating, seeded from public trail
listings. Alpine Meadows has only two or three greens, all bunny hills, so
the seed leans on Olympic Valley. Ratings in the seed were not checked
against the official trail map, which is fine for a cosmetic list.

- **Green:** Easy Slider, Ramp Run, Bunny Hill
- **Blue:** Home Run, Tomlinson's, Shirley Bowl, Champs Elysees
- **Black:** Red Dog Face, Headwall Face
- **Double black:** Our Father, Fingers, Chimney, Clear Gully

Each run takes the next name in its rating's list that no active run is
using. The owner can extend the lists with any Ikon mountain's runs or
lodges.

The rating is display-only in v1. It does not change the panel or models
**(designer's call)**.

## 11. Agents on GitHub Actions

- **One workflow in each watched repo,** e.g.
  `.github/workflows/basetobase-agent.yml`, triggered **only** by
  `workflow_dispatch` from Dispatch. Its inputs are run id, role, step,
  round, and SHA. It is never triggered by `pull_request`, and Dispatch never
  dispatches for fork PRs, so the Claude token never meets fork code.
- **Each job:**
  1. Check out the templates and the forwarder from the default branch,
     never the PR. Then check out the target SHA separately, or the merge
     ref for the summit check.
  2. Install a pinned Claude Code version.
  3. Start services the role needs: Postgres, the app, Chromium.
  4. Run `claude -p` with the role's prompt, `--output-format stream-json`,
     the role's model, and the role's tool allowlist. The forwarder gives
     claude the prompt on stdin.
- **Permissions by role** **(designer's call)**:
  - Patrollers: `contents: read`. They can run the app and tests but can't
    push.
  - Groomer: `contents: write` (the job's `GITHUB_TOKEN`) to push to the PR
    branch.
- **Forwarder.** A small wrapper process in the job:
  - batches stream-json events to Dispatch about every 2 seconds, which keeps
    well under Cloudflare's free 100k requests a day
  - uploads the full transcript and evidence at the end
  - posts the verdict
  - authenticates every call with the job's GitHub OIDC token (audience =
    Dispatch). Dispatch verifies issuer, repo, workflow, and run id.
- **Auth for Claude:** a `CLAUDE_CODE_OAUTH_TOKEN` repo secret from
  `claude setup-token`, on the owner's subscription.
- **Models:** Claude Code's `sonnet` alias for patrollers, `opus` for Groomer
  **(designer's call)**. Aliases track the latest models. Configurable per
  role.
- **Parallel by default** (owner). Running agents at the same time doesn't
  cost more quota than running them one after another — the total work is
  the same; it just finishes sooner. So by default every patroller on a
  panel starts at once.
- **Global cap as a safety valve:** at most 8 agent jobs at once across all
  runs by default — enough for the largest panel (both panels together) —
  configurable **(designer's call)**. Beyond the cap, jobs queue, and the
  dashboard shows them as queued. It protects against several PRs at once
  burning the 5-hour window in minutes.
- **Serialized only where it must be:**
  - Groomer, the single writer to a branch (§7)
  - the huddle's re-check round, which waits for Groomer's push
- **Lift closed:** when Claude Code reports a usage-limit error, the
  forwarder reports the reset time. Dispatch then:
  - pauses all runs, since the quota is shared
  - stops the wind-hold clocks
  - re-dispatches the interrupted jobs after the reset
- **Failures:** each job has `timeout-minutes: 25` **(designer's call)**. A
  failed or timed-out job is retried once, then shows as an agent failure on
  the dashboard, and the huddle clock keeps running. The watchdog alarm
  checks job status through the API if a running agent goes 10 minutes
  without events **(designer's call)**.

## 12. Dispatch internals

- **Worker endpoints** (shape is the builder's):
  - GitHub webhook (verify `X-Hub-Signature-256`)
  - agent events, verdicts, and evidence (OIDC-verified)
  - dashboard API and WebSocket
  - owner actions
  - static dashboard assets
- **One Durable Object per run:**
  - the state machine (§5, §7)
  - the event log in its SQLite
  - alarms for the wind hold, lift-closed resume, and watchdog
  - WebSocket fan-out, using hibernation so idle viewers cost nothing

  Confirm that WebSocket hibernation is available on the Workers Free plan
  before building on it. If it isn't, the fallback is the dashboard polling
  the run every few seconds — the UI must not depend on which one is used.
- **D1:** the runs index and per-step durations (for "usual").
- **R2:** transcripts and evidence, kept 30 days **(designer's call)**.
- **GitHub App** (owned by the owner, installed on watched repos):
  - permissions: pull requests read/write, contents read/write (for merge),
    actions read/write (dispatch and cancel workflows), checks read/write,
    metadata read
  - events: `pull_request`, `workflow_job`
  - installation tokens minted in the Worker, signing the JWT with WebCrypto
- **Check run:** Dispatch posts a *Base to Base* check run on the PR head
  that mirrors the run state, so GitHub's own UI shows it
  **(designer's call)**. It doesn't change branch protection.
- **Idempotency:** dedupe webhook deliveries by delivery id, and agent posts
  by (job, sequence).

## 13. Prerequisites in simplegoapp

The builder must handle these before Palisades can run:

- **Bind address.** `main.go` hardcodes `"localhost"` and `8080`, but Render
  needs `0.0.0.0` and `$PORT`. Read both from the environment, keeping the
  current defaults.
- **Production config and secrets.** `ENV=PRODUCTION` loads the committed
  `config.yml`, which holds secret-looking values (the Ticketmaster key). The
  key should be revoked, and production secrets should come from Render
  environment variables, not a committed file. The config loader reads YAML
  only today, so this needs a small framework change. The design is the
  builder's, following the framework's config conventions
  (`docs/BEST_PRACTICES.md` §4).
- **Neon.** `postgres.NewService` is mandatory at startup. Confirm the DSN
  `pkg/postgres` builds supports `sslmode=require`, which Neon needs.
- **End-to-end harness.** There is none today. Add:
  - a compose file with Postgres
  - an end-to-end Go test package behind a build tag that drives the running
    app over HTTP
  - the CI-only config (`local.yml` is what non-production runs load)

  The existing CI workflow stays as it is. New directories that embody a
  pattern get a CLAUDE.md (repo rule).

**Monorepo layout and isolation** (owner chose the monorepo; layout is the
**designer's call**):

```
simplegoapp/                 Go module, unchanged (framework + template app)
├── basetobase/
│   ├── go.mod               empty nested module — see below
│   ├── CLAUDE.md            pattern doc (repo rule)
│   ├── dispatch/            Worker + Durable Objects (TS)
│   ├── dashboard/           dashboard app (TS), served as Worker assets
│   ├── forwarder/           agent-side wrapper run on the Actions runner
│   ├── config/              patrol config, trail names, free-tier limits
│   └── wrangler.jsonc
├── .basetobase/patrol/      patroller criteria prompts (§6)
└── .github/workflows/
    ├── ci.yml               existing Go CI
    ├── basetobase-ci.yml    TS lint/typecheck/test, paths: basetobase/**
    └── basetobase-agent.yml workflow_dispatch-only agent runner (§11)
```

- **Keep Base to Base out of the Go module.** A placeholder `go.mod`
  (`module github.com/aghchan/simplegoapp/basetobase`, no code) makes
  `basetobase/` a separate module. That keeps it out of `go build ./...`,
  `go vet ./...` and `go test ./...`, out of the Go module zip that
  consumers and `gonew` download, and stops any `.go` files inside
  `node_modules` from leaking into Go tooling.
- **Fix the gofmt check.** CI's `test -z "$(gofmt -l .)"` walks every
  directory, including `node_modules`. Change it to list tracked Go files
  only (`gofmt -l $(git ls-files '*.go')`).
- **Path-filter the CIs.** Go CI ignores changes only under `basetobase/`,
  and the TS CI runs only for `basetobase/**`, so the two CIs run in
  parallel and stay independent.

## 14. Security

- **Only the owner's same-repo PRs run.** Dispatch checks the author against
  an allowlist and requires the head repo to equal the base repo. Fork PRs
  never reach a runner with secrets.
- **The agent workflow can only be started by Dispatch.** It's
  `workflow_dispatch`-only, and secrets go to those runs alone.
- **Groomer is the only agent with push rights.** No agent can merge or
  deploy: Dispatch does those through the GitHub App, after the gates.
- **Every inbound call is authenticated:**
  - webhooks by signature
  - agent posts by GitHub OIDC
  - the dashboard by GitHub sign-in with an allowlist of one
- **PR content is untrusted input to the agents' prompts.** The patrol prompts
  fence it as data. Only the owner's PRs run, but they may quote external
  text.
- **The Claude token never leaves Actions secrets.** It isn't stored in
  Dispatch.

## 15. Free-tier budget

Researched 2026-10-20, mostly from third-party summaries, because several
vendor pages were unreachable from the research environment. Recheck
Cloudflare's free Durable Objects limits before building.

| Service | Free allowance relied on | Pressure point |
|---|---|---|
| Cloudflare Workers | 100k requests/day, 10 ms CPU per request | Log batching. Dispatch waits on I/O, and waiting isn't CPU. |
| Durable Objects (free) | SQLite-backed objects, ~100k requests/day, WebSocket hibernation | Fan-out to one viewer is small. |
| D1 / R2 | ~5 GB / 10 GB | 30-day retention on R2. |
| GitHub Actions | Unlimited standard runners on public repos | Private repos get ~2,000 min/month. |
| Render | 750 instance-hours/month, sleeps after 15 min idle, ~1 min wake | Palisades only. A cold start is fine. |
| Neon | 0.5 GB storage, scales to zero, no expiry | Palisades data size. |
| Claude subscription | The owner's plan, with 5-hour and weekly limits | Concurrency cap and Lift closed (§11). |

Gold Coast reads these limits from config, so it can flag a change that
would exceed them.

**Considered and rejected:**

| Option | Why rejected |
|---|---|
| Vercel | No WebSockets; scheduled jobs only once a day on the free plan; 5-minute functions |
| Render for Dispatch | Sleeps, with a 1-minute wake |
| Fly.io, Railway | No free tier |
| Koyeb | Free tier reportedly closed to new users |
| Supabase | Pauses after 7 days idle |
| Deno Deploy | Reported deprecation |
| Oracle Always Free | Card required, idle reclamation, halved in 2026 |
| Lambda-style functions for agents | Time caps, no Docker |
| Cloudflare Containers for Palisades | Needs Workers Paid ($5/month); owner chose to stay free |

**Card-required upgrade paths, if wanted later:**

- Google Cloud Run for Palisades: wakes in about a second.
- Northflank: an always-on free tier.

## 16. One-time owner setup

The builder can't do these steps; the plan should list them as owner tasks,
with exact click-paths, at the milestone that first needs each one:

- **Cloudflare account:** Workers, D1, and R2 enabled.
- **A GitHub App** with the §12 permissions:
  - created by the owner and installed on the watched repos
  - its private key and webhook secret stored as Worker secrets
  - a GitHub OAuth app (or the GitHub App's own user auth) for dashboard
    sign-in
- **Claude token:** `claude setup-token`, stored as the
  `CLAUDE_CODE_OAUTH_TOKEN` secret in each watched repo.
- **Render and Neon:**
  - a Render web service for simplegoapp (Palisades), with auto-deploy off,
    since Dispatch triggers deploys through the deploy hook
  - the deploy hook URL and a Render API key stored as Worker secrets
  - a Neon project, with its connection string in Render's environment
- **Revoke the Ticketmaster key** committed in `config.yml`.

## 17. Suggested build order

The owner said to *start* with the always-on agent and its UI, so the first
milestone is the skeleton, visible end to end. The plan may regroup the rest.

1. **Skeleton.**
   - the `basetobase/` scaffold and Go-module isolation (§13)
   - Dispatch on Cloudflare
   - the GitHub App receiving PR webhooks
   - the run Durable Object
   - the agent workflow running one patroller (Mainline) with the forwarder
   - the dashboard showing the run, the step, the live Radio log, and the
     transcript
2. Full patrol sweep, verdicts, hazards table, evidence.
3. Huddle loop, Groomer, wind hold, owner actions, Lift closed, concurrency
   cap.
4. Summit check, merge, Render deploy adapter, the simplegoapp prerequisites
   (§13).
5. Frontend panel with Playwright screenshots, the first time a dashboard PR
   is patrolled.
6. Radio a patroller.

## 18. Left to the builder

- The dashboard framework and styling approach. The mockup sets the look,
  not the stack.
- The verdict schema, event schema, and storage layout.
- Exact patroller prompt wording, within §6.
- The forwarder's implementation.
- How the end-to-end harness and compose file are laid out in simplegoapp.
- Tuning of thresholds and timeouts marked as the designer's calls.

## 19. Open questions

None. Everything not decided by the owner is marked as the designer's call
or listed in §18.
