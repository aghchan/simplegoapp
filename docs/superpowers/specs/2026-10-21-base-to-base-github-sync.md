# Base to Base — runs follow GitHub, GitHub follows runs

Owner asks (2026-10-21):

1. A distinct colour once a PR has gone all the way. Owner's call: **merged** counts, until M4 deploys.
2. The dashboard opens on the latest run, not a blank canvas.
3. Runs and GitHub stay in sync both ways.
4. A PR's runs are grouped together in the runs list, earlier runs collapsed.

The sync audit (33 confirmed desyncs, ids C1–C31, M1–M2) is the evidence for §2–§6. Full findings: the
`wl1arxs4f` audit output, summarised in the work split (§8).

## 1. Statuses (shared/src/types.ts, done)

- `RunStatus`: `on_the_hill | swept | landed | stopped | failed`. **Open runs** = `on_the_hill | swept`: the runs
  that still speak for their PR.
- `landed`: GitHub merged the PR on the run's head. Terminal until M4 adds deploy.
- `StepStatus` adds `skipped`: the run went past a step it never did.
- `RunSnapshot.mergeSha?`, `AgentSnapshot.briefedAt?`, `RunSummary.createdAt`.

## 2. Machine (dispatch/src/run/machine.ts)

- `stopRun(s, reason, now)`:
  - `on_the_hill`: as today, plus a `cancel` effect per agent that was live and has a known job.
  - `swept`: status `stopped`, log `stopped · <reason>`, index, broadcast. **No check effect**: the
    sweep's conclusion on GitHub stands.
  - Anything else: unchanged.
- `landRun(s, mergeSha, now)`. Already `landed` → unchanged. Otherwise:
  - Stop live agents (summary `stopped · PR merged`) and set active steps to `stopped`. Cancel live jobs.
  - Status `landed`, `mergeSha`.
  - `huddle` and `summit`, if still pending, become `skipped` with the notes "No huddle until M3." and
    "No summit check until M4.".
  - `drop_in` becomes `done` (start = finish = now) with the note `Merged on GitHub as <sha7>.`.
  - `send_it` becomes `skipped` with the note "Deploy is manual until M4.".
  - Effects: log `landed · merged as <sha7>`, index, broadcast. Add a check effect only when the
    outcome is `pending` (merged mid-review).
- `checkRunOf`: `cancelled` only while the outcome is `pending`. Titles: stopped → "Stopped", landed →
  "Merged before the review finished". A finished sweep keeps its outcome's conclusion whatever the status.
- `onRetitled(s, title, now)`: set `prTitle` (goal stays frozen), then index and broadcast. A same title
  → unchanged.
- Not-swept branch of `closeSweepIfDone`: also emit `check`, so the in-progress check tracks each verdict
  and failure (C18).
- `onBriefed(s, agentId, now, job)`: the job reached Dispatch.
  - `briefedAt = now` on every attempt (a re-run resets the clocks), and `lastEventAt` is cleared.
  - Stores private `jobRuns[agentId] = githubRunId` and sets `jobUrl` if unset. Broadcast.
- `deadlinesOf` (C21):
  - Not dispatched: `createdAt + STALL_MS`, failure "never dispatched" (as today).
  - Dispatched, not briefed: `dispatchedAt + JOB_START_MS` (30 min), failure "job never started on GitHub".
    No stall before the brief.
  - Briefed: timeout `briefedAt + AGENT_TIMEOUT_MS`, stall `(lastEventAt ?? briefedAt) + STALL_MS`.
- Effect `{ type: "cancel"; agentId }`. The DO POSTs `/repos/{repo}/actions/runs/{id}/cancel`. Best
  effort: a 409 (already done) is ignored, a failure is logged and not retried.

## 3. RunDO, agent route, lobby

- `land(mergeSha)`, `retitle(title)`. `stop(reason)` stays.
- `brief(agentId, nonce, job: { githubRunId: string; jobUrl: string })` returns
  `AgentBrief | "forbidden" | { gone: AgentStatus }`, and applies `onBriefed` after admit.
- `Report` "gone" carries the agent's status: `{ gone: AgentStatus }`. Route answers:
  - Forbidden → 403.
  - Gone → 410 `{"error":"no longer wanted","agent":"<status>"}`. This applies to `/brief` too
    (today 403).
- Durable outbox (C12):
  - `commit()` writes state and the index/check pending marks in one `storage.put({...})` whenever the
    transition carries those effects. Each mark holds a revision.
  - `index()` and `syncCheck()` no longer clear the mark before writing. After success they delete it
    only if it still holds the revision they read. A reset at any point leaves a mark and the 60 s
    retry alarm.
- `announce` returns whether it reached the lobby. If the write succeeded but the announce failed,
  `index()` sets the index mark again (C31).
- GitHub client: `cancelWorkflowRun(repo, runId)`.

## 4. Webhook and routes (dispatch/src/github, routes/github.ts, runs/index.ts)

- `PullRequestRef` adds `baseRef` and `draft`.
- `toTrigger` (repo, fork and author filters as today):
  - `start`: opened, reopened, ready_for_review, synchronize; also `edited` with `changes.base`, as
    `retarget: true`. Drafts are no longer refused here: the route reads the live state.
  - `closed`: `{ repo, prNumber, installationId }`. The payload's `merged` is not trusted: GitHub is read
    instead (out-of-order deliveries, C4/C29).
  - `retitle`: `edited` with `changes.title` and no `changes.base`.
