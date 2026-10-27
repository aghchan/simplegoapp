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
import { close, jobOf, newestCheckOn, open, patrol, pullRequest, sha } from "./github.ts";

// A code PR with no approved design is held by Granite Chief. The owner bypasses that one finding
// from the run's page, in an emergency: the review passes and the design is owed, until a design PR
// for it lands. The sweeps are real, as in sync.spec.ts.

test.use({ baseURL });

test.beforeEach(async ({ context }) => {
  await signIn(context);
});

test("a: the owner bypasses the missing-design finding, and the design owed clears when a design PR lands", async ({
  page,
}, testInfo) => {
  const pr = prNumber(testInfo, 31);
  const pull = pullRequest(pr, `e2e: bypass ${pr}`);
  await openRunsList(page);
  const runId = await open(pull);
  await patrol(await jobOf(runId, "granite-chief"), ["No approved design"]);
  await patrol(await jobOf(runId, "mainline"));
  await expect(prLink(group(page, "Wind hold · needs you"), pr)).toBeVisible({ timeout: LIVE_MS });
  await expect.poll(() => newestCheckOn(pull.head.sha)).toMatchObject({ conclusion: "failure" });
  await expect(prLink(group(page, "Designs owed"), pr)).toHaveCount(0);

  await prLink(page, pr).click();
  await expect(page.getByRole("heading", { level: 1, name: pull.title })).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Dispatch live · connected" }),
  ).toBeVisible();
  const chip = page.getByText("Design bypassed (emergency)", { exact: true });
  await expect(chip).toHaveCount(0);

  const bypass = page.getByRole("button", { name: "Bypass design (emergency)" });
  const sent = Date.now();
  await bypass.click();
  await expect(chip).toBeVisible({ timeout: LIVE_MS });
  expect(Date.now() - sent).toBeLessThanOrEqual(LIVE_MS);
  await expect(prLink(group(page, "Swept · patrol done"), pr)).toBeVisible({ timeout: LIVE_MS });
  await expect(prLink(group(page, "Wind hold · needs you"), pr)).toHaveCount(0);
  await expect
    .poll(() => newestCheckOn(pull.head.sha), { timeout: LIVE_MS })
    .toMatchObject({ status: "completed", conclusion: "success" });
  await expect(prLink(group(page, "Designs owed"), pr)).toBeVisible({ timeout: LIVE_MS });
  await expect(bypass).toHaveCount(0);
  await screenshot(page, testInfo, "bypass-a-owed");

  // The design lands: a PR whose description says it is For: this one.
  const design = pullRequest(prNumber(testInfo, 32), `e2e: design for ${pr}`, `For: #${pr}`);
  const designRun = await open(design);
  await patrol(await jobOf(designRun, "granite-chief"));
  await patrol(await jobOf(designRun, "mainline"));
  await expect(prLink(group(page, "Swept · patrol done"), design.number)).toBeVisible({
    timeout: LIVE_MS,
  });
  // Reviewed is not landed: the design is still owed.
  await expect(prLink(group(page, "Designs owed"), pr)).toBeVisible();

  expect(await close(design, sha(`merge ${design.number}`))).toEqual({
    landed: [designRun],
    stopped: [],
    retitled: [],
  });
  await expect(prLink(group(page, "Landed · merged"), design.number)).toBeVisible({
    timeout: LIVE_MS,
  });
  await expect(prLink(group(page, "Designs owed"), pr)).toHaveCount(0, { timeout: LIVE_MS });
  // The bypassed PR itself is as the bypass left it: swept, its check passing.
  await expect(prLink(group(page, "Swept · patrol done"), pr)).toBeVisible();
  await expect(chip).toBeVisible();
  await expectNoReload(page);
  await screenshot(page, testInfo, "bypass-a-cleared");
});
