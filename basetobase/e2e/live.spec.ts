import { createHmac } from "node:crypto";
import path from "node:path";
import { expect, test, type Page, type TestInfo, type WebSocketRoute } from "@playwright/test";
import type { LobbyMessage } from "../shared/src/types.ts";
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
