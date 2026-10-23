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
const CHECK_PATH = "PATCH /repos/aghchan/simplegoapp/check-runs/1";
const PULL_PATH = "GET /repos/aghchan/simplegoapp/pulls/58";
const NEW_HEAD = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
const NEWER_HEAD = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const MERGE_SHA = "4d3c2b1a0987654329f8e7d6c5b4a39281706f5e";
const docsOnly = () =>
  Response.json([{ filename: "docs/BEST_PRACTICES.md", additions: 1, deletions: 1 }]);
const PKCS1_KEY = "-----BEGIN RSA PRIVATE KEY-----\nQUJD\n-----END RSA PRIVATE KEY-----\n";

let dispatches: Record<string, string>[];
let errors: ReturnType<typeof vi.spyOn>;

// PR 58 as GitHub has it when Dispatch reads it. A test changes it as the owner would.
interface Live {
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  title: string;
  head: string;
  base: string;
}
let live: Live;

const pullReply = () =>
  Response.json({
    number: 58,
    state: live.state,
    draft: live.draft,
    merged: live.merged,
    merge_commit_sha: live.merged ? MERGE_SHA : "testmerge58",
    title: live.title,
    head: { sha: live.head },
    base: { ref: live.base, repo: { default_branch: "main" } },
  });

// GitHub as every test starts with it, `routes` added or replaced.
const github = (routes: Parameters<typeof stubGitHub>[0] = {}) =>
  stubGitHub({ [FILES_PATH]: docsOnly, [PULL_PATH]: pullReply, ...routes });

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
const pushed = (sha: string, over: Record<string, unknown> = {}) => {
  const payload = prPayload({ action: "synchronize", ...over });
  (payload.pull_request as { head: { sha: string } }).head.sha = sha;
  return payload;
};
const edited = (changes: Record<string, unknown>): Record<string, unknown> => ({
  ...prPayload({ action: "edited" }),
  changes,
});

// Delivers a start that must start a run, and returns the run's id.
async function start(payload: unknown = opened()): Promise<string> {
  const res = await deliver(payload);
  expect(res.status).toBe(202);
  return ((await res.json()) as { runId: string }).runId;
}

const statuses = async () =>
  Object.fromEntries((await listRuns(env.DB)).map((run) => [run.id, run.status]));
const logOf = async (runId: string) =>
  (await runStub(env, runId).view())!.log.map((line) => line.text);

// Fails every agent the run dispatched, which ends its sweep: swept, with outcome failed.
async function sweep(runId: string): Promise<void> {
  for (const inputs of dispatches.filter((dispatched) => dispatched.run_id === runId)) {
    const report = await runStub(env, runId).failure(inputs.agent_id!, inputs.nonce!, "boom");
    expect(report).toBe("accepted");
  }
  expect(await statuses()).toMatchObject({ [runId]: "swept" });
}

// A promise that settles once opened.
function gate() {
  let open!: () => void;
  const shut = new Promise<void>((resolve) => (open = resolve));
  return { shut, open };
}

