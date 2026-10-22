import { expect, test } from "@playwright/test";
import {
  baseURL,
  expectNoReload,
  group,
  LIVE_MS,
  openRunsList,
  prLink,
  prNumber,
  screenshot,
  signIn,
} from "./dashboard.ts";
import {
  checksOn,
  close,
  jobsOf,
  onGitHub,
  open,
  patrol,
  pullRequest,
  push,
  reconcileTick,
  sha,
} from "./github.ts";

// Runs follow their PR on GitHub, live. The sweeps are real: each agent's job briefs and reports
// over /agent with an OIDC token the fake GitHub minted.

// --landed, #6d28d9.
const LANDED = "rgb(109, 40, 217)";

test.use({ baseURL });

test.beforeEach(async ({ context }) => {
  await signIn(context);
});

// Every agent of the run reports: these hazards, or clear.
async function sweep(runId: string, hazards: string[] = []): Promise<void> {
  const jobs = await jobsOf(runId);
  expect(jobs.length).toBeGreaterThan(0);
  for (const job of jobs) await patrol(job, hazards);
}

const lastCheck = async (headSha: string) => (await checksOn(headSha)).at(-1)?.body;

test("a: a PR merged after a clear review lands its run, live and in violet, its check still passing", async ({
  page,
}, testInfo) => {
  const pr = prNumber(testInfo, 11);
  const pull = pullRequest(pr, `e2e: merge ${pr}`);
  await openRunsList(page);
  const runId = await open(pull);
  await sweep(runId);
  await expect(prLink(group(page, "Swept · patrol done"), pr)).toBeVisible({ timeout: LIVE_MS });
  await expect.poll(() => lastCheck(pull.head.sha)).toMatchObject({
    status: "completed",
    conclusion: "success",
  });
  await prLink(page, pr).click();
  await expect(page.getByRole("heading", { level: 1, name: pull.title })).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Dispatch live · connected" }),
  ).toBeVisible();

  const mergeSha = sha(`merge ${pr}`);
  const sent = Date.now();
  expect(await close(pull, mergeSha)).toEqual({ landed: [runId], stopped: [], retitled: [] });
  const card = prLink(group(page, "Landed · merged"), pr);
  await expect(card).toBeVisible({ timeout: LIVE_MS });
  expect(Date.now() - sent).toBeLessThanOrEqual(LIVE_MS);
  await expect(prLink(group(page, "Swept · patrol done"), pr)).toHaveCount(0);
  await expect(card).toHaveCSS("border-left-color", LANDED);
  await expect(card.getByText("Landed · merged", { exact: true })).toHaveCSS("color", LANDED);

  const head = page.getByRole("region", { name: "Pull request" });
  await expect(head).toContainText(`Landed · merged as ${mergeSha.slice(0, 7)}`);
  const steps = page.getByRole("group", { name: "Steps of the run" });
  const dropIn = steps.getByRole("button", { name: /^Drop in/ });
  await expect(dropIn).toContainText("Done");
  await expect(dropIn.locator(".mark-landed")).toHaveCount(1);
  await expect(steps.getByRole("button", { name: /^Send it/ })).toContainText("Skipped");
  // A finished sweep's conclusion stands: the merge wrote nothing to the check.
  expect(await lastCheck(pull.head.sha)).toMatchObject({
    status: "completed",
    conclusion: "success",
  });
  await expectNoReload(page);
  await screenshot(page, testInfo, "sync-a-landed");
});

