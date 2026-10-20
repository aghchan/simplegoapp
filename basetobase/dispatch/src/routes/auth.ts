import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  encodeBase64Url,
  isOwner,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  signSession,
  STATE_COOKIE,
} from "../auth/session.ts";
import { reject } from "./request.ts";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const STATE_BYTES = 32;
const STATE_TTL_SECONDS = 600;
const SIGN_IN_SECRETS = [
  "SESSION_SECRET",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
] as const;

const COOKIE_ATTRIBUTES = { httpOnly: true, secure: true, sameSite: "Lax" } as const;
const SESSION_COOKIE_OPTIONS = { ...COOKIE_ATTRIBUTES, path: "/" } as const;
// Only the callback reads the state back.
const STATE_COOKIE_OPTIONS = { ...COOKIE_ATTRIBUTES, path: "/auth" } as const;

// Sign-in for the one owner: GitHub OAuth, then a signed session cookie that /api/* checks.
export function authRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get("/login", (c) => {
    requireSignInConfig(c.env);
    const state = encodeBase64Url(crypto.getRandomValues(new Uint8Array(STATE_BYTES)));
    setCookie(c, STATE_COOKIE, state, { ...STATE_COOKIE_OPTIONS, maxAge: STATE_TTL_SECONDS });
    const authorize = new URL(AUTHORIZE_URL);
    authorize.searchParams.set("client_id", c.env.GITHUB_OAUTH_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", callbackUrl(c.env));
    authorize.searchParams.set("state", state);
    return c.redirect(authorize.toString());
  });

  routes.get("/callback", async (c) => {
    // Cleared before anything can fail: whatever the outcome, this state has been used.
    deleteCookie(c, STATE_COOKIE, STATE_COOKIE_OPTIONS);
    requireSignInConfig(c.env);
    const state = c.req.query("state");
    const expected = getCookie(c, STATE_COOKIE);
    if (!state || !expected || !sameText(state, expected)) {
      reject(400, "sign-in state does not match");
    }
    const code = c.req.query("code");
    if (!code) reject(400, "missing code");

    const login = await lookUpLogin(c.env, code);
    if (!isOwner(c.env.OWNER_LOGIN, login)) reject(403, "Not on the allowlist");
    const session = await signSession(c.env.SESSION_SECRET, login, Date.now());
    setCookie(c, SESSION_COOKIE, session, {
      ...SESSION_COOKIE_OPTIONS,
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.redirect("/");
  });

  routes.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
    return c.body(null, 204);
  });

  return routes;
}

// Fails closed: with a secret missing, sign-in must not start or finish.
function requireSignInConfig(env: Env): void {
  const missing = SIGN_IN_SECRETS.filter((name) => !env[name]);
  if (missing.length > 0) {
    console.error(`sign-in is not configured: ${missing.join(", ")} not set`);
    reject(500, "sign-in is not configured");
  }
}

const callbackUrl = (env: Env) => `${env.PUBLIC_URL}/auth/callback`;

// The state is a fixed length, so a mismatch in length gives nothing away.
function sameText(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

// The GitHub login behind an OAuth code. Only messages written here reach the log, so nothing
// GitHub sent, the access token above all, can end up in it.
async function lookUpLogin(env: Env, code: string): Promise<string> {
  try {
    const exchange = await requestJson("token exchange", TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
        code,
        redirect_uri: callbackUrl(env),
      }),
    });
    const token = exchange.access_token;
    if (typeof token !== "string" || token === "") {
      throw new Error("token exchange returned no access token");
    }
    const user = await requestJson("user lookup", `${env.GITHUB_API}/user`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "basetobase" },
    });
    if (typeof user.login !== "string" || user.login === "") {
      throw new Error("user lookup returned no login");
    }
    return user.login;
  } catch (error) {
    console.error(`sign-in: ${error instanceof Error ? error.message : "failed"}`);
    return reject(502, "could not complete sign-in with GitHub");
  }
}

async function requestJson(
  step: string,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, init).catch(() => undefined);
  if (!res?.ok) throw new Error(`${step} failed: ${res?.status ?? "no response"}`);
  const body: unknown = await res.json().catch(() => null);
  if (typeof body !== "object" || body === null) throw new Error(`${step} returned no JSON`);
  return body as Record<string, unknown>;
}
