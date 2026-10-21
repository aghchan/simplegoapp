import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeGitHub {
  url: string;
  close(): Promise<void>;
}

type Answer = { status: number; body?: () => unknown };

// What Dispatch asks of GitHub, for any installation, repository and pull request. Every PR changes
// one backend file outside unpatrolledGlobs.
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
];

export async function startFakeGitHub(): Promise<FakeGitHub> {
  const server = createServer((req, res) => {
    const route = `${req.method} ${new URL(req.url ?? "/", "http://github.test").pathname}`;
    req.resume();
    req.on("end", () => {
      const answer = ROUTES.find(([pattern]) => pattern.test(route))?.[1];
      if (!answer) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      if (!answer.body) {
        res.writeHead(answer.status);
        res.end();
        return;
      }
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer.body()));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
