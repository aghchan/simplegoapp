import { describe, expect, it } from "vitest";
import {
  encodeBase64Url,
  isOwner,
  readSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  signSession,
} from "../src/auth/session.ts";

const SECRET = "k";
const encoder = new TextEncoder();

const cookieOf = (value: string) => `${SESSION_COOKIE}=${value}`;

// A cookie with a valid signature over any payload text, for payloads signSession never produces.
async function forge(payload: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return cookieOf(`${payload}.${encodeBase64Url(new Uint8Array(mac))}`);
}

const forgeClaims = (claims: unknown) =>
  forge(encodeBase64Url(encoder.encode(JSON.stringify(claims))));

// Replaces the first character of a segment with a different one.
function tamper(value: string, segment: 0 | 1): string {
  const parts = value.split(".");
  const part = parts[segment]!;
  parts[segment] = `${part[0] === "A" ? "B" : "A"}${part.slice(1)}`;
  return parts.join(".");
}

describe("session cookie", () => {
  it("round-trips", async () => {
    const value = await signSession(SECRET, "aghchan", 0);
    expect(await readSession(SECRET, cookieOf(value), 1)).toBe("aghchan");
  });

  it("keeps the login as signed", async () => {
    const value = await signSession(SECRET, "AghChan", 0);
    expect(await readSession(SECRET, cookieOf(value), 1)).toBe("AghChan");
  });

  it("is found among other cookies", async () => {
    const value = await signSession(SECRET, "aghchan", 0);
    const header = `theme=dark; ${cookieOf(value)}; other=1`;
    expect(await readSession(SECRET, header, 1)).toBe("aghchan");
  });

  it("is null without the cookie", async () => {
    const value = await signSession(SECRET, "aghchan", 0);
    expect(await readSession(SECRET, null, 1)).toBeNull();
    expect(await readSession(SECRET, "", 1)).toBeNull();
    expect(await readSession(SECRET, `other=${value}`, 1)).toBeNull();
  });

  it.each([0, 1] as const)("is null when segment %i is tampered with", async (segment) => {
    const value = await signSession(SECRET, "aghchan", 0);
    expect(await readSession(SECRET, cookieOf(tamper(value, segment)), 1)).toBeNull();
  });

  it("is null under another secret", async () => {
    const value = await signSession(SECRET, "aghchan", 0);
    expect(await readSession("other", cookieOf(value), 1)).toBeNull();
  });

  it("expires after the time to live", async () => {
    const cookie = cookieOf(await signSession(SECRET, "aghchan", 0));
    expect(await readSession(SECRET, cookie, SESSION_TTL_MS - 1)).toBe("aghchan");
    expect(await readSession(SECRET, cookie, SESSION_TTL_MS)).toBeNull();
    expect(await readSession(SECRET, cookie, SESSION_TTL_MS + 1)).toBeNull();
  });

  // A Worker secret that was never set arrives as undefined, not as an empty string.
  const unsetSecrets: [string, string][] = [
    ["empty", ""],
    ["unset", undefined as unknown as string],
  ];

  it.each(unsetSecrets)("is null for an %s secret, whatever the cookie", async (_name, secret) => {
    const value = await signSession(SECRET, "aghchan", 0);
    expect(await readSession(secret, cookieOf(value), 1)).toBeNull();
    expect(
      await readSession(secret, await forgeClaims({ login: "aghchan", exp: 9e12 }), 1),
    ).toBeNull();
    expect(await readSession(secret, cookieOf("e30.AAAA"), 1)).toBeNull();
  });

  it.each(unsetSecrets)("refuses to sign with an %s secret", async (_name, secret) => {
    await expect(signSession(secret, "aghchan", 0)).rejects.toThrow("session secret");
  });

  describe("malformed", () => {
    const valid = { login: "aghchan", exp: 9e12 };

    it.each<[string, () => Promise<string>]>([
      ["no segments", async () => cookieOf("")],
      ["one segment", async () => cookieOf("abc")],
      ["three segments", async () => cookieOf(`${await signSession(SECRET, "aghchan", 0)}.x`)],
      ["a signature that is not base64url", async () => cookieOf("e30.!!!")],
      ["a signature that is not base64 at all", async () => cookieOf("e30.a")],
      ["an empty signature", async () => cookieOf("e30.")],
      ["a payload that is not base64url", async () => forge("bad!payload")],
      ["a payload that is not JSON", () => forge(encodeBase64Url(encoder.encode("{nope")))],
      ["JSON null", () => forgeClaims(null)],
      ["a JSON string", () => forgeClaims("aghchan")],
      ["a JSON array", () => forgeClaims(["aghchan", 9e12])],
      ["no login", () => forgeClaims({ exp: valid.exp })],
      ["a numeric login", () => forgeClaims({ login: 7, exp: valid.exp })],
      ["an empty login", () => forgeClaims({ login: "", exp: valid.exp })],
      ["no expiry", () => forgeClaims({ login: valid.login })],
      ["a string expiry", () => forgeClaims({ login: valid.login, exp: "9000000000000" })],
      ["a null expiry", () => forgeClaims({ login: valid.login, exp: null })],
    ])("is null for %s", async (_name, build) => {
      expect(await readSession(SECRET, await build(), 1)).toBeNull();
    });

    it("accepts the forged shape when it is well formed", async () => {
      expect(await readSession(SECRET, await forgeClaims(valid), 1)).toBe("aghchan");
    });
  });
});

describe("isOwner", () => {
  it.each(["aghchan", "AGHCHAN", "AghChan"])("accepts %s", (login) => {
    expect(isOwner("aghchan", login)).toBe(true);
  });

  it.each(["eve", "aghchan2", "aghcha", "", " aghchan"])("rejects %j", (login) => {
    expect(isOwner("aghchan", login)).toBe(false);
  });

  it.each<[string, string]>([
    ["empty", ""],
    ["unset", undefined as unknown as string],
  ])("matches nobody when the owner is %s", (_name, owner) => {
    expect(isOwner(owner, "")).toBe(false);
    expect(isOwner(owner, "aghchan")).toBe(false);
  });
});
