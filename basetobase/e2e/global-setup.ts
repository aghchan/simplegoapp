import { execFile, spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { startFakeGitHub } from "./fake-github.ts";
import { BASE_URL_ENV, GITHUB_URL_ENV, OWNER, REPO, SESSION_SECRET, WEBHOOK_SECRET } from "./stack.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const WRANGLER = path.join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const LOG = path.join(os.tmpdir(), "basetobase-e2e-wrangler.log");
const READY_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 10_000;

// `wrangler dev` on a fresh local D1/KV/DO state, its GitHub a fake one in this process. The
// returned function is the teardown.
export default async function globalSetup(): Promise<() => Promise<void>> {
  const github = await startFakeGitHub();
  const state = await mkdtemp(path.join(os.tmpdir(), "basetobase-e2e-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  // In .dev.vars format; passed with --env-file so that a developer's own .dev.vars is left alone.
  const vars = path.join(state, "e2e.dev.vars");
  await writeFile(
    vars,
    devVars({
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: appKey(),
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GITHUB_OAUTH_CLIENT_ID: "e2e-oauth-client",
      GITHUB_OAUTH_CLIENT_SECRET: "e2e-oauth-secret",
      SESSION_SECRET,
      OWNER_LOGIN: OWNER,
      REPO,
      PUBLIC_URL: baseUrl,
      GITHUB_API: github.url,
    }),
  );
  // No metrics, and the placeholder `request.cf` rather than one fetched from Cloudflare.
  const env = {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_CF_FETCH_ENABLED: "false",
  };
  const persist = ["--persist-to", state];
  await promisify(execFile)(
    process.execPath,
    [WRANGLER, "d1", "migrations", "apply", "basetobase", "--local", ...persist],
    { cwd: ROOT, env },
  );

  const dev = spawn(
    process.execPath,
    [
      WRANGLER,
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(await freePort()),
      "--env-file",
      vars,
      "--show-interactive-dev-session=false",
      ...persist,
    ],
    // Its own process group, so that teardown also stops the workerd it starts.
    { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const log = createWriteStream(LOG);
  dev.stdout?.pipe(log);
  dev.stderr?.pipe(log);

  try {
    await serving(baseUrl, dev);
  } catch (error) {
    await stop(dev);
    await github.close();
    throw new Error(`${(error as Error).message}\n${await readFile(LOG, "utf8")}`);
  }
  process.env[BASE_URL_ENV] = baseUrl;
  process.env[GITHUB_URL_ENV] = github.url;
  console.log(`e2e: wrangler dev at ${baseUrl}, log in ${LOG}`);

  return async () => {
    await stop(dev);
    await github.close();
    await rm(state, { recursive: true, force: true });
  };
}

function appKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return privateKey;
}

// Double quotes keep a PEM's newlines as `\n` escapes, which the parser turns back into newlines.
function devVars(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}="${value.replaceAll("\n", "\\n")}"\n`)
    .join("");
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// The Worker is up once an unauthenticated API call gets its 401.
async function serving(baseUrl: string, dev: ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (dev.exitCode !== null) throw new Error(`wrangler dev exited with ${dev.exitCode}`);
    const status = await fetch(`${baseUrl}/api/me`).then(
      (res) => res.status,
      () => 0,
    );
    if (status === 401) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`wrangler dev did not answer at ${baseUrl} within ${READY_TIMEOUT_MS} ms`);
}

async function stop(dev: ChildProcess): Promise<void> {
  if (dev.pid === undefined || dev.exitCode !== null) return;
  const exited = new Promise((resolve) => dev.once("exit", resolve));
  process.kill(-dev.pid, "SIGTERM");
  const timer = setTimeout(() => process.kill(-dev.pid!, "SIGKILL"), STOP_TIMEOUT_MS);
  await exited;
  clearTimeout(timer);
}
