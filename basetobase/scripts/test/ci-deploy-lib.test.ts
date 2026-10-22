import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  parseHealth,
  planDeploy,
  runDeploy,
  skipReason,
  workerDiffArgs,
  type DeployIO,
  type Health,
} from "../src/ci-deploy-lib.ts";

const SHA = "4f7e2a1c9b0d3e5f60718293a4b5c6d7e8f90a1b";
const OLDER = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const NEWER = "9f8e7d6c5b4a39281706f5e4d3c2b1a098f7e6d5";
const TIMING = { pollMs: 1_000, timeoutMs: 5_000 };

function live(tag: string | null, over: Partial<Health> = {}): Health {
  return { ok: true, version: `version-of-${tag ?? "hand"}`, tag, ...over };
}

interface Fake {
  io: DeployIO;
  wranglerCalls: string[][];
  summary: string[];
  sleeps: number;
}

// /health answers come off `healths` in order; the last one repeats.
function fake(o: {
  healths: (Health | undefined)[];
  commits?: string[];
  // [ancestor, descendant] pairs.
  ancestors?: [string, string][];
  changed?: boolean;
  subject?: string;
  wrangler?: (args: string[]) => boolean;
}): Fake {
  const f: Fake = { io: undefined as unknown as DeployIO, wranglerCalls: [], summary: [], sleeps: 0 };
  const healths = [...o.healths];
  f.io = {
    health: async () => (healths.length > 1 ? healths.shift() : healths[0]),
    hasCommit: async (sha) => (o.commits ?? [SHA, OLDER, NEWER]).includes(sha),
    isAncestor: async (a, d) => (o.ancestors ?? []).some(([x, y]) => x === a && y === d),
    workerChanged: async () => o.changed ?? true,
    subject: async () => o.subject ?? "basetobase: a change",
    wrangler: async (args) => {
      f.wranglerCalls.push(args);
      return o.wrangler ? o.wrangler(args) : true;
    },
    sleep: async () => {
      f.sleeps += 1;
    },
    log: () => {},
    summary: (line) => f.summary.push(line),
  };
  return f;
}

const MIGRATE = ["d1", "migrations", "apply", "basetobase", "--remote"];

describe("parseHealth", () => {
  it("reads Base to Base's answer", () => {
    expect(parseHealth({ ok: true, version: "v1", tag: SHA })).toEqual({ ok: true, version: "v1", tag: SHA });
    expect(parseHealth({ ok: false, version: "v1", tag: null })).toEqual({ ok: false, version: "v1", tag: null });
    expect(parseHealth({ ok: true, version: "v1", tag: "" })).toEqual({ ok: true, version: "v1", tag: null });
  });

  it("refuses anything else, such as the dashboard page a version without /health serves", () => {
    for (const body of ["<!doctype html>", null, 3, { ok: "yes", version: "v1", tag: null }, { ok: true, tag: SHA }, { ok: true, version: "", tag: null }, { ok: true, version: "v1", tag: 7 }]) {
      expect(parseHealth(body)).toBeUndefined();
    }
  });
});

describe("skipReason", () => {
  it("deploys when there is no live version to compare with", async () => {
    expect(await skipReason(fake({ healths: [] }).io, undefined, SHA)).toBeUndefined();
    expect(await skipReason(fake({ healths: [] }).io, live(null), SHA)).toBeUndefined();
  });

  it("deploys over an unhealthy live version, even this very commit", async () => {
    expect(await skipReason(fake({ healths: [] }).io, live(SHA, { ok: false }), SHA)).toBeUndefined();
  });

  it("skips the commit that is already live", async () => {
    expect(await skipReason(fake({ healths: [] }).io, live(SHA), SHA)).toBe("this commit is already live");
  });

  it("skips when a newer commit is live: deploys can finish out of order", async () => {
    const io = fake({ healths: [], ancestors: [[SHA, NEWER]] }).io;
    expect(await skipReason(io, live(NEWER), SHA)).toBe("a newer commit (9f8e7d6) is already live");
  });

  it("skips when nothing the Worker ships changed since the live commit", async () => {
    const io = fake({ healths: [], ancestors: [[OLDER, SHA]], changed: false }).io;
    expect(await skipReason(io, live(OLDER), SHA)).toBe(
      "nothing the Worker ships changed since 1a2b3c4, which is live",
    );
  });

  it("deploys when the Worker changed since the live commit", async () => {
    const io = fake({ healths: [], ancestors: [[OLDER, SHA]], changed: true }).io;
    expect(await skipReason(io, live(OLDER), SHA)).toBeUndefined();
  });

  it("deploys when the live commit is not in this history", async () => {
    const io = fake({ healths: [], commits: [SHA], changed: false }).io;
    expect(await skipReason(io, live(OLDER), SHA)).toBeUndefined();
  });
});

