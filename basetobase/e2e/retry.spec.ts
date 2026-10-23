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
  brief,
  cancelled,
  failJob,
  jobsOf,
  newestCheckOn,
  open,
  patrol,
  pullRequest,
} from "./github.ts";

// A failed patroller runs again from the dashboard, without a new run: a fresh job on the same
// run, whose verdict settles the review and the check GitHub reads.

test.use({ baseURL });

test.beforeEach(async ({ context }) => {
  await signIn(context);
});

test("a: a patroller whose job failed is retried from the dashboard, and its pass clears the PR", async ({
  page,
}, testInfo) => {
  const pr = prNumber(testInfo, 21);
  const pull = pullRequest(pr, `e2e: retry ${pr}`);
  await openRunsList(page);
  const runId = await open(pull);
  const [first] = await jobsOf(runId);
  await brief(first!);
  await failJob(first!, "job failed before the agent reported");
  await expect(prLink(group(page, "Wind hold · needs you"), pr)).toBeVisible({ timeout: LIVE_MS });
  await expect.poll(() => newestCheckOn(pull.head.sha)).toMatchObject({ conclusion: "failure" });

  await prLink(page, pr).click();
  await expect(page.getByRole("heading", { level: 1, name: pull.title })).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Dispatch live · connected" }),
  ).toBeVisible();
  const cards = page.getByRole("button", { name: /^Mainline/ });
  await expect(cards).toContainText("Failed");

  const sent = Date.now();
  await page.getByRole("button", { name: "Retry the failed patroller" }).click();
  await expect(cards).toContainText("attempt 2", { timeout: LIVE_MS });
  expect(Date.now() - sent).toBeLessThanOrEqual(LIVE_MS);
  await expect(page.getByRole("button", { name: /^Retry/ })).toHaveCount(0);

  // The same run, a second job with its own nonce; the first job's is no good any more.
  const jobs = await jobsOf(runId);
  expect(jobs).toHaveLength(2);
  const [, second] = jobs;
  expect(second!.inputs.nonce).not.toBe(first!.inputs.nonce);
  expect(await cancelled()).toContain(String(first!.id));
  await expect
    .poll(() => newestCheckOn(pull.head.sha))
    .toMatchObject({
      status: "in_progress",
    });

  await patrol(second!);
  await expect(cards).toContainText("Clear · attempt 2", { timeout: LIVE_MS });
  await expect
    .poll(() => newestCheckOn(pull.head.sha))
    .toMatchObject({
      status: "completed",
      conclusion: "success",
    });
  await expect(page.getByText("mainline-sweep-0 retried · attempt 2")).toBeVisible();
  await expect(prLink(group(page, "Swept · patrol done"), pr)).toBeVisible({ timeout: LIVE_MS });
  await expect(prLink(group(page, "Wind hold · needs you"), pr)).toHaveCount(0);
  await expectNoReload(page);
  await screenshot(page, testInfo, "retry-a-cleared");
});
