import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createLocalJWKSet } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../shared/src/config.ts";
import { createApp } from "../src/index.ts";
import { listRuns, runStub } from "../src/runs/index.ts";
import { prPayload, sign, stubGitHub } from "./helpers.ts";

const app = createApp({ agentKey: createLocalJWKSet({ keys: [] }) });
const FILES_PATH = "GET /repos/aghchan/simplegoapp/pulls/58/files";
const DISPATCH_PATH =
  "POST /repos/aghchan/simplegoapp/actions/workflows/basetobase-agent.yml/dispatches";
const CHECKS_PATH = "POST /repos/aghchan/simplegoapp/check-runs";
const docsOnly = () =>
  Response.json([{ filename: "docs/BEST_PRACTICES.md", additions: 1, deletions: 1 }]);
const PKCS1_KEY = "-----BEGIN RSA PRIVATE KEY-----\nQUJD\n-----END RSA PRIVATE KEY-----\n";

let dispatches: Record<string, string>[];
let errors: ReturnType<typeof vi.spyOn>;

interface Delivery {
  event?: string;
  signature?: string | null;
  workerEnv?: Env;
}

async function deliverRaw(body: string, delivery: Delivery = {}): Promise<Response> {
  const headers = new Headers({ "X-GitHub-Event": delivery.event ?? "pull_request" });
  const signature =
    delivery.signature === undefined
      ? await sign(env.GITHUB_WEBHOOK_SECRET, body)
      : delivery.signature;
  if (signature !== null) headers.set("X-Hub-Signature-256", signature);
  const req = new Request("https://b2b.test/github/webhook", { method: "POST", headers, body });
  return app.fetch(req, delivery.workerEnv ?? env, createExecutionContext());
}

const deliver = (payload: unknown, delivery?: Delivery) =>
  deliverRaw(JSON.stringify(payload), delivery);

