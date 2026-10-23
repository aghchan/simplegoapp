import { describe, expect, it } from "vitest";
import { REFRESH_AUTHOR, toTrigger, verifyWebhookSignature } from "../src/github/webhook.ts";
import { prPayload, prRef, sign } from "./helpers.ts";

const ID = { owner: "aghchan", repo: "aghchan/simplegoapp" };
const enc = (text: string): ArrayBuffer => new TextEncoder().encode(text).slice().buffer;
const MALFORMED = { kind: "ignore", reason: "payload" };
const closed = () => prPayload({ action: "closed" });

// The payload (the default one unless given) with the field at a dotted path replaced; undefined
// removes it.
function tamper(path: string, value: unknown, base: unknown = prPayload()): unknown {
  const payload = structuredClone(base) as Record<string, unknown>;
  const keys = path.split(".");
  const last = keys.pop() as string;
  let node: Record<string, unknown> = payload;
  for (const key of keys) node = node[key] as Record<string, unknown>;
  node[last] = value;
  return payload;
}

describe("verifyWebhookSignature", () => {
  it("accepts a valid signature", async () =>
    expect(await verifyWebhookSignature("s", enc("{}"), await sign("s", "{}"))).toBe(true));
  it("rejects a bad signature", async () =>
    expect(await verifyWebhookSignature("s", enc("{}"), "sha256=00")).toBe(false));
  it("rejects a missing signature", async () =>
    expect(await verifyWebhookSignature("s", enc("{}"), null)).toBe(false));

  it("accepts upper-case hex digits", async () => {
    const digest = (await sign("s", "{}")).slice("sha256=".length);
    expect(await verifyWebhookSignature("s", enc("{}"), `sha256=${digest.toUpperCase()}`)).toBe(
      true,
    );
  });
  it("rejects a well-formed signature that does not match", async () =>
    expect(await verifyWebhookSignature("s", enc("{}"), `sha256=${"0".repeat(64)}`)).toBe(false));
  it("rejects a signature made with another secret", async () =>
    expect(await verifyWebhookSignature("s", enc("{}"), await sign("other", "{}"))).toBe(false));
  it("rejects a signature over another body", async () =>
    expect(await verifyWebhookSignature("s", enc('{"a":1}'), await sign("s", "{}"))).toBe(false));
  it.each([
    ["empty", ""],
    ["unset", undefined],
  ])("rejects every signature when the secret is %s", async (_label, secret) => {
    const header = `sha256=${"0".repeat(64)}`;
    expect(await verifyWebhookSignature(secret as string, enc("{}"), header)).toBe(false);
  });

  it.each<[string, (valid: string) => string]>([
    ["another algorithm", (valid) => valid.replace("sha256=", "sha1=")],
    ["an upper-case algorithm", (valid) => valid.replace("sha256=", "SHA256=")],
    ["no algorithm", (valid) => valid.slice("sha256=".length)],
    ["a short digest", (valid) => valid.slice(0, -2)],
    ["a long digest", (valid) => `${valid}00`],
    ["a non-hex digit", (valid) => `${valid.slice(0, -1)}g`],
    ["leading whitespace", (valid) => ` ${valid}`],
    ["a trailing newline", (valid) => `${valid}\n`],
    ["nothing at all", () => ""],
  ])("rejects a header with %s", async (_label, mangle) => {
    const valid = await sign("s", "{}");
    expect(await verifyWebhookSignature("s", enc("{}"), valid)).toBe(true);
    expect(await verifyWebhookSignature("s", enc("{}"), mangle(valid))).toBe(false);
  });
});