// Holds the first file listing until released, as a slow GitHub would.
function holdFirstListing() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let listings = 0;
  dispatches = github({
    [FILES_PATH]: async () => {
      if (++listings === 1) await held;
      return docsOnly();
    },
  });
  return { release, listed: () => listings };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM runs").run();
  live = {
    state: "open",
    draft: false,
    merged: false,
    title: "orders: add cancel endpoint",
    head: "head58",
    base: "main",
  };
  dispatches = github();
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
      dispatches = github({
        [FILES_PATH]: () => Response.json([{ filename: "Makefile", additions: 3, deletions: 0 }]),
      });
      await deliver(opened());
      expect((await listRuns(env.DB))[0]).toMatchObject({ rating: "double_black" });
    });

    it("names a second concurrent run of the same rating differently", async () => {
      await deliver(opened());
      const other = prPayload();
      (other.pull_request as { number: number }).number = 59;
      dispatches = github({
        "GET /repos/aghchan/simplegoapp/pulls/59": pullReply,
        "GET /repos/aghchan/simplegoapp/pulls/59/files": docsOnly,
      });
      await deliver(other);
      const names = (await listRuns(env.DB)).map((run) => run.runName).sort();
      expect(names).toEqual(["Easy Slider", "Ramp Run"]);
    });

    // The names only keep runs apart, so the run starts all the same.
    it("starts the run when the names of the runs on the hill cannot be read", async () => {
      const db = {
        prepare(sql: string) {
          if (sql.startsWith("SELECT run_name AS runName")) throw new Error("D1 unreachable");
          return env.DB.prepare(sql);
        },
      } as unknown as D1Database;
      expect((await deliver(opened(), { workerEnv: { ...env, DB: db } })).status).toBe(202);
      expect(await listRuns(env.DB)).toMatchObject([{ status: "on_the_hill" }]);
      expect(errors).toHaveBeenCalledOnce();
    });

    it("takes the PR's title as GitHub has it now", async () => {
      live.title = "orders: cancel a pending order";
      await start();
      expect(await listRuns(env.DB)).toMatchObject([{ prTitle: "orders: cancel a pending order" }]);
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

    it("ignores a start on the head of a swept run", async () => {
      const runId = await start();
      await sweep(runId);
      expect(await (await deliver(readyForReview())).json()).toEqual({ ignored: "duplicate" });
      expect(await listRuns(env.DB)).toHaveLength(1);
    });

    // GitHub may deliver an event long after the PR closed, or redeliver one on request.
    it.each([
      ["closed", { state: "closed" }],
      ["merged", { state: "closed", merged: true }],
    ] as const)("starts nothing for a PR GitHub shows %s", async (_label, over) => {
      Object.assign(live, over);
      const res = await deliver(opened());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ignored: "stale" });
      expect(await listRuns(env.DB)).toEqual([]);
      expect(dispatches).toEqual([]);
    });

    it("starts a new run when the PR is reopened after its run was stopped", async () => {
      await deliver(opened());
      live.state = "closed";
      await deliver(closed());
      live.state = "open";
      expect((await deliver(prPayload({ action: "reopened" }))).status).toBe(202);
      expect((await listRuns(env.DB)).map((run) => run.status).sort()).toEqual([
        "on_the_hill",
        "stopped",
      ]);
    });

    describe("a push", () => {
      it("stops the PR's run and starts a fresh sweep on the new head", async () => {
        const first = await start();
        live.head = NEW_HEAD;
        const runId = await start(pushed(NEW_HEAD));
        expect(await statuses()).toEqual({ [first]: "stopped", [runId]: "on_the_hill" });
        expect(await logOf(first)).toContain("stopped · superseded by 9f8e7d6");
        expect(dispatches).toMatchObject([{ sha: "head58" }, { sha: NEW_HEAD }]);
      });

      // The old head's hazards or failure no longer speak for the PR.
      it("supersedes a run whose sweep has finished", async () => {
        const first = await start();
        await sweep(first);
        live.head = NEW_HEAD;
        const runId = await start(pushed(NEW_HEAD));
        expect(await statuses()).toEqual({ [first]: "stopped", [runId]: "on_the_hill" });
        expect(await logOf(first)).toContain("stopped · superseded by 9f8e7d6");
      });

      it("to a head that already has a run is ignored, leaving the run alone", async () => {
        await deliver(opened());
        const res = await deliver(pushed("head58"));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ignored: "duplicate" });
        expect(await listRuns(env.DB)).toMatchObject([{ status: "on_the_hill" }]);
        expect(dispatches).toHaveLength(1);
      });

      it("delivered after a newer one starts nothing and stops nothing", async () => {
        await deliver(opened());
        live.head = NEWER_HEAD;
        const newer = await start(pushed(NEWER_HEAD));
        const before = await listRuns(env.DB);

        const res = await deliver(pushed(NEW_HEAD));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ignored: "stale" });
        expect(await listRuns(env.DB)).toEqual(before);
        expect(before.find((run) => run.id === newer)?.status).toBe("on_the_hill");
        expect(dispatches.map((inputs) => inputs.sha)).toEqual(["head58", NEWER_HEAD]);
      });

      it("ignores an opened whose head the PR has already moved past", async () => {
        live.head = NEW_HEAD;
        expect(await (await deliver(opened())).json()).toEqual({ ignored: "stale" });
        expect(await listRuns(env.DB)).toEqual([]);
        expect(dispatches).toEqual([]);
      });

      // The opening delivery was still listing files when the push's delivery ran.
      it("leaves no run on the hill for a head the PR left during its start", async () => {
        const slow = holdFirstListing();
        const opening = deliver(opened());
        await vi.waitFor(() => expect(slow.listed()).toBe(1));
        live.head = NEW_HEAD;
        const pushedRun = await start(pushed(NEW_HEAD));
        slow.release();
        const res = await opening;
        expect(res.status).toBe(202);
        const { runId } = (await res.json()) as { runId: string };
        expect(await statuses()).toEqual({ [runId]: "stopped", [pushedRun]: "on_the_hill" });
        expect(await logOf(runId)).toContain("stopped · superseded by 9f8e7d6");
      });

      it("of two starts racing on one head, leaves one run on the hill", async () => {
        const slow = holdFirstListing();
        const first = deliver(opened());
        await vi.waitFor(() => expect(slow.listed()).toBe(1));
        await start(opened());
        slow.release();
        expect((await first).status).toBe(202);
        expect(Object.values(await statuses()).sort()).toEqual(["on_the_hill", "stopped"]);
      });

      // GitHub reads the newest check of a name. Both starts pass the duplicate check before
      // either run is indexed; the first is held at its dispatch or its check's create until the
      // second, newer and so kept, has posted its check.
      it.each(["dispatch", "check"] as const)(
        "of two racing starts on one head, the kept run's check is newest (loser held at its %s)",
        async (hold) => {
          const listings = [gate(), gate()];
          const firstCall = gate();
          let listed = 0;
          let held = 0;
          const holdFirst = async () => {
            if (++held === 1) await firstCall.shut;
          };
          // The run of each check create, in the order GitHub took them.
          const created: string[] = [];
          github({
            [FILES_PATH]: async () => {
              await listings[listed++]?.shut;
              return docsOnly();
            },
            [DISPATCH_PATH]: async () => {
              if (hold === "dispatch") await holdFirst();
              return new Response(null, { status: 204 });
            },
            [CHECKS_PATH]: async (req) => {
              const { details_url: details } = (await req.json()) as { details_url: string };
              if (hold === "check") await holdFirst();
              created.push(details.slice(details.lastIndexOf("/") + 1));
              return Response.json({ id: 1 }, { status: 201 });
            },
          });
          const first = deliver(opened());
          await vi.waitFor(() => expect(listed).toBe(1));
          const second = deliver(readyForReview());
          await vi.waitFor(() => expect(listed).toBe(2));
          listings[0]!.open();
          await vi.waitFor(() => expect(held).toBe(1));
          // A later start, so the second run is the newest.
          await new Promise((resolve) => setTimeout(resolve, 10));
          listings[1]!.open();
          await vi.waitFor(() => expect(created.length).toBeGreaterThan(0));
          firstCall.open();
          const runOf = async (res: Promise<Response>) =>
            ((await (await res).json()) as { runId: string }).runId;
          const [lost, kept] = await Promise.all([runOf(first), runOf(second)]);
          expect(await statuses()).toEqual({ [lost]: "stopped", [kept]: "on_the_hill" });
          expect(created.at(-1)).toBe(kept);
        },
      );

      // The run stands; the cron stops what the reconcile could not.
      it("answers 202 when the reconcile after the start cannot read GitHub", async () => {
        const first = await start();
        live.head = NEW_HEAD;
        let reads = 0;
        dispatches = github({
          [PULL_PATH]: () =>
            ++reads === 1 ? pullReply() : new Response("secret body", { status: 500 }),
        });
        const runId = await start(pushed(NEW_HEAD));
        expect(await statuses()).toEqual({ [first]: "on_the_hill", [runId]: "on_the_hill" });
        expect(errors).toHaveBeenCalledOnce();
        expect(String(errors.mock.calls[0]![0])).toContain("failed with status 500");
      });
    });

    describe("a draft", () => {
      it("starts no run", async () => {
        live.draft = true;
        const res = await deliver(prPayload({ draft: true }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ignored: "draft" });
        expect(await listRuns(env.DB)).toEqual([]);
        expect(dispatches).toEqual([]);
      });

      // GitHub reads the PR as it is: the event may predate a conversion either way.
      it("is judged by GitHub's state, not the event's", async () => {
        live.draft = true;
        expect(await (await deliver(opened())).json()).toEqual({ ignored: "draft" });
        live.draft = false;
        expect((await deliver(prPayload({ draft: true }))).status).toBe(202);
      });

      it("pushed to stops the run on the head it left", async () => {
        const first = await start();
        Object.assign(live, { draft: true, head: NEW_HEAD });
        const res = await deliver(pushed(NEW_HEAD, { draft: true }));
        expect(await res.json()).toEqual({ ignored: "draft" });
        expect(await statuses()).toEqual({ [first]: "stopped" });
        expect(await logOf(first)).toContain("stopped · superseded by 9f8e7d6");
        expect(dispatches).toHaveLength(1);
      });

      it("starts a run once it is ready for review", async () => {
        live.draft = true;
        await deliver(prPayload({ draft: true }));
        live.draft = false;
        expect((await deliver(readyForReview())).status).toBe(202);
      });
    });

    // A check on a head vouches for every PR on it, so only PRs into main are patrolled.
    describe("the PR's base", () => {
      it("starts no run for a PR into another branch", async () => {
        live.base = "feat-a";
        const res = await deliver(opened());
        expect(await res.json()).toEqual({ ignored: "base" });
        expect(await listRuns(env.DB)).toEqual([]);
        expect(dispatches).toEqual([]);
      });

      it("retargeted away from main stops the run", async () => {
        const first = await start();
        live.base = "feat-a";
        const res = await deliver(edited({ base: { ref: { from: "main" } } }));
        expect(await res.json()).toEqual({ ignored: "base" });
        expect(await statuses()).toEqual({ [first]: "stopped" });
        expect(await logOf(first)).toContain("stopped · PR retargeted to feat-a");
      });

      // The diff changed with the base, so the head's run reviewed another one.
      it("retargeted onto main starts a fresh sweep, even on the same head", async () => {
        const first = await start();
        const runId = await start(edited({ base: { ref: { from: "feat-a" } } }));
        expect(await statuses()).toEqual({ [first]: "stopped", [runId]: "on_the_hill" });
        expect(await logOf(first)).toContain("stopped · superseded by head58");
      });
    });
  });

  // Spec §8: until Base to Base can deploy itself, changes to it are not patrolled.
  describe("Base to Base's own files", () => {
    const listing =
      (...files: Record<string, unknown>[]) =>
      () =>
        Response.json(files.map((file) => ({ additions: 1, deletions: 1, ...file })));
    const docs = { filename: "docs/BEST_PRACTICES.md" };
    const own = { filename: "basetobase/CLAUDE.md" };

    it.each([
      "basetobase/dispatch/src/run/machine.ts",
      ".basetobase/patrol/mainline.md",
      ".github/workflows/basetobase-agent.yml",
      "BaseToBase/CLAUDE.md",
    ])("ignores a PR touching %s, starting no run", async (filename) => {
      dispatches = github({ [FILES_PATH]: listing(docs, { filename }) });
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
      dispatches = github({ [FILES_PATH]: listing(renamed) });
      expect(await (await deliver(opened())).json()).toEqual({ ignored: "unpatrolled" });
      expect(await listRuns(env.DB)).toEqual([]);
    });

    // Neutral passes a required check, so branch protection lets such a PR merge.
    it("posts one neutral check on the head, naming the unpatrolled globs", async () => {
      const posted: Record<string, unknown>[] = [];
      dispatches = github({
        [FILES_PATH]: listing(docs, own),
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

    it("pushed to supersedes the run on the head it left", async () => {
      const first = await start();
      live.head = NEW_HEAD;
      dispatches = github({ [FILES_PATH]: listing(own) });
      expect(await (await deliver(pushed(NEW_HEAD))).json()).toEqual({ ignored: "unpatrolled" });
      expect(await statuses()).toEqual({ [first]: "stopped" });
      expect(await logOf(first)).toContain("stopped · superseded by 9f8e7d6");
    });

    // The PR moved on while the neutral check was being posted: a newer head's run stands.
    it("leaves the run on a head the PR reached during the pass", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let posts = 0;
      dispatches = github({
        [FILES_PATH]: () => (live.head === NEW_HEAD ? listing(own)() : docsOnly()),
        [CHECKS_PATH]: async () => {
          if (++posts === 1) await held;
          return Response.json({ id: 1 }, { status: 201 });
        },
      });
      live.head = NEW_HEAD;
      const passing = deliver(pushed(NEW_HEAD));
      await vi.waitFor(() => expect(posts).toBe(1));
      live.head = NEWER_HEAD;
      const newer = await start(pushed(NEWER_HEAD));
      release();
      expect(await (await passing).json()).toEqual({ ignored: "unpatrolled" });
      expect(await statuses()).toEqual({ [newer]: "on_the_hill" });
      expect(await logOf(newer)).not.toContain(`stopped · superseded by ${NEW_HEAD.slice(0, 7)}`);
    });

    it("answers unpatrolled when the reconcile after the check cannot read GitHub", async () => {
      const first = await start();
      live.head = NEW_HEAD;
      let reads = 0;
      dispatches = github({
        [FILES_PATH]: listing(own),
        [PULL_PATH]: () =>
          ++reads === 1 ? pullReply() : new Response("secret body", { status: 500 }),
      });
      expect(await (await deliver(pushed(NEW_HEAD))).json()).toEqual({ ignored: "unpatrolled" });
      expect(await statuses()).toEqual({ [first]: "on_the_hill" });
      expect(errors).toHaveBeenCalledOnce();
      expect(String(errors.mock.calls[0]![0])).toContain("failed with status 500");
    });

    it("502 when the neutral check cannot be posted", async () => {
      dispatches = github({
        [FILES_PATH]: listing(own),
        [CHECKS_PATH]: () => new Response("secret body", { status: 500 }),
      });
      const res = await deliver(opened());
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).not.toContain("secret body");
      expect(JSON.parse(text)).toEqual({
        error: "could not post the check run to GitHub",
        github_status: 500,
      });
      expect(errors).toHaveBeenCalledOnce();
      expect(String(errors.mock.calls[0]![0])).toContain("failed with status 500");
      expect(await listRuns(env.DB)).toEqual([]);
    });

    // The check goes first: a failure leaves the PR as it was, for a redelivery or the cron.
    it("leaves the old head's run alone when the neutral check cannot be posted", async () => {
      const first = await start();
      live.head = NEW_HEAD;
      dispatches = github({
        [FILES_PATH]: listing(own),
        [CHECKS_PATH]: () => new Response("", { status: 500 }),
      });
      expect((await deliver(pushed(NEW_HEAD))).status).toBe(502);
      expect(await statuses()).toEqual({ [first]: "on_the_hill" });
    });

    it.each([".github/workflows/ci.yml", "docs/basetobase/notes.md", "basetobase.md"])(
      "patrols a PR touching %s",
      async (filename) => {
        dispatches = github({ [FILES_PATH]: listing({ filename }) });
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
      ["another repository", "pull_request", prPayload({ repo: "eve/simplegoapp" }), "repo"],
      [
        "an edit of the body alone",
        "pull_request",
        edited({ body: { from: "Cancel orders." } }),
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

  describe("retitle", () => {
    const retitled = (title = "orders: cancel a pending order") => {
      const payload = edited({ title: { from: "orders: add cancel endpoint" } });
      (payload.pull_request as { title: string }).title = title;
      return payload;
    };
    const titles = async () => (await listRuns(env.DB)).map((run) => run.prTitle);

    // Finished runs too: the runs list files them under the PR's title.
    it("gives every run of the PR its new title", async () => {
      const first = await start();
      live.head = NEW_HEAD;
      const second = await start(pushed(NEW_HEAD));
      live.title = "orders: cancel a pending order";
      const res = await deliver(retitled());
      expect(res.status).toBe(200);
      const { retitled: ids } = (await res.json()) as { retitled: string[] };
      expect(ids.sort()).toEqual([first, second].sort());
      expect(await titles()).toEqual([
        "orders: cancel a pending order",
        "orders: cancel a pending order",
      ]);
      expect(dispatches).toHaveLength(2);
    });

    // Two quick edits can arrive in either order, and a redelivery at any time.
    it("takes the title GitHub has now, not the event's", async () => {
      const runId = await start();
      live.state = "closed";
      await deliver(closed());
      live.title = "orders: cancel any pending order";
      await deliver(retitled("orders: cancel any pending order"));
      await deliver(retitled("orders: cancel a pending order"));
      expect(await statuses()).toEqual({ [runId]: "stopped" });
      expect(await titles()).toEqual(["orders: cancel any pending order"]);
    });

    it("502 when the PR cannot be read, retitling nothing", async () => {
      await start();
      dispatches = github({ [PULL_PATH]: () => new Response("secret body", { status: 502 }) });
      const res = await deliver(retitled());
      expect(res.status).toBe(502);
      expect(await res.text()).not.toContain("secret body");
      expect(await titles()).toEqual(["orders: add cancel endpoint"]);
    });

    it("retitles nothing for a PR with no run", async () =>
      expect(await (await deliver(retitled())).json()).toEqual({ retitled: [] }));
  });

  describe("closed", () => {
    beforeEach(() => {
      live.state = "closed";
    });

    it("stops the run", async () => {
      live.state = "open";
      const runId = await start();
      live.state = "closed";
      const res = await deliver(closed());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ landed: [], stopped: [runId], retitled: [] });
      expect(await statuses()).toEqual({ [runId]: "stopped" });
      expect(await logOf(runId)).toContain("stopped · PR closed");
    });

    // Out of 'needs you': the PR it spoke for is gone.
    it("stops a run whose sweep has finished", async () => {
      live.state = "open";
      const runId = await start();
      await sweep(runId);
      live.state = "closed";
      expect(await (await deliver(closed())).json()).toMatchObject({ stopped: [runId] });
      expect(await statuses()).toEqual({ [runId]: "stopped" });
    });

    it("stops a run whose first dispatch is still with GitHub", async () => {
      live.state = "open";
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let dispatching = false;
      github({
        [DISPATCH_PATH]: async () => {
          dispatching = true;
          await held;
          return new Response(null, { status: 204 });
        },
      });
      const opening = deliver(opened());
      await vi.waitFor(() => expect(dispatching).toBe(true));
      live.state = "closed";
      const res = await deliver(closed());
      release();
      const { runId } = (await (await opening).json()) as { runId: string };
      expect(await res.json()).toMatchObject({ stopped: [runId] });
      expect(await listRuns(env.DB)).toMatchObject([{ id: runId, status: "stopped" }]);
    });

    it("stops nothing for a PR with no run", async () => {
      const res = await deliver(closed());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ landed: [], stopped: [], retitled: [] });
    });

    // Close then reopen re-runs checks; GitHub may deliver the close last.
    it("delivered after the PR was reopened is stale, leaving the run alone", async () => {
      live.state = "open";
      const runId = await start();
      expect(await (await deliver(closed())).json()).toEqual({ ignored: "stale" });
      expect(await statuses()).toEqual({ [runId]: "on_the_hill" });
    });

    // Only the owner's PRs have runs, and GitHub's rate limit is shared with them.
    it("of another author's PR is ignored without reading GitHub", async () => {
      let reads = 0;
      github({
        [PULL_PATH]: () => {
          reads++;
          return pullReply();
        },
      });
      const res = await deliver(prPayload({ action: "closed", author: "eve" }));
      expect(await res.json()).toEqual({ ignored: "author" });
      expect(reads).toBe(0);
    });

    // Deleting the head repository closes the PR too.
    it("of a PR whose head repository is gone stops its run", async () => {
      live.state = "open";
      const runId = await start();
      live.state = "closed";
      const payload = closed();
      (payload.pull_request as { head: { repo: unknown } }).head.repo = null;
      expect(await (await deliver(payload)).json()).toMatchObject({ stopped: [runId] });
    });

    it("in another repository is ignored, leaving our run alone", async () => {
      live.state = "open";
      await start();
      const res = await deliver(prPayload({ action: "closed", repo: "eve/simplegoapp" }));
      expect(await res.json()).toEqual({ ignored: "repo" });
      expect((await listRuns(env.DB))[0]!.status).toBe("on_the_hill");
    });

    it("for another PR leaves our run alone", async () => {
      live.state = "open";
      await start();
      github({
        "GET /repos/aghchan/simplegoapp/pulls/59": () =>
          Response.json({
            state: "closed",
            draft: false,
            merged: false,
            title: "other",
            head: { sha: "head59" },
            base: { ref: "main", repo: { default_branch: "main" } },
          }),
      });
      const other = prPayload({ action: "closed" });
      (other.pull_request as { number: number }).number = 59;
      const res = await deliver(other);
      expect(await res.json()).toEqual({ landed: [], stopped: [], retitled: [] });
      expect((await listRuns(env.DB))[0]!.status).toBe("on_the_hill");
    });

    it("502 when the PR cannot be read, leaving the run alone", async () => {
      live.state = "open";
      const runId = await start();
      github({ [PULL_PATH]: () => new Response("secret body", { status: 502 }) });
      const res = await deliver(closed());
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).not.toContain("secret body");
      expect(JSON.parse(text)).toEqual({
        error: "could not read the pull request from GitHub",
        github_status: 502,
      });
      expect(await statuses()).toEqual({ [runId]: "on_the_hill" });
    });

    describe("merged", () => {
      let patched: Record<string, unknown>[];

      beforeEach(() => {
        live.state = "open";
        patched = [];
        dispatches = github({
          [CHECK_PATH]: async (req) => {
            patched.push(await req.json());
            return Response.json({ id: 1 });
          },
        });
      });

      const merge = () => Object.assign(live, { state: "closed", merged: true });

      it("lands the run on the merged head, leaving its sweep's check as it was", async () => {
        const runId = await start();
        await sweep(runId);
        const checks = patched.length;
        merge();
        const res = await deliver(closed());
        expect(await res.json()).toEqual({ landed: [runId], stopped: [], retitled: [] });
        expect(await statuses()).toEqual({ [runId]: "landed" });
        expect(await logOf(runId)).toContain("landed · merged as 4d3c2b1");
        expect(patched).toHaveLength(checks);
      });

      it("mid-review lands the run and ends its check", async () => {
        const runId = await start();
        merge();
        expect(await (await deliver(closed())).json()).toMatchObject({ landed: [runId] });
        expect(await statuses()).toEqual({ [runId]: "landed" });
        expect(patched.at(-1)).toMatchObject({
          status: "completed",
          conclusion: "cancelled",
          output: { title: "Merged before the review finished" },
        });
      });

      it("a second time changes nothing", async () => {
        const runId = await start();
        merge();
        await deliver(closed());
        expect(await (await deliver(closed())).json()).toEqual({
          landed: [],
          stopped: [],
          retitled: [],
        });
        expect(await statuses()).toEqual({ [runId]: "landed" });
      });

      // An unpatrolled PR, say, merges with no run of its own.
      it("lands nothing for a head that never had a run", async () => {
        merge();
        expect(await (await deliver(closed())).json()).toEqual({
          landed: [],
          stopped: [],
          retitled: [],
        });
      });
    });
  });

  describe("when GitHub cannot be reached", () => {
    it("502 without a run when the files cannot be listed", async () => {
      dispatches = github({ [FILES_PATH]: () => new Response("secret body", { status: 500 }) });
      const res = await deliver(opened());
      expect(res.status).toBe(502);
      expect(await listRuns(env.DB)).toEqual([]);
      expect(dispatches).toEqual([]);
      const text = await res.text();
      expect(text).not.toContain("secret body");
      expect(JSON.parse(text)).toEqual({
        error: "could not read the pull request from GitHub",
        github_status: 500,
      });
      expect(errors).toHaveBeenCalledOnce();
    });

    it("502 for a push whose PR cannot be read, leaving the run alone", async () => {
      await deliver(opened());
      dispatches = github({ [PULL_PATH]: () => new Response("secret body", { status: 500 }) });
      const res = await deliver(pushed("head59"));
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).not.toContain("secret body");
      expect(JSON.parse(text)).toMatchObject({ github_status: 500 });
      expect(errors).toHaveBeenCalledOnce();
      expect(await listRuns(env.DB)).toMatchObject([{ status: "on_the_hill" }]);
      expect(dispatches).toEqual([]);
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
      dispatches = github({ [FILES_PATH]: () => new Response("nope", { status: 500 }) });
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
