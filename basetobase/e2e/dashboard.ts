import path from "node:path";
import {
  expect,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { SESSION_COOKIE, signSession } from "../dispatch/src/auth/session.ts";
import { BASE_URL_ENV, OWNER, SESSION_SECRET } from "./stack.ts";

// The dashboard as the tests drive it.

export const baseURL = process.env[BASE_URL_ENV];
export const LIVE_MS = 3000;

// Signed in as the owner, and hermetic: nothing leaves the machine.
export async function signIn(context: BrowserContext): Promise<void> {
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
  const session = await signSession(SESSION_SECRET, OWNER, Date.now());
  await context.addCookies([{ name: SESSION_COOKIE, value: session, url: baseURL! }]);
}

// The stack is shared, so each test in each project has a pull request of its own. `n` is unique
// across the spec files.
export function prNumber(testInfo: TestInfo, n: number): number {
  const project = testInfo.config.projects.findIndex((p) => p.name === testInfo.project.name);
  return (project + 1) * 100 + n;
}

export const group = (page: Page, title: string) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { level: 2, name: title, exact: true }) });

// The PR's entry in the runs list, or in a group of it: its latest run's link.
export const prLink = (scope: Page | Locator, pr: number) =>
  scope.getByRole("link", { name: new RegExp(`#${pr} `) });

export const isRunsFetch = (url: string) => new URL(url).pathname === "/api/runs";

// Resolves once the lobby socket is open: opening it is what makes the list fetch a second time.
// Then marks the page, which a reload would wipe.
export async function openRunsList(page: Page): Promise<void> {
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

export async function expectNoReload(page: Page): Promise<void> {
  expect(await page.evaluate(() => Reflect.get(globalThis, "e2eMark"))).toBe(true);
}

export async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const file = `${name}-${page.viewportSize()?.width}.png`;
  const dir = process.env.E2E_SCREENSHOTS;
  await page.screenshot({
    path: dir ? path.join(dir, file) : testInfo.outputPath(file),
    fullPage: true,
  });
}
