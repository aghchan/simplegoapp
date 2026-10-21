export class SignedOutError extends Error {}

export const SIGN_IN_URL = "/auth/login";

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (response.status === 401) throw new SignedOutError("signed out");
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

// Its own function so that tests can replace it: jsdom does not let a test spy on location.assign.
export function navigateTo(url: string): void {
  window.location.assign(url);
}
