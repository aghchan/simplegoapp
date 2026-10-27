import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import type { RoleId } from "../shared/src/config.ts";
import type {
  AgentSnapshot,
  LiveMessage,
  LobbyMessage,
  RunSnapshot,
  RunSummary,
} from "../shared/src/types.ts";
import {
  baseURL,
  expectNoReload,
  group,
  isRunsFetch,
  LIVE_MS,
  openRunsList,
  prNumber,
  screenshot,
  signIn,
} from "./dashboard.ts";
import { brief, cancelled, checksOn, close, jobOf, open, pullRequest } from "./github.ts";
import { OWNER, REPO } from "./stack.ts";

// The 5 s poll, plus its fetch.
const POLLED_MS = 8000;

test.use({ baseURL });

test.beforeEach(async ({ context }) => {
  await signIn(context);
});

const prTitle = (pr: number) => `e2e: live update ${pr}`;

const runLink = (page: Page, pr: number) =>
  page.getByRole("link", { name: new RegExp(`#${pr} ${prTitle(pr)}`) });

// Frames the page's lobby socket received.
function lobbyFrames(page: Page): LobbyMessage[] {
  const frames: LobbyMessage[] = [];
  page.on("websocket", (ws) => {
    if (!ws.url().endsWith("/api/live")) return;
    ws.on("framereceived", ({ payload }) => frames.push(JSON.parse(String(payload))));
  });
  return frames;
}

test("a: a pull request opened while the runs list is open appears in it", async ({
  page,
}, testInfo) => {
  const pr = prNumber(testInfo, 1);
  const frames = lobbyFrames(page);
  await openRunsList(page);
  const fetches: string[] = [];
  page.on("request", (req) => {
    if (isRunsFetch(req.url())) fetches.push(req.url());
  });

  const sent = Date.now();
  await open(pullRequest(pr, prTitle(pr)));
  await expect(runLink(page, pr)).toBeVisible({ timeout: LIVE_MS });
  expect(Date.now() - sent).toBeLessThanOrEqual(LIVE_MS);
  await expect(group(page, "On the hill · running")).toContainText(`#${pr} `);

  // It came over the socket: the list did not fetch.
  expect(frames).toContainEqual({
    type: "summary",
    run: expect.objectContaining({ prNumber: pr }),
  });
  expect(fetches).toEqual([]);
  await expectNoReload(page);
  await screenshot(page, testInfo, "a-runs-list");
});

test("b: an open run goes to Stopped when its pull request closes, and the list moves it to Closed", async ({
  page,
}, testInfo) => {
  const pr = prNumber(testInfo, 2);
  await openRunsList(page);
  const pull = pullRequest(pr, prTitle(pr));
  const runId = await open(pull);
  // Mainline's job has started on GitHub; Granite Chief's has not.
  const job = await jobOf(runId, "mainline");
  await brief(job);
  await runLink(page, pr).click();
  await expect(page.getByRole("heading", { level: 1, name: prTitle(pr) })).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Dispatch live · connected" }),
  ).toBeVisible();
  const steps = page.getByRole("group", { name: "Steps of the run" });
  await expect(steps).not.toContainText("Stopped");
  // The gate: the review's PR check is created in progress, never passing.
  await expect.poll(async () => (await checksOn(pull.head.sha))[0]?.body).toMatchObject({
    name: "Base to Base",
    status: "in_progress",
  });

  const sent = Date.now();
  expect(await close(pull)).toEqual({ landed: [], stopped: [runId], retitled: [] });
  await expect(steps).toContainText("Stopped", { timeout: LIVE_MS });
  await expect(
    group(page, "Closed").getByRole("link", { name: new RegExp(`#${pr} `) }),
  ).toBeVisible({
    timeout: LIVE_MS,
  });
  expect(Date.now() - sent).toBeLessThanOrEqual(LIVE_MS);
  await expect(group(page, "On the hill · running")).not.toContainText(`#${pr} `);
  // A closed PR's check ends cancelled: it never reads as a pass.
  await expect.poll(async () => (await checksOn(pull.head.sha)).at(-1)?.body).toMatchObject({
    status: "completed",
    conclusion: "cancelled",
  });
  // And Mainline's job, which had started, is cancelled on GitHub.
  expect(await cancelled()).toContain(String(job.id));
  await expectNoReload(page);
  await screenshot(page, testInfo, "b-run-view");
});

test("c: with the lobby socket dropped, the list still updates by polling", async ({
  page,
}, testInfo) => {
  const pr = prNumber(testInfo, 3);
  const connected: WebSocketRoute[] = [];
  let dropped = false;
  await page.routeWebSocket(/\/api\/live$/, async (ws) => {
    // Closed before it opens, as a failed reconnect would be.
    if (dropped) return ws.close();
    ws.connectToServer();
    connected.push(ws);
  });
  await openRunsList(page);

  dropped = true;
  for (const ws of connected) await ws.close();
  const polled = page.waitForRequest((req) => isRunsFetch(req.url()), { timeout: POLLED_MS });
  await open(pullRequest(pr, prTitle(pr)));
  await polled;
  await expect(runLink(page, pr)).toBeVisible({ timeout: POLLED_MS });
  expect(connected).toHaveLength(1);
  await expectNoReload(page);
});

