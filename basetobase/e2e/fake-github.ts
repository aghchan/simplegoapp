import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeGitHub {
  url: string;
  close(): Promise<void>;
}

type Answer = { status: number; body?: (match: RegExpMatchArray) => unknown };

// A check-run call Dispatch made: the create's body, or an update's id and body.
export interface CheckCall {
  method: "POST" | "PATCH";
  id: number;
  body: Record<string, unknown>;
}

// What Dispatch asks of GitHub, for any installation, repository and pull request. Every PR changes
// one backend file outside unpatrolledGlobs, and PR n's head is always `e2e-head-<n>`, as the tests
// send it.
const ROUTES: [RegExp, Answer][] = [
  [
    /^POST \/app\/installations\/\d+\/access_tokens$/,
    {
      status: 201,
      body: () => ({
        token: "e2e-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    },
  ],
  [
    /^GET \/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files$/,
    { status: 200, body: () => [{ filename: "orders/cancel.go", additions: 120, deletions: 10 }] },
  ],
  [/^POST \/repos\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+\/dispatches$/, { status: 204 }],
  [
    /^GET \/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/,
    { status: 200, body: (m) => ({ number: Number(m[1]), state: "open", head: { sha: `e2e-head-${m[1]}` } }) },
  ],
  [/^POST \/repos\/[^/]+\/[^/]+\/check-runs$/, { status: 201, body: () => ({ id: nextCheckId++ }) }],
  [/^PATCH \/repos\/[^/]+\/[^/]+\/check-runs\/(\d+)$/, { status: 200, body: (m) => ({ id: Number(m[1]) }) }],
];
let nextCheckId = 1;

export async function startFakeGitHub(): Promise<FakeGitHub> {
  const checks: CheckCall[] = [];
  const server = createServer((req, res) => {
    const route = `${req.method} ${new URL(req.url ?? "/", "http://github.test").pathname}`;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (route === "GET /__checks") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(checks));
        return;
      }
      const found = ROUTES.map(([pattern, answer]) => [route.match(pattern), answer] as const).find(
        ([match]) => match !== null,
      );
      if (!found) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      const [match, answer] = found;
      const checkRun = /^(POST|PATCH) \/repos\/[^/]+\/[^/]+\/check-runs(?:\/(\d+))?$/.exec(route);
      if (!answer.body) {
        res.writeHead(answer.status);
        res.end();
        return;
      }
      const reply = answer.body(match!);
      if (checkRun) {
        checks.push({
          method: checkRun[1] as "POST" | "PATCH",
          id: (reply as { id: number }).id,
          body: JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>,
        });
      }
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