test("b: a push takes a PR whose review flagged hazards out of Needs you, its old run collapsed under the new", async ({
  page,
}, testInfo) => {
  const pr = prNumber(testInfo, 12);
  const pull = pullRequest(pr, `e2e: push ${pr}`);
  await openRunsList(page);
  const oldRun = await open(pull);
  const oldHead = pull.head.sha;
  await sweep(oldRun, ["Cancel never checks the order's owner"]);
  const needsYou = group(page, "Wind hold · needs you");
  await expect(prLink(needsYou, pr)).toContainText("Hazards flagged", { timeout: LIVE_MS });

  const sent = Date.now();
  const newRun = await push(pull, sha(`head ${pr} pushed`));
  const onTheHill = group(page, "On the hill · running");
  await expect(prLink(onTheHill, pr)).toBeVisible({ timeout: LIVE_MS });
  expect(Date.now() - sent).toBeLessThanOrEqual(LIVE_MS);
  await expect(prLink(needsYou, pr)).toHaveCount(0);
  await expect(prLink(onTheHill, pr)).toHaveAttribute("href", `/runs/${newRun}`);

  const item = onTheHill.getByRole("listitem").filter({ has: prLink(page, pr) });
  const earlier = item.getByRole("button", { name: "1 earlier run" });
  const oldLink = item.locator(`a[href="/runs/${oldRun}"]`);
  await expect(earlier).toHaveAttribute("aria-expanded", "false");
  await expect(oldLink).toBeHidden();
  await earlier.click();
  await expect(earlier).toHaveAttribute("aria-expanded", "true");
  await expect(oldLink).toBeVisible();
  await expect(oldLink).toContainText("Stopped");
  // The old head keeps its failing check; the new head's review has begun.
  expect(await lastCheck(oldHead)).toMatchObject({ conclusion: "failure" });
  expect((await checksOn(pull.head.sha))[0]?.body).toMatchObject({ status: "in_progress" });
  await expectNoReload(page);
  await screenshot(page, testInfo, "sync-b-pushed");
});

test("c: a PR closed after its sweep moves its run to Closed live, its check still passing", async ({
  page,
}, testInfo) => {
  const pr = prNumber(testInfo, 13);
  const pull = pullRequest(pr, `e2e: close ${pr}`);
  await openRunsList(page);
  const runId = await open(pull);
  await sweep(runId);
  const swept = prLink(group(page, "Swept · patrol done"), pr);
  await expect(swept).toBeVisible({ timeout: LIVE_MS });
  await expect.poll(() => lastCheck(pull.head.sha)).toMatchObject({ conclusion: "success" });

  const sent = Date.now();
  expect(await close(pull)).toEqual({ landed: [], stopped: [runId], retitled: [] });
  await expect(prLink(group(page, "Closed"), pr)).toBeVisible({ timeout: LIVE_MS });
  expect(Date.now() - sent).toBeLessThanOrEqual(LIVE_MS);
  await expect(swept).toHaveCount(0);
  expect(await lastCheck(pull.head.sha)).toMatchObject({
    status: "completed",
    conclusion: "success",
  });
  await expectNoReload(page);
  await screenshot(page, testInfo, "sync-c-closed");
});

test("d: / opens the newest run, and follows a newer one as it arrives", async ({
  page,
}, testInfo) => {
  const first = pullRequest(prNumber(testInfo, 14), "e2e: newest run");
  const firstRun = await open(first);
  await openRunsList(page);
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toHaveText(first.title);
  await expect(page.locator(`a[href="/runs/${firstRun}"]`)).toHaveAttribute(
    "aria-current",
    "page",
  );

  const second = pullRequest(prNumber(testInfo, 15), "e2e: a newer run");
  const sent = Date.now();
  const secondRun = await open(second);
  await expect(title).toHaveText(second.title, { timeout: LIVE_MS });
  expect(Date.now() - sent).toBeLessThanOrEqual(LIVE_MS);
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.locator(`a[href="/runs/${secondRun}"]`)).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator(`a[href="/runs/${firstRun}"]`)).not.toHaveAttribute(
    "aria-current",
    "page",
  );
  await expectNoReload(page);
  await screenshot(page, testInfo, "sync-d-newest");
});

test("e: the reconcile cron starts a run for an open PR no webhook announced, and it appears live", async ({
  page,
}, testInfo) => {
  const pr = prNumber(testInfo, 16);
  const pull = pullRequest(pr, `e2e: cron ${pr}`);
  // The PR is open on GitHub, but its delivery never arrived.
  await onGitHub(pull);
  await openRunsList(page);
  await expect(prLink(page, pr)).toHaveCount(0);

  const sent = Date.now();
  await reconcileTick();
  const link = prLink(group(page, "On the hill · running"), pr);
  await expect(link).toBeVisible({ timeout: LIVE_MS });
  expect(Date.now() - sent).toBeLessThanOrEqual(LIVE_MS);
  await expect(link).toContainText(pull.title);
  // Started as the webhook would have: the gate's check is in progress on the head.
  expect((await checksOn(pull.head.sha))[0]?.body).toMatchObject({
    name: "Base to Base",
    status: "in_progress",
  });
  await expectNoReload(page);
  await screenshot(page, testInfo, "sync-e-cron");
});
