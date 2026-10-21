import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createLocalJWKSet } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSession, SESSION_COOKIE, SESSION_TTL_MS, STATE_COOKIE } from "../src/auth/session.ts";
import { createApp } from "../src/index.ts";
import { envWith, fakeFetch } from "./helpers.ts";

const app = createApp({ agentKey: createLocalJWKSet({ keys: [] }) });
// Short enough that a JSON parser error quotes the whole of it.
const ACCESS_TOKEN = "gho_0123456789abcdef";
const STATE = "state-from-login";
const SECRETS = ["SESSION_SECRET", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"] as const;
const COOKIE_ATTRIBUTES = "HttpOnly; Secure; SameSite=Lax";
const CLEARED_STATE = `${STATE_COOKIE}=; Max-Age=0; Path=/auth; ${COOKIE_ATTRIBUTES}`;
const CLEARED_SESSION = `${SESSION_COOKIE}=; Max-Age=0; Path=/; ${COOKIE_ATTRIBUTES}`;

interface GitHubReplies {
  token?: () => Response;
  user?: () => Response;
}

// GitHub's OAuth endpoints; any other request fails the test.
function stubGitHub(replies: GitHubReplies = {}) {
  const github = fakeFetch({
    "POST /login/oauth/access_token":
      replies.token ?? (() => Response.json({ access_token: ACCESS_TOKEN, token_type: "bearer" })),
    "GET /user": replies.user ?? (() => Response.json({ login: "aghchan" })),
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(github);
  return github;
}

async function request(path: string, init: RequestInit = {}, workerEnv: Env = env) {
  const req = new Request(`https://b2b.test${path}`, init);
  return app.fetch(req, workerEnv, createExecutionContext());
}

interface Callback {
  query?: string;
  cookie?: string | null;
  workerEnv?: Env;
}

const callback = ({ query = `code=abc&state=${STATE}`, cookie, workerEnv }: Callback = {}) => {
  const stateCookie = cookie === undefined ? `${STATE_COOKIE}=${STATE}` : cookie;
  const headers = new Headers();
  if (stateCookie !== null) headers.set("Cookie", stateCookie);
  return request(`/auth/callback?${query}`, { headers }, workerEnv);
};

function setCookie(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
}

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /auth/login", () => {
  it("sends the browser to GitHub with a state it will check on return", async () => {
    const res = await request("/auth/login");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe(env.GITHUB_OAUTH_CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(`${env.PUBLIC_URL}/auth/callback`);
    const state = location.searchParams.get("state")!;
    expect(state).toMatch(/^[\w-]{43}$/);
    expect(setCookie(res, STATE_COOKIE)).toBe(
      `${STATE_COOKIE}=${state}; Max-Age=600; Path=/auth; ${COOKIE_ATTRIBUTES}`,
    );
    expect(setCookie(res, SESSION_COOKIE)).toBeUndefined();
  });

  it("uses a new state each time", async () => {
    const states = await Promise.all(
      [1, 2, 3].map(async () => {
        const res = await request("/auth/login");
        return new URL(res.headers.get("Location")!).searchParams.get("state");
      }),
    );
    expect(new Set(states).size).toBe(3);
  });

  it.each(SECRETS.flatMap((name) => [[name, ""] as const, [name, undefined] as const]))(
    "500 without a redirect or cookie when %s is %j",
    async (name, value) => {
      const res = await request("/auth/login", {}, envWith(env, { [name]: value }));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "sign-in is not configured" });
      expect(res.headers.get("Location")).toBeNull();
      expect(res.headers.getSetCookie()).toEqual([]);
    },
  );
});