const opened = () => prPayload();
const readyForReview = () => prPayload({ action: "ready_for_review" });
const closed = () => prPayload({ action: "closed" });

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM runs").run();
  dispatches = stubGitHub({ [FILES_PATH]: docsOnly });
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /github/webhook", () => {
  describe("authentication", () => {
    it("401 on bad signature", async () => {
      const res = await deliver(opened(), { signature: `sha256=${"0".repeat(64)}` });
      expect(res.status).toBe(401);
      expect(await listRuns(env.DB)).toEqual([]);
      expect(dispatches).toEqual([]);
    });

    it("401 without a signature", async () => {
      expect((await deliver(opened(), { signature: null })).status).toBe(401);
      expect(await listRuns(env.DB)).toEqual([]);
    });

    it("401 for a signature made with another secret", async () => {
      const signature = await sign("another-secret", JSON.stringify(opened()));
      expect((await deliver(opened(), { signature })).status).toBe(401);
    });

    it("401 for a signature over another body", async () => {
      const signature = await sign(env.GITHUB_WEBHOOK_SECRET, JSON.stringify(readyForReview()));
      expect((await deliver(opened(), { signature })).status).toBe(401);
      expect(await listRuns(env.DB)).toEqual([]);
    });

    it("checks the signature before reading the JSON", async () => {
      const res = await deliverRaw("{not json", { signature: `sha256=${"0".repeat(64)}` });
      expect(res.status).toBe(401);
    });

    it("400 on JSON that does not parse, once the signature is good", async () => {
      expect((await deliverRaw("{not json")).status).toBe(400);
    });
  });

  describe("size limit", () => {
    it("413 over 1 MiB, however well it is signed", async () => {
      const res = await deliverRaw(`"${"x".repeat(1024 * 1024)}"`);
      expect(res.status).toBe(413);
    });

    it("reads a body of exactly 1 MiB", async () => {
      const res = await deliverRaw(`"${"x".repeat(1024 * 1024 - 2)}"`, { event: "ping" });
      expect(res.status).toBe(200);
    });
  });

  describe("start", () => {
    it("starts a run for an owner PR", async () => {
      const res = await deliver(opened());
      expect(res.status).toBe(202);
      const { runId } = (await res.json()) as { runId: string };
      expect((await listRuns(env.DB))[0]).toMatchObject({
        id: runId,
        prNumber: 58,
        rating: "green",
        runName: "Easy Slider",
        status: "on_the_hill",
      });
      expect(dispatches).toMatchObject([{ run_id: runId, sha: "head58" }]);
    });

    it("rates the run on the files GitHub lists", async () => {
      dispatches = stubGitHub({
        [FILES_PATH]: () => Response.json([{ filename: "Makefile", additions: 3, deletions: 0 }]),
      });
      await deliver(opened());
      expect((await listRuns(env.DB))[0]).toMatchObject({ rating: "double_black" });
    });

    it("names a second concurrent run of the same rating differently", async () => {
      await deliver(opened());
      const other = prPayload();
      (other.pull_request as { number: number }).number = 59;
      dispatches = stubGitHub({ "GET /repos/aghchan/simplegoapp/pulls/59/files": docsOnly });
      await deliver(other);
      const names = (await listRuns(env.DB)).map((run) => run.runName).sort();
      expect(names).toEqual(["Easy Slider", "Ramp Run"]);
    });

    it("ignores a second start for the same PR head", async () => {
      await deliver(opened());
      const res = await deliver(readyForReview());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ignored: "duplicate" });
      expect(await listRuns(env.DB)).toHaveLength(1);
      expect(dispatches).toHaveLength(1);
    });

    it("ignores a redelivery of the same event", async () => {
      await deliver(opened());
      expect(await (await deliver(opened())).json()).toEqual({ ignored: "duplicate" });
      expect(await listRuns(env.DB)).toHaveLength(1);
    });

    describe("a push", () => {
      const NEW_HEAD = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
      const pushed = (sha: string) => {
        const payload = prPayload({ action: "synchronize" });
        (payload.pull_request as { head: { sha: string } }).head.sha = sha;
        return payload;
      };

      it("stops the PR's run and starts a fresh sweep on the new head", async () => {
        const first = ((await (await deliver(opened())).json()) as { runId: string }).runId;
        const res = await deliver(pushed(NEW_HEAD));
        expect(res.status).toBe(202);
        const { runId } = (await res.json()) as { runId: string };
        const runs = await listRuns(env.DB);
        expect(Object.fromEntries(runs.map((run) => [run.id, run.status]))).toEqual({
          [first]: "stopped",
          [runId]: "on_the_hill",
        });
        expect((await runStub(env, first).view())!.log.map((line) => line.text)).toContain(
          "stopped · superseded by 9f8e7d6",
        );
        expect(dispatches).toMatchObject([{ sha: "head58" }, { sha: NEW_HEAD }]);
      });

      it("to a head that already has a run is ignored, leaving the run alone", async () => {
        await deliver(opened());
        const res = await deliver(pushed("head58"));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ignored: "duplicate" });
        expect(await listRuns(env.DB)).toMatchObject([{ status: "on_the_hill" }]);
        expect(dispatches).toHaveLength(1);
      });
    });

    it("starts a new run when the PR is reopened after its run was stopped", async () => {
      await deliver(opened());
      await deliver(closed());
      expect((await deliver(prPayload({ action: "reopened" }))).status).toBe(202);
      expect((await listRuns(env.DB)).map((run) => run.status).sort()).toEqual([
        "on_the_hill",
        "stopped",
      ]);
    });
  });

  // Spec §8: until Base to Base can deploy itself, changes to it are not patrolled.
  describe("Base to Base's own files", () => {
    const listing =
      (...files: Record<string, unknown>[]) =>
      () =>
        Response.json(files.map((file) => ({ additions: 1, deletions: 1, ...file })));
    const docs = { filename: "docs/BEST_PRACTICES.md" };

    it.each([
      "basetobase/dispatch/src/run/machine.ts",
      ".basetobase/patrol/mainline.md",
      ".github/workflows/basetobase-agent.yml",
      "BaseToBase/CLAUDE.md",
    ])("ignores a PR touching %s, starting no run", async (filename) => {
      dispatches = stubGitHub({ [FILES_PATH]: listing(docs, { filename }) });
      const res = await deliver(opened());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ignored: "unpatrolled" });
      expect(await listRuns(env.DB)).toEqual([]);
      expect(dispatches).toEqual([]);
    });

    it("ignores a PR that renames a file out of basetobase/", async () => {
      const renamed = {
        filename: "tools/machine.ts",
        previous_filename: "basetobase/dispatch/src/run/machine.ts",
        status: "renamed",
      };
      dispatches = stubGitHub({ [FILES_PATH]: listing(renamed) });
      expect(await (await deliver(opened())).json()).toEqual({ ignored: "unpatrolled" });
      expect(await listRuns(env.DB)).toEqual([]);
    });

    // Neutral passes a required check, so branch protection lets such a PR merge.
    it("posts one neutral check on the head, naming the unpatrolled globs", async () => {
      const posted: Record<string, unknown>[] = [];
      dispatches = stubGitHub({
        [FILES_PATH]: listing(docs, { filename: "basetobase/CLAUDE.md" }),
        [CHECKS_PATH]: async (req) => {
          posted.push(await req.json());
          return Response.json({ id: 9 }, { status: 201 });
        },
      });
      expect(await (await deliver(opened())).json()).toEqual({ ignored: "unpatrolled" });
      expect(posted).toEqual([
        {
          name: "Base to Base",
          head_sha: "head58",
          status: "completed",
          conclusion: "neutral",
          output: { title: "Not patrolled until M5", summary: expect.any(String) },
        },
      ]);
      const { summary } = posted[0]!.output as { summary: string };
      for (const glob of config.unpatrolledGlobs) expect(summary).toContain(`\`${glob}\``);
    });

    it("502 when the neutral check cannot be posted", async () => {
      dispatches = stubGitHub({
        [FILES_PATH]: listing({ filename: "basetobase/CLAUDE.md" }),
        [CHECKS_PATH]: () => new Response("secret body", { status: 500 }),
      });
      const res = await deliver(opened());
      expect(res.status).toBe(502);
      expect(await res.text()).not.toContain("secret body");
      expect(errors).toHaveBeenCalledOnce();
      expect(String(errors.mock.calls[0]![0])).toContain("failed with status 500");
      expect(await listRuns(env.DB)).toEqual([]);
    });

    it.each([".github/workflows/ci.yml", "docs/basetobase/notes.md", "basetobase.md"])(
      "patrols a PR touching %s",
      async (filename) => {
        dispatches = stubGitHub({ [FILES_PATH]: listing({ filename }) });
        expect((await deliver(opened())).status).toBe(202);
        expect(dispatches).toHaveLength(1);
      },
    );
  });

  describe("ignored deliveries", () => {
    it.each([
      ["an event that is not a pull request", "ping", opened(), "event"],
      ["a fork", "pull_request", prPayload({ headRepo: "eve/simplegoapp" }), "fork"],
      ["another author", "pull_request", prPayload({ author: "eve" }), "author"],
      ["a draft", "pull_request", prPayload({ draft: true }), "draft"],
      ["another repository", "pull_request", prPayload({ repo: "eve/simplegoapp" }), "repo"],
      [
        "an action that does not start a run",
        "pull_request",
        prPayload({ action: "edited" }),
        "action",
      ],
    ])("200 ignored for %s", async (_name, event, payload, reason) => {
      const res = await deliver(payload, { event });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ignored: reason });
      expect(await listRuns(env.DB)).toEqual([]);
      expect(dispatches).toEqual([]);
    });
  });

  describe("stop", () => {
    it("closed stops the run", async () => {
      await deliver(opened());
      const res = await deliver(closed());
      expect(res.status).toBe(200);
      expect((await listRuns(env.DB))[0]!.status).toBe("stopped");
      const { id } = (await listRuns(env.DB))[0]!;
      expect(await res.json()).toEqual({ stopped: [id] });
      expect((await runStub(env, id).view())!.log.map((line) => line.text)).toContain(
        "stopped · PR closed",
      );
    });

    it("stops a run whose first dispatch is still with GitHub", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let dispatching = false;
      stubGitHub({
        [FILES_PATH]: docsOnly,
        [DISPATCH_PATH]: async () => {
          dispatching = true;
          await held;
          return new Response(null, { status: 204 });
        },
      });
      const opening = deliver(opened());
      await vi.waitFor(() => expect(dispatching).toBe(true));
      const res = await deliver(closed());
      release();
      const { runId } = (await (await opening).json()) as { runId: string };
      expect(await res.json()).toEqual({ stopped: [runId] });
      expect(await listRuns(env.DB)).toMatchObject([{ id: runId, status: "stopped" }]);
    });

    it("stops nothing for a PR with no active run", async () => {
      const res = await deliver(closed());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ stopped: [] });
    });

    it("a close in another repository leaves our run alone", async () => {
      await deliver(opened());
      const res = await deliver(prPayload({ action: "closed", repo: "eve/simplegoapp" }));
      expect(await res.json()).toEqual({ stopped: [] });
      expect((await listRuns(env.DB))[0]!.status).toBe("on_the_hill");
    });

    it("a close for another PR leaves our run alone", async () => {
      await deliver(opened());
      const other = prPayload({ action: "closed" });
      (other.pull_request as { number: number }).number = 59;
      await deliver(other);
      expect((await listRuns(env.DB))[0]!.status).toBe("on_the_hill");
    });
  });

  describe("when GitHub cannot be reached", () => {
    it("502 without a run when the files cannot be listed", async () => {
      dispatches = stubGitHub({ [FILES_PATH]: () => new Response("secret body", { status: 500 }) });
      const res = await deliver(opened());
      expect(res.status).toBe(502);
      expect(await listRuns(env.DB)).toEqual([]);
      expect(dispatches).toEqual([]);
      const text = await res.text();
      expect(text).not.toContain("secret body");
      expect(errors).toHaveBeenCalledOnce();
    });

    it("502 without a run when the app key cannot be used", async () => {
      const workerEnv = { ...env, GITHUB_APP_PRIVATE_KEY: PKCS1_KEY } satisfies Env;
      const res = await deliver(opened(), { workerEnv });
      expect(res.status).toBe(502);
      expect(await listRuns(env.DB)).toEqual([]);
      expect(await res.text()).not.toContain("PRIVATE KEY");
      expect(errors).toHaveBeenCalledOnce();
    });

    it("logs no secret", async () => {
      dispatches = stubGitHub({ [FILES_PATH]: () => new Response("nope", { status: 500 }) });
      await deliver(opened());
      const logged = JSON.stringify(errors.mock.calls);
      for (const secret of [env.GITHUB_APP_PRIVATE_KEY, env.GITHUB_WEBHOOK_SECRET]) {
        expect(logged).not.toContain(secret);
      }
      expect(logged).not.toContain("installation-token");
    });
  });
});

describe("unknown routes", () => {
  it.each([
    ["GET", "/"],
    ["GET", "/nope"],
    ["GET", "/github/webhook"],
    ["POST", "/github/other"],
  ])("404 JSON for %s %s", async (method, path) => {
    const res = await app.fetch(
      new Request(`https://b2b.test${path}`, { method }),
      env,
      createExecutionContext(),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
