// `node scripts/src/wrangler.ts <wrangler args…>`: runs wrangler, and when it fails because its
// login expired, runs `wrangler login` and retries once. A CLOUDFLARE_API_TOKEN never expires, so
// with one set, a failure is passed through as is.
import { spawn } from "node:child_process";
import { isAuthFailure } from "./wrangler-lib.ts";

function wrangler(args: string[], capture: boolean): Promise<{ status: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", ...args], {
      stdio: ["inherit", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status: status ?? 1, output }));
  });
}

const args = process.argv.slice(2);
const first = await wrangler(args, true);
if (first.status !== 0 && !process.env.CLOUDFLARE_API_TOKEN && isAuthFailure(first.output)) {
  console.error("\nCloudflare login expired. Signing in again, then retrying.");
  const login = await wrangler(["login"], false);
  if (login.status !== 0) process.exit(login.status);
  process.exit((await wrangler(args, false)).status);
}
process.exit(first.status);