describe("planDeploy", () => {
  it("says whether the deploy job runs, and why not", async () => {
    const skip = fake({ healths: [live(SHA)] });
    expect(await planDeploy(skip.io, SHA)).toBe(false);
    expect(skip.summary).toEqual(["No deploy for 4f7e2a1: this commit is already live."]);

    const go = fake({ healths: [undefined] });
    expect(await planDeploy(go.io, SHA)).toBe(true);
    expect(go.summary).toEqual(["4f7e2a1 deploys."]);
    expect(go.wranglerCalls).toEqual([]);
  });
});

describe("runDeploy", () => {
  it("migrates, deploys tagged with the commit, and waits for /health to show it", async () => {
    const f = fake({ healths: [live(OLDER), live(OLDER), live(SHA, { version: "v-new" })], subject: "basetobase: land runs" });
    expect(await runDeploy(f.io, SHA, TIMING)).toBe("deployed");
    expect(f.wranglerCalls).toEqual([
      MIGRATE,
      ["deploy", "--tag", SHA, "--message", "4f7e2a1 basetobase: land runs"],
    ]);
    expect(f.summary).toEqual(["Deployed 4f7e2a1 as version v-new."]);
  });

  it("keeps the version message short", async () => {
    const f = fake({ healths: [undefined, live(SHA)], subject: "x".repeat(300) });
    await runDeploy(f.io, SHA, TIMING);
    expect(f.wranglerCalls[1]?.[4]).toHaveLength(100);
  });

  it("checks the plan again and leaves a commit already live alone", async () => {
    const f = fake({ healths: [live(SHA)] });
    expect(await runDeploy(f.io, SHA, TIMING)).toBe("skipped");
    expect(f.wranglerCalls).toEqual([]);
  });

  it("does not deploy when the migrations fail", async () => {
    const f = fake({ healths: [live(OLDER)], wrangler: (args) => args[0] !== "d1" });
    expect(await runDeploy(f.io, SHA, TIMING)).toBe("failed");
    expect(f.wranglerCalls).toEqual([MIGRATE]);
    expect(f.summary[0]).toContain("D1 migrations failed for 4f7e2a1");
  });

  it("fails without a rollback when wrangler deploy fails and the old version still serves", async () => {
    const f = fake({ healths: [live(OLDER)], wrangler: (args) => args[0] !== "deploy" });
    expect(await runDeploy(f.io, SHA, TIMING)).toBe("failed");
    expect(f.wranglerCalls.map((args) => args[0])).toEqual(["d1", "deploy"]);
    expect(f.summary[0]).toContain("wrangler deploy failed for 4f7e2a1");
  });

  it("checks a deploy that went out despite wrangler's error like any other", async () => {
    const f = fake({ healths: [live(OLDER), live(SHA)], wrangler: (args) => args[0] !== "deploy" });
    expect(await runDeploy(f.io, SHA, TIMING)).toBe("deployed");
  });

  it("rolls back to the version that served before when the commit never shows healthy", async () => {
    const before = live(OLDER, { version: "v-old" });
    const f = fake({ healths: [before, live(SHA, { ok: false, version: "v-new" }), live(SHA, { ok: false, version: "v-new" }), live(SHA, { ok: false, version: "v-new" }), live(SHA, { ok: false, version: "v-new" }), live(SHA, { ok: false, version: "v-new" }), live(SHA, { ok: false, version: "v-new" }), before] });
    expect(await runDeploy(f.io, SHA, TIMING)).toBe("rolled back");
    expect(f.wranglerCalls.at(-1)).toEqual([
      "rollback",
      "v-old",
      "--yes",
      "--message",
      "4f7e2a1 never served a healthy /health within 5 s",
    ]);
    expect(f.summary).toEqual([
      "4f7e2a1 never served a healthy /health within 5 s. Rolled back to version v-old, healthy.",
    ]);
  });

  it("gives up waiting once the time is up, for the new version and for the rollback", async () => {
    // Neither the new commit nor the version rolled back to ever shows.
    const f = fake({ healths: [live(OLDER, { version: "v-old" }), live(OLDER, { version: "v-other" })] });
    expect(await runDeploy(f.io, SHA, TIMING)).toBe("rolled back");
    // 5 s at 1 s a poll, twice.
    expect(f.sleeps).toBe(10);
    expect(f.summary[0]).toContain("Rolled back to version v-old; /health has not confirmed it.");
  });

  it("rolls back to the previous version when none answered /health before", async () => {
    const f = fake({ healths: [undefined, undefined] });
    expect(await runDeploy(f.io, SHA, TIMING)).toBe("rolled back");
    expect(f.wranglerCalls.at(-1)).toEqual([
      "rollback",
      "--yes",
      "--message",
      "4f7e2a1 never served a healthy /health within 5 s",
    ]);
    expect(f.summary[0]).toContain("Rolled back; /health has not confirmed it.");
  });

  it("says to roll back by hand when the rollback fails", async () => {
    const f = fake({ healths: [live(OLDER), live(OLDER)], wrangler: (args) => args[0] !== "rollback" });
    expect(await runDeploy(f.io, SHA, TIMING)).toBe("failed");
    expect(f.summary[0]).toContain("the rollback failed too. Roll back by hand: npx wrangler rollback");
  });
});

