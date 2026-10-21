// What wrangler prints when its login has expired or been revoked, rather than when a command
// itself is wrong.
const AUTH_FAILURE =
  /code: 7403|code: 10000|not authenticated|authentication error|invalid access token|token has expired|refresh token/i;

export function isAuthFailure(output: string): boolean {
  return AUTH_FAILURE.test(output);
}
