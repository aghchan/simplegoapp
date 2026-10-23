export class SignedOutError extends Error {}

export class NotFoundError extends Error {}

export const SIGN_IN_URL = "/auth/login";

async function get(path: string): Promise<Response> {
  const response = await fetch(path);
  if (response.status === 401) throw new SignedOutError("signed out");
  if (response.status === 404) throw new NotFoundError(`${path} not found`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response;
}

export async function getJson<T>(path: string): Promise<T> {
  return (await (await get(path)).json()) as T;
}

export async function getText(path: string): Promise<string> {
  return (await get(path)).text();
}

// The dashboard's one kind of write: asking Dispatch to do something. A refusal's message is
// Dispatch's own reason.
export async function post(path: string): Promise<void> {
  const response = await fetch(path, { method: "POST" });
  if (response.status === 401) throw new SignedOutError("signed out");
  if (response.ok) return;
  const body: unknown = await response.json().catch(() => null);
  const reason = typeof body === "object" && body !== null ? Reflect.get(body, "error") : null;
  throw new Error(typeof reason === "string" ? reason : `${path} answered ${response.status}`);
}

// Its own function so that tests can replace it: jsdom does not let a test spy on location.assign.
export function navigateTo(url: string): void {
  window.location.assign(url);
}