describe("toTrigger", () => {
  it("owner PR opened starts", () => {
    const t = toTrigger("pull_request", prPayload(), ID);
    expect(t).toMatchObject({
      kind: "start",
      pr: {
        number: 58,
        headSha: "head58",
        baseSha: "base58",
        defaultBranch: "main",
        installationId: 7,
      },
    });
  });
  it("carries every field of the pull request", () =>
    expect(prRef()).toEqual({
      repo: "aghchan/simplegoapp",
      number: 58,
      title: "orders: add cancel endpoint",
      body: "Let a customer cancel their own pending order.",
      url: "https://github.com/aghchan/simplegoapp/pull/58",
      branch: "claude/orders-cancel",
      headSha: "head58",
      baseSha: "base58",
      baseRef: "main",
      draft: false,
      defaultBranch: "main",
      author: "aghchan",
      installationId: 7,
    }));
  it("a plain start is no retarget", () =>
    expect(toTrigger("pull_request", prPayload(), ID)).toMatchObject({ retarget: false }));
  it("ready_for_review starts", () =>
    expect(toTrigger("pull_request", prPayload({ action: "ready_for_review" }), ID).kind).toBe(
      "start",
    ));
  it("reopened starts", () =>
    expect(toTrigger("pull_request", prPayload({ action: "reopened" }), ID).kind).toBe("start"));
  it("a PR with no description starts with an empty body", () =>
    expect(toTrigger("pull_request", tamper("pull_request.body", null), ID)).toMatchObject({
      kind: "start",
      pr: { body: "" },
    }));
  it("dispatches from the repository default branch, not the PR target branch", () => {
    const t = toTrigger("pull_request", tamper("pull_request.base.ref", "release"), ID);
    expect(t).toMatchObject({ kind: "start", pr: { defaultBranch: "main", baseRef: "release" } });
  });
  // The route reads the PR's live state: a draft's push still supersedes the old head's runs.
  it.each(["opened", "synchronize"])("a draft's %s starts, carrying the flag", (action) =>
    expect(toTrigger("pull_request", prPayload({ action, draft: true }), ID)).toMatchObject({
      kind: "start",
      pr: { draft: true },
    }),
  );

  it.each([
    ["fork", { headRepo: "eve/simplegoapp" }],
    ["author", { author: "eve" }],
    ["repo", { repo: "aghchan/other" }],
  ])("ignores %s", (reason, over) =>
    expect(toTrigger("pull_request", prPayload(over), ID)).toEqual({ kind: "ignore", reason }),
  );
  // The route holds it to refreshGlobs once it has read the files.
  it("starts for the trail-names refresh workflow's PR", () =>
    expect(toTrigger("pull_request", prPayload({ author: REFRESH_AUTHOR }), ID)).toMatchObject({
      kind: "start",
      pr: { author: "github-actions[bot]" },
    }));
  it("ignores a PR whose head repository is gone", () =>
    expect(toTrigger("pull_request", tamper("pull_request.head.repo", null), ID)).toEqual({
      kind: "ignore",
      reason: "fork",
    }));
  it("checks the repo before the fork and the author", () => {
    const over = { repo: "aghchan/other", author: "eve", headRepo: "eve/other" };
    expect(toTrigger("pull_request", prPayload(over), ID)).toEqual({
      kind: "ignore",
      reason: "repo",
    });
  });

  it("closed asks the route to look, with the installation to look with", () =>
    expect(toTrigger("pull_request", closed(), ID)).toEqual({
      kind: "closed",
      repo: ID.repo,
      prNumber: 58,
      installationId: 7,
    }));
  // A late delivery may describe a PR that has since been reopened, so GitHub is read instead.
  it.each([true, false])("closed leaves the payload's merged (%s) out", (merged) =>
    expect(toTrigger("pull_request", tamper("pull_request.merged", merged, closed()), ID)).toEqual(
      toTrigger("pull_request", closed(), ID),
    ),
  );
  it("a close in another repo is ignored", () =>
    expect(
      toTrigger("pull_request", prPayload({ action: "closed", repo: "aghchan/other" }), ID),
    ).toEqual({ kind: "ignore", reason: "repo" }));
  // Deleting the head repository closes the PR, and its run must still hear of it.
  it.each([
    ["a fork", prPayload({ action: "closed", headRepo: "eve/simplegoapp" })],
    ["a PR whose head repository is gone", tamper("pull_request.head.repo", null, closed())],
  ])("a close of %s still asks the route to look", (_label, payload) =>
    expect(toTrigger("pull_request", payload, ID)).toMatchObject({ kind: "closed" }),
  );
  // Only the owner's PRs have runs, and a stranger's close must not spend GitHub calls.
  it("a close of another author's PR is ignored", () =>
    expect(toTrigger("pull_request", prPayload({ action: "closed", author: "eve" }), ID)).toEqual({
      kind: "ignore",
      reason: "author",
    }));
  it("a close checks the repo before the author", () =>
    expect(
      toTrigger("pull_request", prPayload({ action: "closed", repo: "eve/x", author: "eve" }), ID),
    ).toEqual({ kind: "ignore", reason: "repo" }));
  it("closed needs only the repo, the number, the author and the installation", () => {
    const payload = {
      action: "closed",
      installation: { id: 7 },
      repository: { full_name: ID.repo },
      pull_request: { number: 58, user: { login: ID.owner } },
    };
    expect(toTrigger("pull_request", payload, ID)).toEqual({
      kind: "closed",
      repo: ID.repo,
      prNumber: 58,
      installationId: 7,
    });
  });
  it("synchronize starts, like opened", () =>
    expect(toTrigger("pull_request", prPayload({ action: "synchronize" }), ID)).toEqual(
      toTrigger("pull_request", prPayload(), ID),
    ));

  describe("edited", () => {
    const edited = (changes: unknown, over: Record<string, unknown> = {}) =>
      tamper("changes", changes, prPayload({ action: "edited", ...over }));
    const base = { ref: { from: "feat-a" }, sha: { from: "basefeat" } };
    const title = { from: "orders: cancel" };

    // The head's check vouched for another diff: a fresh sweep, even on the same head.
    it("a new base starts a retarget", () =>
      expect(toTrigger("pull_request", edited({ base }), ID)).toEqual({
        kind: "start",
        pr: prRef(),
        retarget: true,
      }));
    // Edits arrive out of order, so the route reads the title from GitHub.
    it("a new title retitles the PR's runs, with the installation to read it with", () =>
      expect(toTrigger("pull_request", edited({ title }), ID)).toEqual({
        kind: "retitle",
        repo: ID.repo,
        prNumber: 58,
        installationId: 7,
      }));
    // The new run takes its title from the event.
    it("a new base and title is a retarget", () =>
      expect(toTrigger("pull_request", edited({ base, title }), ID)).toMatchObject({
        kind: "start",
        retarget: true,
      }));
    it.each([
      ["only a new body", { body: { from: "old" } }],
      ["no changes", {}],
      ["no changes object", undefined],
    ])("%s is ignored", (_label, changes) =>
      expect(toTrigger("pull_request", edited(changes), ID)).toEqual({
        kind: "ignore",
        reason: "action",
      }),
    );
    it.each([
      ["fork", { headRepo: "eve/simplegoapp" }],
      ["author", { author: "eve" }],
      ["repo", { repo: "aghchan/other" }],
    ])("a retitle filters by %s, as a start does", (reason, over) =>
      expect(toTrigger("pull_request", edited({ title }, over), ID)).toEqual({
        kind: "ignore",
        reason,
      }),
    );
  });

  // Without a push the run's head is still the PR's; the cron's reconcile stops it.
  it("converted_to_draft is ignored", () =>
    expect(toTrigger("pull_request", prPayload({ action: "converted_to_draft" }), ID)).toEqual({
      kind: "ignore",
      reason: "action",
    }));
  it("ping is ignored", () =>
    expect(toTrigger("ping", {}, ID)).toEqual({ kind: "ignore", reason: "event" }));
  it("a missing event is ignored", () =>
    expect(toTrigger(null, prPayload(), ID)).toEqual({ kind: "ignore", reason: "event" }));

  describe("malformed payloads", () => {
    it.each([
      ["null", null],
      ["a string", "opened"],
      ["an array", []],
      ["an empty object", {}],
    ])("ignores %s", (_label, payload) =>
      expect(toTrigger("pull_request", payload, ID)).toEqual(MALFORMED),
    );

    it.each([
      "repository.full_name",
      "repository.default_branch",
      "installation.id",
      "pull_request.number",
      "pull_request.title",
      "pull_request.body",
      "pull_request.html_url",
      "pull_request.head.ref",
      "pull_request.head.sha",
      "pull_request.base.sha",
      "pull_request.base.ref",
      "pull_request.user.login",
      "pull_request.draft",
    ])("ignores a payload without %s", (path) =>
      expect(toTrigger("pull_request", tamper(path, undefined), ID)).toEqual(MALFORMED),
    );

    it.each([
      ["installation.id", "7"],
      ["pull_request.number", "58"],
      ["pull_request.title", 58],
      ["pull_request.body", 58],
      ["pull_request.head.sha", { sha: "head58" }],
      ["pull_request.user", "aghchan"],
      ["pull_request.draft", "false"],
    ])("ignores a payload with a wrong-typed %s", (path, value) =>
      expect(toTrigger("pull_request", tamper(path, value), ID)).toEqual(MALFORMED),
    );

    it("ignores a payload with a non-positive PR number", () =>
      expect(toTrigger("pull_request", tamper("pull_request.number", 0), ID)).toEqual(MALFORMED));

    it.each([
      ["no payload", { action: "closed" }],
      ["no number", { action: "closed", repository: { full_name: ID.repo } }],
      [
        "a string number",
        { action: "closed", repository: { full_name: ID.repo }, pull_request: { number: "58" } },
      ],
      ["no repository", { action: "closed", pull_request: { number: 58 } }],
      [
        "no installation",
        { action: "closed", repository: { full_name: ID.repo }, pull_request: { number: 58 } },
      ],
      ["no author", tamper("pull_request.user", undefined, closed())],
      ["an author without a login", tamper("pull_request.user.login", 7, closed())],
    ])("ignores a close with %s", (_label, payload) =>
      expect(toTrigger("pull_request", payload, ID)).toEqual(MALFORMED),
    );
  });
});
