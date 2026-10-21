import { createHmac } from "node:crypto";
import path from "node:path";
import { expect, test, type Page, type TestInfo, type WebSocketRoute } from "@playwright/test";
import type { RoleId } from "../shared/src/config.ts";
import type {
  AgentSnapshot,
  LiveMessage,
  LobbyMessage,
  RunSnapshot,
  RunSummary,
} from "../shared/src/types.ts";
import { SESSION_COOKIE, signSession } from "../dispatch/src/auth/session.ts";
import {
  BASE_URL_ENV,
  GITHUB_URL_ENV,
  INSTALLATION_ID,
  OWNER,
  REPO,
  SESSION_SECRET,
  WEBHOOK_SECRET,
} from "./stack.ts";

const baseURL = process.env[BASE_URL_ENV];
const githubURL = process.env[GITHUB_URL_ENV];

type CheckCall = { method: "POST" | "PATCH"; id: number; body: Record<string, unknown> };

// The Base to Base check runs Dispatch posted for this PR's head, oldest first.
async function checksFor(pr: number): Promise<CheckCall[]> {
  const calls = (await (await fetch(`${githubURL}/__checks`)).json()) as CheckCall[];
  const created = calls.find((c) => c.method === "POST" && c.body.head_sha === `e2e-head-${pr}`);
  return created ? calls.filter((c) => c.id === created.id) : [];
}
const LIVE_MS = 3000;
// The 5 s poll, plus its fetch.
const POLLED_MS = 8000;

test.use({ baseURL });

test.beforeEach(async ({ context }) => {
  // Hermetic: nothing leaves the machine.
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
  const session = await signSession(SESSION_SECRET, OWNER, Date.now());
  await context.addCookies([{ name: SESSION_COOKIE, value: session, url: baseURL! }]);
});

// The stack is shared, so each test in each project has a pull request of its own.
function prNumber(testInfo: TestInfo, n: number): number {
  const project = testInfo.config.projects.findIndex((p) => p.name === testInfo.project.name);
  return (project + 1) * 100 + n;
}

const prTitle = (pr: number) => `e2e: live update ${pr}`;

async function pullRequestEvent(action: "opened" | "closed", pr: number): Promise<void> {
  const body = JSON.stringify({
    action,
    installation: { id: INSTALLATION_ID },
    repository: { full_name: REPO, default_branch: "main" },
    pull_request: {
      number: pr,
      title: prTitle(pr),
      body: null,
      html_url: `https://github.com/${REPO}/pull/${pr}`,
      draft: false,
      user: { login: OWNER },
      head: { ref: `e2e/${pr}`, sha: `e2e-head-${pr}`, repo: { full_name: REPO } },
      base: { ref: "main", sha: "e2e-base", repo: { full_name: REPO } },
    },
  });
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  const res = await fetch(`${baseURL}/github/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "pull_request",
      "X-Hub-Signature-256": `sha256=${signature}`,
    },
    body,
  });
  const answer = (await res.json()) as Record<string, unknown>;
  if (action === "opened") expect(answer).toHaveProperty("runId");
  else expect(answer).toMatchObject({ stopped: [expect.any(String)] });
}

const runLink = (page: Page, pr: number) =>
  page.getByRole("link", { name: new RegExp(`#${pr} ${prTitle(pr)}`) });

const group = (page: Page, title: string) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { level: 2, name: title, exact: true }) });

const isRunsFetch = (url: string) => new URL(url).pathname === "/api/runs";

// Frames the page's lobby socket received.
function lobbyFrames(page: Page): LobbyMessage[] {
  const frames: LobbyMessage[] = [];
  page.on("websocket", (ws) => {
    if (!ws.url().endsWith("/api/live")) return;
    ws.on("framereceived", ({ payload }) => frames.push(JSON.parse(String(payload))));
  });
  return frames;
}

// Resolves once the lobby socket is open: opening it is what makes the list fetch a second time.
// Then marks the page, which a reload would wipe.
async function openRunsList(page: Page): Promise<void> {
  let fetches = 0;
  const reopened = new Promise<void>((resolve) => {
    page.on("response", (res) => {
      if (isRunsFetch(res.url()) && ++fetches === 2) resolve();
    });
  });
  await page.goto("/");
  await reopened;
  await page.evaluate(() => Object.assign(globalThis, { e2eMark: true }));
}

async function expectNoReload(page: Page): Promise<void> {
  expect(await page.evaluate(() => Reflect.get(globalThis, "e2eMark"))).toBe(true);
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const file = `${name}-${page.viewportSize()?.width}.png`;
  const dir = process.env.E2E_SCREENSHOTS;
  await page.screenshot({
    path: dir ? path.join(dir, file) : testInfo.outputPath(file),
    fullPage: true,
  });
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
  await pullRequestEvent("opened", pr);
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
  await pullRequestEvent("opened", pr);
  await runLink(page, pr).click();
  await expect(page.getByRole("heading", { level: 1, name: prTitle(pr) })).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Dispatch live · connected" }),
  ).toBeVisible();
  const steps = page.getByRole("group", { name: "Steps of the run" });
  await expect(steps).not.toContainText("Stopped");
  // The gate: the review's PR check is created in progress, never passing.
  await expect.poll(async () => (await checksFor(pr))[0]?.body).toMatchObject({
    name: "Base to Base",
    status: "in_progress",
  });

  const sent = Date.now();
  await pullRequestEvent("closed", pr);
  await expect(steps).toContainText("Stopped", { timeout: LIVE_MS });
  await expect(
    group(page, "Closed").getByRole("link", { name: new RegExp(`#${pr} `) }),
  ).toBeVisible({
    timeout: LIVE_MS,
  });
  expect(Date.now() - sent).toBeLessThanOrEqual(LIVE_MS);
  await expect(group(page, "On the hill · running")).not.toContainText(`#${pr} `);
  // A closed PR's check ends cancelled: it never reads as a pass.
  await expect.poll(async () => (await checksFor(pr)).at(-1)?.body).toMatchObject({
    status: "completed",
    conclusion: "cancelled",
  });
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
  await pullRequestEvent("opened", pr);
  await polled;
  await expect(runLink(page, pr)).toBeVisible({ timeout: POLLED_MS });
  expect(connected).toHaveLength(1);
  await expectNoReload(page);
});

// A verdict needs a GitHub OIDC token, which the hermetic stack cannot mint, so this run is a
// fixture: the stack serves the dashboard, page routes answer its API and sockets.
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
