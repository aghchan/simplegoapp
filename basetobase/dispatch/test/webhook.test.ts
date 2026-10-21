import { describe, expect, it } from "vitest";
import { toTrigger, verifyWebhookSignature } from "../src/github/webhook.ts";
import { prPayload, prRef, sign } from "./helpers.ts";

const ID = { owner: "aghchan", repo: "aghchan/simplegoapp" };
const enc = (text: string): ArrayBuffer => new TextEncoder().encode(text).slice().buffer;
const MALFORMED = { kind: "ignore", reason: "payload" };

// The default payload with the field at a dotted path replaced; undefined removes it.
function tamper(path: string, value: unknown): unknown {
  const payload = structuredClone(prPayload());
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
      defaultBranch: "main",
      author: "aghchan",
      installationId: 7,
    }));
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
    expect(t).toMatchObject({ kind: "start", pr: { defaultBranch: "main" } });
  });

  it.each([
    ["draft", { draft: true }],
    ["fork", { headRepo: "eve/simplegoapp" }],
    ["author", { author: "eve" }],
    ["repo", { repo: "aghchan/other" }],
  ])("ignores %s", (reason, over) =>
    expect(toTrigger("pull_request", prPayload(over), ID)).toEqual({ kind: "ignore", reason }),
  );
  it("ignores a PR whose head repository is gone", () =>
    expect(toTrigger("pull_request", tamper("pull_request.head.repo", null), ID)).toEqual({
      kind: "ignore",
      reason: "fork",
    }));
  it("checks the repo before the fork, author and draft", () => {
    const over = { repo: "aghchan/other", author: "eve", draft: true };
    expect(toTrigger("pull_request", prPayload(over), ID)).toEqual({
      kind: "ignore",
      reason: "repo",
    });
  });

  it("closed stops", () =>
    expect(toTrigger("pull_request", prPayload({ action: "closed" }), ID)).toEqual({
      kind: "stop",
      repo: ID.repo,
      prNumber: 58,
    }));
  it("a close in another repo never addresses this repo", () =>
    expect(
      toTrigger("pull_request", prPayload({ action: "closed", repo: "aghchan/other" }), ID),
    ).toEqual({ kind: "stop", repo: "aghchan/other", prNumber: 58 }));
  it("closed needs only the repo and the number", () => {
    const payload = {
      action: "closed",
      repository: { full_name: ID.repo },
      pull_request: { number: 58 },
    };
    expect(toTrigger("pull_request", payload, ID)).toEqual({
      kind: "stop",
      repo: ID.repo,
      prNumber: 58,
    });
  });
  it("synchronize starts, like opened", () =>
    expect(toTrigger("pull_request", prPayload({ action: "synchronize" }), ID)).toEqual(
      toTrigger("pull_request", prPayload(), ID),
    ));
  it("synchronize on a draft is ignored", () =>
    expect(
      toTrigger("pull_request", prPayload({ action: "synchronize", draft: true }), ID),
    ).toEqual({ kind: "ignore", reason: "draft" }));
  it("edited is ignored", () =>
    expect(toTrigger("pull_request", prPayload({ action: "edited" }), ID)).toEqual({
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
    ])("ignores a close with %s", (_label, payload) =>
      expect(toTrigger("pull_request", payload, ID)).toEqual(MALFORMED),
    );
  });
});