// A fixture, so the list holds exactly these outcomes, a failed review among them: the stack serves
// the dashboard, page routes answer its API and sockets. sync.spec.ts sweeps real runs.
function hazardsRun(): { run: RunSnapshot; summaries: RunSummary[] } {
  const now = Date.now();
  const sweptAt = now - 60_000;
  const start = sweptAt - 14 * 60_000;
  const agent = (role: RoleId, over: Partial<AgentSnapshot>): AgentSnapshot => ({
    id: `${role}-sweep-0`,
    role,
    step: "sweep",
    round: 0,
    status: "clear",
    dispatchedAt: start,
    finishedAt: sweptAt,
    hasTranscript: false,
    hazards: [],
    ...over,
  });
  const run: RunSnapshot = {
    id: "e2e-hazards",
    repo: REPO,
    prNumber: 958,
    prTitle: "orders: add cancel endpoint",
    prUrl: `https://github.com/${REPO}/pull/958`,
    branch: "e2e/958",
    headSha: "a91f3c2e0b7d4c1f8a6e5d3b2c1a0f9e8d7c6b5a",
    panels: ["backend"],
    rating: "black",
    runName: "Red Dog Face",
    goal: "Let a customer cancel their own pending order.",
    status: "swept",
    outcome: "hazards",
    steps: [
      { id: "lift_line", status: "done", startedAt: start, finishedAt: start, notes: [] },
      { id: "trail_map", status: "done", startedAt: start, finishedAt: start, notes: [] },
      {
        id: "sweep",
        status: "done",
        startedAt: start,
        finishedAt: sweptAt,
        outcome: "hazards",
        notes: [
          "Hazards flagged",
          "3 of 3 patrollers in · 1 hazard · 0 failed",
          "Granite Chief: The change fits the goal.",
          "KT-22: Cancel never checks the order's owner.",
          "Mainline: 18 end-to-end requests behave.",
        ],
      },
      ...(["huddle", "summit", "drop_in", "send_it"] as const).map((id) => ({
        id,
        status: "pending" as const,
        notes: [],
      })),
    ],
    agents: [
      agent("granite-chief", { summary: "The change fits the goal." }),
      agent("kt-22", {
        status: "hazards",
        summary: "Cancel never checks the order's owner.",
        hazards: [{ id: "SEC-1", title: "Anyone can cancel any order", detail: "No owner check." }],
      }),
      agent("mainline", { summary: "18 end-to-end requests behave." }),
    ],
    createdAt: start,
    updatedAt: sweptAt,
  };
  const summary = (over: Partial<RunSummary>): RunSummary => ({
    id: run.id,
    prNumber: run.prNumber,
    prTitle: run.prTitle,
    runName: run.runName,
    rating: run.rating,
    status: run.status,
    outcome: run.outcome,
    currentStep: "sweep",
    createdAt: start,
    updatedAt: sweptAt,
    ...over,
  });
  const summaries = [
    summary({}),
    summary({ id: "e2e-failed", prNumber: 957, runName: "Headwall Face", outcome: "failed" }),
    summary({
      id: "e2e-clear",
      prNumber: 956,
      prTitle: "docs: fix a typo",
      runName: "Easy Slider",
      rating: "green",
      outcome: "clear",
      updatedAt: sweptAt - 1,
    }),
  ];
  return { run, summaries };
}

test("d: a run whose patrol flagged hazards never reads as a pass", async ({ page }, testInfo) => {
  const { run, summaries } = hazardsRun();
  await page.route(/\/api\/me$/, (route) => route.fulfill({ json: { login: OWNER } }));
  await page.route(/\/api\/runs$/, (route) => route.fulfill({ json: summaries }));
  await page.route(new RegExp(`/api/runs/${run.id}$`), (route) =>
    route.fulfill({ json: { run, log: [] } }),
  );
  // Answered here, so neither socket reaches the stack; the lobby one sends nothing.
  await page.routeWebSocket(/\/api\/live$/, () => {});
  await page.routeWebSocket(new RegExp(`/api/runs/${run.id}/live$`), (ws) => {
    const snapshot: LiveMessage = { type: "snapshot", run, log: [] };
    ws.send(JSON.stringify(snapshot));
  });

  await page.goto(`/runs/${run.id}`);
  await expect(page.getByRole("heading", { level: 1, name: run.prTitle })).toBeVisible();

  const needsYou = group(page, "Wind hold · needs you");
  await expect(needsYou.getByRole("link", { name: /#958 / })).toContainText("Hazards flagged");
  await expect(needsYou.getByRole("link", { name: /#957 / })).toContainText("Review failed");
  await expect(group(page, "Swept · patrol done").getByRole("link")).toHaveCount(1);
  await expect(group(page, "Swept · patrol done")).toContainText("#956 ");

  const steps = page.getByRole("group", { name: "Steps of the run" });
  const sweep = steps.getByRole("button", { name: /Patrol sweep/ });
  await expect(sweep).toContainText("Done · hazards flagged");
  await expect(sweep.locator(".mark-hazard")).toHaveCount(1);
  await expect(sweep.locator(".mark-ok")).toHaveCount(0);
  // All verdicts are in, so Swept is reached, but its flag is not green.
  await expect(steps.locator(".milestone").filter({ hasText: "Swept" })).toHaveText(
    "Swept reached",
  );
  await expect(steps.locator(".flag-ok")).toHaveCount(0);

  const detail = page.getByRole("region", { name: "Step detail" });
  await expect(detail.locator(".note").first()).toHaveText("Hazards flagged");
  await screenshot(page, testInfo, "hazards-run");
});
