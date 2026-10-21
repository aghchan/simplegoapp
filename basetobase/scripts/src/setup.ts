// One-time owner setup (plan M1 Task 13 Step 1), run on the owner's machine: `npm run setup`.
// Rerunnable: each step skips what already exists.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  appManifest,
  d1Id,
  D1_NAME,
  kvId,
  KV_BINDING,
  KV_TITLE,
  manifestPage,
  publicUrlOf,
  REPO,
  withDatabaseId,
  withKvId,
  withPublicUrl,
  workerSecrets,
  workersDevUrl,
  type AppConversion,
} from "./setup-lib.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONFIG = `${ROOT}wrangler.jsonc`;

async function main(): Promise<void> {
  step("Cloudflare login");
  const whoami = await sh("npx", ["wrangler", "whoami"], { capture: true });
  if (/not authenticated/i.test(whoami)) await sh("npx", ["wrangler", "login"]);

  step("D1 database");
  let dbId = d1Id(await sh("npx", ["wrangler", "d1", "list", "--json"], { capture: true }), D1_NAME);
  if (!dbId) {
    await sh("npx", ["wrangler", "d1", "create", D1_NAME, "--no-update-config"]);
    dbId = d1Id(await sh("npx", ["wrangler", "d1", "list", "--json"], { capture: true }), D1_NAME);
  }
  if (!dbId) throw new Error(`no D1 database named ${D1_NAME} after creating it`);

  step("KV namespace");
  const listKv = () => sh("npx", ["wrangler", "kv", "namespace", "list"], { capture: true });
  let kv = kvId(await listKv(), KV_TITLE);
  if (!kv) {
    await sh("npx", ["wrangler", "kv", "namespace", "create", KV_TITLE, "--no-update-config"]);
    kv = kvId(await listKv(), KV_TITLE);
  }
  if (!kv) throw new Error(`no KV namespace titled ${KV_TITLE} after creating it`);
  await writeFile(CONFIG, withKvId(withDatabaseId(await readFile(CONFIG, "utf8"), dbId), KV_BINDING, kv));

  step("Migrations");
  await sh("npx", ["wrangler", "d1", "migrations", "apply", D1_NAME, "--remote"]);

  step("Deploy");
  const url = workersDevUrl(await deploy());
  if (!url) {
    throw new Error(
      "deploy printed no workers.dev URL: register a workers.dev subdomain " +
        "(Cloudflare dashboard → Workers & Pages), then rerun",
    );
  }
  if (publicUrlOf(await readFile(CONFIG, "utf8")) !== url) {
    await writeFile(CONFIG, withPublicUrl(await readFile(CONFIG, "utf8"), url));
    await sh("npm", ["run", "deploy"]);
  }

  step("GitHub App");
  const secrets = await sh("npx", ["wrangler", "secret", "list"], { capture: true });
  if (!secrets.includes("GITHUB_APP_ID") || (await yes("App secrets exist. Create a new App?"))) {
    const app = await createApp(url);
    // One request, values on stdin: nothing touches disk or argv.
    const bulk = JSON.stringify(Object.fromEntries(workerSecrets(app)));
    await sh("npx", ["wrangler", "secret", "bulk"], { input: bulk });
    const install = `${app.html_url}/installations/new`;
    console.log(`Install it on ${REPO} only: ${install}`);
    openBrowser(install);
    await ask("Press Enter once it is installed.");
  }

  step("Repo secret and variable");
  if (await has("gh", ["auth", "status"])) {
    await sh("gh", ["variable", "set", "BASETOBASE_URL", "--repo", REPO, "--body", url]);
    const repoSecrets = await sh("gh", ["secret", "list", "--repo", REPO], { capture: true });
    if (!repoSecrets.includes("CLAUDE_CODE_OAUTH_TOKEN") || (await yes("Claude token is set. Replace it?"))) {
      console.log("Run `claude setup-token` in another terminal.");
      const token = await askHidden("Paste the token (hidden): ");
      await sh("gh", ["secret", "set", "CLAUDE_CODE_OAUTH_TOKEN", "--repo", REPO], { input: token });
    }
  } else {
    console.log(`gh is not signed in. At https://github.com/${REPO}/settings/secrets/actions:`);
    console.log("- secret CLAUDE_CODE_OAUTH_TOKEN = the output of `claude setup-token`");
    console.log(`- variable BASETOBASE_URL = ${url}`);
  }

  step("Check");
  const status = await fetch(`${url}/api/runs`).then(
    (res) => String(res.status),
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  console.log(status === "401" ? "Signed-out access refused: OK" : `Expected 401 from /api/runs, got ${status}`);
  console.log(`Dashboard: ${url}`);
  console.log("Commit basetobase/wrangler.jsonc (ids and URL; no secrets).");
}

// Captured output makes wrangler non-interactive, so it won't offer to register a workers.dev
// subdomain. An uncaptured deploy lets it ask; the captured one then finds the URL.
async function deploy(): Promise<string> {
  const captured = () => sh("npm", ["run", "deploy"], { capture: true, echo: true, teeStderr: true });
  try {
    return await captured();
  } catch (error) {
    const output = error instanceof CommandError ? error.output : "";
    if (!/register a workers\.dev subdomain/.test(output)) throw error;
    console.log("\nNo workers.dev subdomain yet. Answer y and pick one.");
    await sh("npx", ["wrangler", "deploy"]);
    return captured();
  }
}

class CommandError extends Error {
  readonly output: string;

  constructor(message: string, output: string) {
    super(message);
    this.output = output;
  }
}

// Serves the manifest form on localhost, waits for GitHub's redirect, and trades its code for the App.
async function createApp(publicUrl: string): Promise<AppConversion> {
  const state = randomBytes(16).toString("hex");
  let redirect = "";
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const at = new URL(req.url ?? "/", "http://127.0.0.1");
      if (at.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(manifestPage(appManifest(publicUrl, redirect), state));
        return;
      }
      const given = at.searchParams.get("code");
      if (at.pathname !== "/callback" || at.searchParams.get("state") !== state || !given) {
        res.writeHead(400).end("Unexpected request");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" }).end("Done. Return to the terminal.");
      server.close();
      resolve(given);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      redirect = `http://127.0.0.1:${port}/callback`;
      console.log(`Open http://127.0.0.1:${port}/ and click "Create GitHub App".`);
      openBrowser(`http://127.0.0.1:${port}/`);
    });
  });
  const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub refused the manifest code: ${res.status}`);
  return (await res.json()) as AppConversion;
}

function sh(
  cmd: string,
  args: string[],
  o: { input?: string; capture?: boolean; echo?: boolean; teeStderr?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: [
        o.input === undefined ? "inherit" : "pipe",
        o.capture ? "pipe" : "inherit",
        o.teeStderr ? "pipe" : "inherit",
      ],
    });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (o.echo) process.stdout.write(chunk);
    });
    // JSON-listing commands keep stderr out of `out`: wrangler's warnings would break the parse.
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      process.stderr.write(chunk);
    });
    if (o.input !== undefined) child.stdin?.end(o.input);
    child.on("error", reject);
    child.on("close", (status) =>
      status === 0 ? resolve(out) : reject(new CommandError(`${cmd} ${args.join(" ")} exited ${status}`, out)),
    );
  });
}

async function has(cmd: string, args: string[]): Promise<boolean> {
  try {
    await sh(cmd, args, { capture: true });
    return true;
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`${question} `);
  } finally {
    rl.close();
  }
}

async function yes(question: string): Promise<boolean> {
  return /^y/i.test(await ask(`${question} [y/N]`));
}

// Reads a line without echoing it, so the token never shows on screen or in scrollback.
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = "";
    stdin.setRawMode?.(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\u0003") process.exit(130);
        if (c === "\r" || c === "\n") {
          stdin.off("data", onData);
          stdin.setRawMode?.(false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        value = c === "\u007f" ? value.slice(0, -1) : value + c;
      }
    };
    stdin.on("data", onData);
  });
}

function step(name: string): void {
  console.log(`\n== ${name}`);
}

main().catch((error: unknown) => {
  console.error(`\nSetup stopped: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix that and rerun `npm run setup`; finished steps are skipped.");
  process.exit(1);
});