describe("workerDiffArgs", () => {
  // A real repository: the pathspec's meaning is git's, not this file's.
  const root = mkdtempSync(join(tmpdir(), "b2b-pathspec-"));
  const cwd = join(root, "basetobase");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  const FILES = [
    "dispatch/src/index.ts",
    "dispatch/migrations/0001_runs.sql",
    "dispatch/test/routes.test.ts",
    "dashboard/src/App.tsx",
    "dashboard/CLAUDE.md",
    "shared/src/types.ts",
    "config/basetobase.json",
    "forwarder/src/run.ts",
    "scripts/src/setup.ts",
    "e2e/live.spec.ts",
    "wrangler.jsonc",
    "package-lock.json",
    "CLAUDE.md",
    "../README.md",
    "../.github/workflows/basetobase-ci.yml",
  ];
  mkdirSync(cwd, { recursive: true });
  // The repository's root is above basetobase/, as in the deploy job's checkout.
  execFileSync("git", ["init", "-q", root]);
  for (const path of FILES) write(path, "1");
  git("add", "-A", "..");
  git("commit", "-q", "--no-gpg-sign", "-m", "base");
  const base = git("rev-parse", "HEAD");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function changes(path: string): boolean {
    write(path, `${Math.random()}`);
    git("add", "-A", "..");
    git("commit", "-q", "--no-gpg-sign", "-m", path);
    const head = git("rev-parse", "HEAD");
    const status = spawnSync("git", workerDiffArgs(base, head), { cwd }).status;
    if (status !== 0 && status !== 1) throw new Error(`git diff exited ${status}`);
    return status === 1;
  }

  it.each([
    "dispatch/src/index.ts",
    "dispatch/migrations/0001_runs.sql",
    "dashboard/src/App.tsx",
    "shared/src/types.ts",
    "config/basetobase.json",
    "wrangler.jsonc",
    "package-lock.json",
  ])("counts %s as the Worker's", (path) => {
    expect(changes(path)).toBe(true);
  });

  it.each([
    "forwarder/src/run.ts",
    "scripts/src/setup.ts",
    "e2e/live.spec.ts",
    "dispatch/test/routes.test.ts",
    "dashboard/CLAUDE.md",
    "CLAUDE.md",
    "../README.md",
    "../.github/workflows/basetobase-ci.yml",
  ])("leaves %s out", (path) => {
    // Each case is checked against the base alone, so earlier commits of Worker files must not leak in.
    git("reset", "-q", "--hard", base);
    expect(changes(path)).toBe(false);
  });
});
