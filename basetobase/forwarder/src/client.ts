import { readFile } from "node:fs/promises";
import type { AgentBrief, AgentEvent } from "../../shared/src/types.ts";

const REQUEST_TIMEOUT_MS = 120_000;
const TOKEN_TTL_MS = 240_000;
const ERROR_BODY_MAX = 200;

export interface DispatchClient {
  brief(): Promise<AgentBrief>;
  events(b: AgentEvent[]): Promise<void>;
  verdict(v: unknown): Promise<void>;
  failure(reason: string): Promise<void>;
  transcript(path: string): Promise<void>;
}

// A response Dispatch gave that was not a success. `permanent` marks the ones that sending the same
// request again cannot fix (a 4xx other than 408 and 429); the batcher drops those batches.
export class DispatchError extends Error {
  readonly status: number;
  readonly permanent: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
}

// Messages carry the method, the path and Dispatch's answer, never the query string: it holds the
// nonce.
export function createDispatchClient(o: {
  baseUrl: string;
  runId: string;
  agentId: string;
  nonce: string;
  // `true` asks for a token that has not been cached, after Dispatch refused the last one.
  token: (fresh?: boolean) => Promise<string>;
  fetch?: typeof fetch;
}): DispatchClient {
  const doFetch = o.fetch ?? fetch;
  const identity = { run_id: o.runId, agent_id: o.agentId, nonce: o.nonce };

  async function call(
    method: "GET" | "POST" | "PUT",
    endpoint: string,
    request: { identityInQuery?: boolean; body?: string | Uint8Array; contentType?: string } = {},
  ): Promise<Response> {
    const url = new URL(`/agent/${endpoint}`, o.baseUrl);
    if (request.identityInQuery) {
      for (const [name, value] of Object.entries(identity)) url.searchParams.set(name, value);
    }

    async function attempt(freshToken: boolean): Promise<Response> {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await o.token(freshToken)}`,
      };
      if (request.contentType) headers["Content-Type"] = request.contentType;
      try {
        return await doFetch(url.href, {
          method,
          headers,
          body: request.body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error(`${method} ${url.pathname} failed: ${networkReason(error)}`);
      }
    }

    let response = await attempt(false);
    if (response.status === 401) {
      await response.body?.cancel();
      response = await attempt(true);
    }
    if (!response.ok) {
      const answer = (await response.text().catch(() => "")).trim().slice(0, ERROR_BODY_MAX);
      throw new DispatchError(
        `${method} ${url.pathname} → ${response.status}${answer && `: ${answer}`}`,
        response.status,
      );
    }
    return response;
  }

  async function post(endpoint: string, fields: object): Promise<void> {
    await call("POST", endpoint, {
      body: JSON.stringify({ ...identity, ...fields }),
      contentType: "application/json",
    });
  }

  return {
    async brief() {
      const response = await call("GET", "brief", { identityInQuery: true });
      return (await response.json()) as AgentBrief;
    },
    events: (events) => post("events", { events }),
    verdict: (verdict) => post("verdict", { verdict }),
    failure: (reason) => post("failure", { reason }),
    async transcript(path) {
      await call("PUT", "transcript", {
        identityInQuery: true,
        body: await readFile(path),
        contentType: "application/x-ndjson",
      });
    },
  };
}

function networkReason(error: unknown): string {
  if (!(error instanceof Error)) return "request failed";
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

export function githubOidcToken(
  env: Record<string, string | undefined>,
  audience: string,
  f: typeof fetch = fetch,
): (fresh?: boolean) => Promise<string> {
  let cached: { token: Promise<string>; fetchedAt: number } | undefined;
  return (fresh = false) => {
    if (fresh || !cached || Date.now() - cached.fetchedAt >= TOKEN_TTL_MS) {
      const entry = { token: requestToken(env, audience, f), fetchedAt: Date.now() };
      cached = entry;
      // A failure is not kept; the caller sees it through the returned promise.
      entry.token.catch(() => {
        if (cached === entry) cached = undefined;
      });
    }
    return cached.token;
  };
}

async function requestToken(
  env: Record<string, string | undefined>,
  audience: string,
  f: typeof fetch,
): Promise<string> {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) {
    // Waiting does not set a variable, so the callers that retry are told not to.
    throw Object.assign(
      new Error("ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN are not set"),
      { permanent: true },
    );
  }
  let response: Response;
  try {
    response = await f(`${url}&audience=${encodeURIComponent(audience)}`, {
      headers: { Authorization: `bearer ${bearer}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`OIDC token request failed: ${networkReason(error)}`);
  }
  if (!response.ok) throw new Error(`OIDC token request failed: ${response.status}`);
  const { value } = (await response.json()) as { value?: unknown };
  if (typeof value !== "string" || value === "")
    throw new Error("OIDC token response has no value");
  return value;
}
