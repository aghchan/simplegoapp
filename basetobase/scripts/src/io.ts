// What the owner's tools share: child processes, prompts and the browser. Side effects, so only the
// entry files (setup.ts, setup-deploy.ts) import it; their pure logic lives in setup-lib.ts.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { tokenFrom } from "./setup-lib.ts";

// basetobase/, where npm, wrangler and the config live.
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PASTE_SETTLE_MS = 300;

export class CommandError extends Error {
  readonly output: string;

  constructor(message: string, output: string) {
    super(message);
    this.output = output;
  }
}

export function sh(
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

export async function has(cmd: string, args: string[]): Promise<boolean> {
  try {
    await sh(cmd, args, { capture: true });
    return true;
  } catch {
    return false;
  }
}

export function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`${question} `);
  } finally {
    rl.close();
  }
}

export async function yes(question: string): Promise<boolean> {
  return /^y/i.test(await ask(`${question} [y/N]`));
}

// Reads input without echoing it, so the token never shows on screen or in scrollback. A token
// copied from a wrapped terminal line arrives with line breaks inside one paste, so Enter only ends
// the input once nothing more arrives for PASTE_SETTLE_MS; whitespace is dropped (tokens have none).
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = "";
    let settle: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(tokenFrom(value));
    };
    const onData = (chunk: string) => {
      clearTimeout(settle);
      for (const c of chunk) {
        if (c === "\u0003") process.exit(130);
        if (c === "\u007f") value = value.slice(0, -1);
        else value += c;
      }
      if (/[\r\n]$/.test(value)) settle = setTimeout(done, PASTE_SETTLE_MS);
    };
    stdin.setRawMode?.(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

export function step(name: string): void {
  console.log(`\n== ${name}`);
}