describe("GET /auth/callback", () => {
  describe("with a matching state", () => {
    it("signs in the owner", async () => {
      const github = stubGitHub();
      const res = await callback();
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
      const session = setCookie(res, SESSION_COOKIE)!;
      expect(session).toMatch(
        new RegExp(
          `^${SESSION_COOKIE}=[\\w.-]+; Max-Age=${SESSION_TTL_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax$`,
        ),
      );
      const value = session.split(";")[0]!;
      expect(await readSession(env.SESSION_SECRET, value, Date.now())).toBe("aghchan");
      expect(setCookie(res, STATE_COOKIE)).toBe(CLEARED_STATE);
      expect(github.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        "POST https://github.com/login/oauth/access_token",
        `GET ${env.GITHUB_API}/user`,
      ]);
    });

    it("exchanges the code and asks GitHub who the token belongs to", async () => {
      const github = stubGitHub();
      await callback({ query: `code=the-code&state=${STATE}` });
      const [exchange, user] = github.calls;
      expect(exchange!.headers.get("Accept")).toBe("application/json");
      expect(await exchange!.json()).toEqual({
        client_id: env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
        code: "the-code",
        redirect_uri: `${env.PUBLIC_URL}/auth/callback`,
      });
      expect(user!.headers.get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(user!.headers.get("User-Agent")).toBe("basetobase");
    });

    it.each(["AGHCHAN", "AghChan"])("signs in the owner as %s", async (login) => {
      stubGitHub({ user: () => Response.json({ login }) });
      const res = await callback();
      expect(res.status).toBe(302);
      const value = setCookie(res, SESSION_COOKIE)!.split(";")[0]!;
      expect(await readSession(env.SESSION_SECRET, value, Date.now())).toBe(login);
    });

    it("403 for another login, with no session", async () => {
      stubGitHub({ user: () => Response.json({ login: "eve" }) });
      const res = await callback();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Not on the allowlist" });
      expect(setCookie(res, SESSION_COOKIE)).toBeUndefined();
      expect(setCookie(res, STATE_COOKIE)).toBe(CLEARED_STATE);
    });

    it("403 for a login that only contains the owner's", async () => {
      stubGitHub({ user: () => Response.json({ login: "aghchan-evil" }) });
      expect((await callback()).status).toBe(403);
    });
  });

  describe("400 before GitHub is contacted", () => {
    it.each<[string, Callback]>([
      ["the state differs", { query: "code=abc&state=another-state" }],
      ["the state differs only at the end", { query: `code=abc&state=${STATE.slice(0, -1)}x` }],
      ["the state is a prefix of the cookie's", { query: `code=abc&state=${STATE.slice(0, -1)}` }],
      ["the state cookie is missing", { cookie: null }],
      ["the state cookie is empty", { cookie: `${STATE_COOKIE}=` }],
      ["the state is missing", { query: "code=abc" }],
      ["the state is empty", { query: "code=abc&state=" }],
      ["the code is missing", { query: `state=${STATE}` }],
      ["the code is empty", { query: `code=&state=${STATE}` }],
      ["both are missing", { query: "", cookie: null }],
    ])("when %s", async (_name, input) => {
      const github = stubGitHub();
      const res = await callback(input);
      expect(res.status).toBe(400);
      expect(github.calls).toEqual([]);
      expect(setCookie(res, SESSION_COOKIE)).toBeUndefined();
      expect(setCookie(res, STATE_COOKIE)).toBe(CLEARED_STATE);
    });
  });

  describe("502 with a fixed message", () => {
    const unreachable = () => {
      throw new Error("connection lost");
    };
    // GitHub answers in this form when it ignores the Accept header.
    const formEncoded = () => new Response(`access_token=${ACCESS_TOKEN}&token_type=bearer`);

    it.each<[string, GitHubReplies]>([
      ["the token endpoint answers 500", { token: () => new Response("boom", { status: 500 }) }],
      [
        "GitHub refuses the code",
        { token: () => Response.json({ error: "bad_verification_code" }) },
      ],
      ["the token response is not JSON", { token: formEncoded }],
      [
        "the token response has an empty token",
        { token: () => Response.json({ access_token: "" }) },
      ],
      ["the token endpoint is unreachable", { token: unreachable }],
      ["the user lookup answers 401", { user: () => new Response("nope", { status: 401 }) }],
      ["the user response is not JSON", { user: () => new Response("<html>", { status: 200 }) }],
      ["the user has no login", { user: () => Response.json({ id: 1 }) }],
      ["the user's login is not a string", { user: () => Response.json({ login: 7 }) }],
      ["the user lookup is unreachable", { user: unreachable }],
    ])("when %s", async (_name, replies) => {
      stubGitHub(replies);
      const res = await callback();
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "could not complete sign-in with GitHub" });
      expect(setCookie(res, SESSION_COOKIE)).toBeUndefined();
      expect(setCookie(res, STATE_COOKIE)).toBe(CLEARED_STATE);
      expect(errors).toHaveBeenCalled();
    });

    // A JSON parser's error quotes its input, so each of these would put a secret in the log if
    // the code logged what it caught instead of its own words.
    it.each<[string, GitHubReplies]>([
      ["a token response in the form-encoded style", { token: formEncoded }],
      ["a token response that is the token alone", { token: () => new Response(ACCESS_TOKEN) }],
      [
        "a token response that is the client secret",
        { token: () => new Response(env.GITHUB_OAUTH_CLIENT_SECRET) },
      ],
      ["a user response that is the token", { user: () => new Response(ACCESS_TOKEN) }],
      [
        "a failed user lookup that echoes the token",
        { user: () => new Response(ACCESS_TOKEN, { status: 500 }) },
      ],
    ])("never shows the access token or client secret after %s", async (_name, replies) => {
      stubGitHub(replies);
      const res = await callback();
      const shown = JSON.stringify([await res.text(), [...res.headers], errors.mock.calls]);
      expect(res.status).toBe(502);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(shown).not.toContain(ACCESS_TOKEN);
      expect(shown).not.toContain(env.GITHUB_OAUTH_CLIENT_SECRET);
    });
  });

  it.each(SECRETS.flatMap((name) => [[name, ""] as const, [name, undefined] as const]))(
    "500 with no session and no call to GitHub when %s is %j",
    async (name, value) => {
      const github = stubGitHub();
      const res = await callback({ workerEnv: envWith(env, { [name]: value }) });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "sign-in is not configured" });
      expect(github.calls).toEqual([]);
      expect(setCookie(res, SESSION_COOKIE)).toBeUndefined();
      expect(res.headers.get("Location")).toBeNull();
    },
  );
});

describe("POST /auth/logout", () => {
  it("clears the session cookie", async () => {
    const res = await request("/auth/logout", { method: "POST" });
    expect(res.status).toBe(204);
    expect(setCookie(res, SESSION_COOKIE)).toBe(CLEARED_SESSION);
  });

  it("works with no secrets configured", async () => {
    const res = await request(
      "/auth/logout",
      { method: "POST" },
      envWith(env, { SESSION_SECRET: "" }),
    );
    expect(res.status).toBe(204);
  });

  it("is POST only", async () => {
    const res = await request("/auth/logout");
    expect(res.status).toBe(404);
    expect(setCookie(res, SESSION_COOKIE)).toBeUndefined();
  });
});
