import { jwtVerify, type JWTVerifyGetKey } from "jose";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

// Throws unless the token was issued by GitHub Actions to a dispatched run of this repository's
// agent workflow, for this audience. The caller must not say which check failed.
export async function verifyAgentToken(
  token: string,
  o: { audience: string; repo: string; workflow: string; getKey: JWTVerifyGetKey },
): Promise<{ githubRunId: string }> {
  const { payload } = await jwtVerify(token, o.getKey, {
    issuer: GITHUB_OIDC_ISSUER,
    audience: o.audience,
    algorithms: ["RS256"],
  });
  const { repository, workflow_ref: workflowRef, event_name: eventName, run_id: runId } = payload;
  // The "@" ends the file name, so a workflow whose name merely begins with ours does not match.
  const workflowPrefix = `${o.repo}/.github/workflows/${o.workflow}@`;
  if (
    repository !== o.repo ||
    typeof workflowRef !== "string" ||
    !workflowRef.startsWith(workflowPrefix) ||
    eventName !== "workflow_dispatch" ||
    typeof runId !== "string" ||
    runId === ""
  ) {
    throw new Error("the token is not for the agent workflow");
  }
  return { githubRunId: runId };
}
