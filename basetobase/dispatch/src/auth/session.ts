import { parse } from "hono/utils/cookie";

export const SESSION_COOKIE = "b2b_session";
export const STATE_COOKIE = "b2b_oauth_state";
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

const encoder = new TextEncoder();

// The cookie value is `base64url(JSON{login,exp}).base64url(HMAC-SHA-256 of the first part)`.
export async function signSession(secret: string, login: string, now: number): Promise<string> {
  const payload = encodeBase64Url(
    encoder.encode(JSON.stringify({ login, exp: now + SESSION_TTL_MS })),
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(payload),
  );
  return `${payload}.${encodeBase64Url(new Uint8Array(mac))}`;
}

// The signed-in login, or null for anything that is not a live session this secret signed.
export async function readSession(
  secret: string,
  cookieHeader: string | null,
  now: number,
): Promise<string | null> {
  // `!secret`, not `=== ""`: a Worker secret that was never set arrives as undefined.
  if (!secret || cookieHeader === null) return null;
  const value = parse(cookieHeader, SESSION_COOKIE)[SESSION_COOKIE];
  const [payload, signature, ...extra] = value?.split(".") ?? [];
  if (payload === undefined || signature === undefined || extra.length > 0) return null;
  const mac = decodeBase64Url(signature);
  if (mac === null) return null;
  const key = await hmacKey(secret, "verify");
  if (!(await crypto.subtle.verify("HMAC", key, mac, encoder.encode(payload)))) return null;

  const claims = parseClaims(payload);
  if (claims === null || claims.exp <= now) return null;
  return claims.login;
}

// GitHub logins are case-insensitive. A blank or unset owner matches nobody.
export function isOwner(ownerLogin: string, login: string): boolean {
  return !!ownerLogin && login.toLowerCase() === ownerLogin.toLowerCase();
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  if (!secret) throw new Error("the session secret is not set");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

// The payload is read only after its signature checked out, but a signed payload this code did
// not write is still not trusted to have the right shape.
function parseClaims(payload: string): { login: string; exp: number } | null {
  const bytes = decodeBase64Url(payload);
  if (bytes === null) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const { login, exp } = claims as Record<string, unknown>;
  return typeof login === "string" && login !== "" && typeof exp === "number"
    ? { login, exp }
    : null;
}
