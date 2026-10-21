import { describe, expect, it } from "vitest";
import { GITHUB_OIDC_ISSUER, verifyAgentToken } from "../src/auth/oidc.ts";
import { agentClaims, agentIdentity, REJECTED_CLAIMS } from "./helpers.ts";

const AUDIENCE = "https://b2b.test";
const identity = await agentIdentity();
const opts = {
  audience: AUDIENCE,
  repo: "aghchan/simplegoapp",
  workflow: "basetobase-agent.yml",
  getKey: identity.getKey,
};
const tok = (over: Record<string, unknown> = {}) => identity.token(agentClaims(AUDIENCE, over));

describe("verifyAgentToken", () => {
  it("accepts the agent workflow", async () =>
    expect(await verifyAgentToken(await tok(), opts)).toEqual({ githubRunId: "99" }));

  it("trusts GitHub's Actions issuer", () =>
    expect(GITHUB_OIDC_ISSUER).toBe("https://token.actions.githubusercontent.com"));

  it("accepts the workflow on any ref", async () => {
    const workflow_ref = "aghchan/simplegoapp/.github/workflows/basetobase-agent.yml@refs/heads/x";
    expect(await verifyAgentToken(await tok({ workflow_ref }), opts)).toEqual({
      githubRunId: "99",
    });
  });

  it.each(REJECTED_CLAIMS)("rejects a wrong %s", async (_name, over) => {
    await expect(verifyAgentToken(await tok(over), opts)).rejects.toThrow();
  });

  it("rejects a token signed with another key", async () => {
    const stranger = await agentIdentity();
    const forged = await stranger.token(agentClaims(AUDIENCE));
    await expect(verifyAgentToken(forged, opts)).rejects.toThrow();
  });

  it.each(["", "not-a-jwt", "a.b.c"])("rejects the malformed token %j", async (token) => {
    await expect(verifyAgentToken(token, opts)).rejects.toThrow();
  });
});