- Client: `pullState(repo, n)` → `{ state, draft, merged, mergeSha, headSha, baseRef, title }` from one
  `GET /pulls/{n}`. It replaces `pullHeadSha`.
- Index: `findOpenRuns(repo, pr)` (open runs: id, headSha, status, createdAt); `findPrRuns(repo, pr)`
  (any status); `openRunPrs()` (repo, pr pairs with open runs); `hasRunOnHead(repo, pr, sha)`.
- `reconcilePr(env, github, repo, pr, live?)`, idempotent, is used by every path:
  - Closed and merged: land the newest run (any status) on `live.headSha`, then stop the other open
    runs ("PR merged").
  - Closed, not merged: stop the open runs ("PR closed").
  - Open:
    - Keep the newest open run on `live.headSha`. Stop every other open run
      (`superseded by <sha7>`).
    - A draft, or a base other than the default branch, keeps none.
    - Retitle the open runs whose title differs.
- Start path, in this order:
  1. `pullState`. Not open, or the head moved → `{ignored:"stale"}` (C5/C16).
  2. Draft → `reconcilePr` (it supersedes the old head's runs), then `{ignored:"draft"}` (C7/C17).
  3. Base not the default branch → `reconcilePr`, then `{ignored:"base"}`. Only PRs into the default
     branch are patrolled (C8/C33).
  4. Unless `retarget`: an open run already on this head → `{ignored:"duplicate"}`.
  5. List the files.
  6. Unpatrolled → post the neutral check **first**, then `reconcilePr`, then `{ignored:"unpatrolled"}`
     (C10/C28).
  7. Otherwise: `activeRunNames` falls back to `[]` on error. Start the run, **then**
     `reconcilePr(live re-read)`, which stops whichever runs lost a concurrent start (C6/C27).
- Closed path: `pullState`. Still open → `{ignored:"stale"}`. Otherwise `reconcilePr`.
- Retitle path: `onRetitled` on every run of the PR (`findPrRuns`).

## 5. Reconcile cron (C10/C13/C28 safety net)

- `triggers.crons: ["*/5 * * * *"]`, with a `scheduled` handler next to `fetch`.
- Each tick:
  1. Installation id: `GET /repos/{REPO}/installation` (App JWT).
  2. For every PR in `openRunPrs()`: `reconcilePr`.
  3. Open PRs (`GET /repos/{REPO}/pulls?state=open&per_page=100`) that are the owner's, same-repo,
     non-draft and into the default branch: when the head has no run (`hasRunOnHead`) **and** no
     Base to Base check from this App (`GET /commits/{sha}/check-runs?check_name=…&app_id=…`), run the
     start path for it.
- Bounded: at most 50 PRs a tick. Log what was started, stopped or landed. One PR's failure never stops
  the tick.

## 6. Agent jobs (forwarder, workflow)

- Workflow:
  - `run-name: Base to Base · ${{ inputs.run_id }} · ${{ inputs.agent_id }}`; the job is named by
    `agent_id` (C23).
  - A last step, `if: failure() || cancelled()`, fetches an OIDC token and POSTs `/agent/failure` with
    `job <status> before the agent reported`. It uses curl and jq only, env vars only, never prints the
    token, and has `continue-on-error`. A 410 means the agent already reported, which is fine (C15/C20).
- Forwarder:
  - The 410 body's `agent` decides the exit: `clear` and `stopped` → 0, anything else → 1. A brief 403
    (forbidden) → 1 (C14/C22/C24).
  - Event `seq` starts at `(GITHUB_RUN_ATTEMPT − 1) × 1 000 000`, so a re-run's events are not deduped
    away (M1).
- No `workflow_job` subscription: it would need the owner to edit the App. The failure step, the
  never-started deadline and cancel-on-stop cover it.

## 7. Dashboard

- `--landed` (violet, AA on surface and tint) is the "all the way" colour, on:
  - the runs-list card;
  - the PR header (`Landed · merged as <sha7>` chip and a violet edge);
  - the Drop in step (a new `landed` Mark tone with its own shape: a filled circle with a white
    flag).
- Runs-list groups: Needs you, On the hill, Swept, **Landed**, Closed.
  - `groupOf`: landed → Landed; stopped → Closed (whatever the outcome); failed, or swept with
    hazards/failed → Needs you.
- A PR shows once, filed by its **speaking run**: the newest open run (`on_the_hill`, `swept`), else the newest landed, else the newest. (Dispatch keeps the newest open run on the PR's head, so a run it stopped in a race can have a larger `createdAt`.) Its other runs collapse under it:
  a disclosure button ("N earlier runs", `aria-expanded`). It opens by itself when the current page is
  one of them.
- `/` shows the newest of the PRs' speaking runs (largest `createdAt` among them), marked current in the list. When a newer one arrives
  live, `/` follows it. `/runs/:id` pins one.
- `defaultStep` for a landed run is `drop_in`.

## 8. Work split

| Agent | Scope | Findings |
|---|---|---|
| A1 machine+DO | §2, §3, `routes/agent.ts`, client `cancelWorkflowRun`, `lobby/do.ts` | C1–3/19/25/26 (transitions), C12, C14, C18, C21, C22, C23, C31, M1 (clocks) |
| A2 GitHub edges | §4, §5 (on A1) | C1–C10, C13, C16, C17, C27–C30, C33 |
| A3 jobs | §6 | C11, C14, C15, C20, C22–C24, M1 |
| A4 dashboard | §7 | owner asks 1, 2, 4 |

Then: integrate, e2e (fake GitHub grows the new routes), adversarial review, PR.
