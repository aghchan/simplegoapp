import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// Ends the request with a JSON error. It throws, so a handler can read straight through to the
// response it sends when nothing is wrong.
export function reject(status: ContentfulStatusCode, error: string): never {
  throw new HTTPException(status, { res: Response.json({ error }, { status }) });
}

// Counts as it reads: a chunked body declares no length, so Content-Length cannot bound it.
export async function readBody(req: Request, maxBytes: number): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        reject(413, "request body too large");
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

export function parseJson(body: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return reject(400, "body must be JSON");
  }
}

export async function readJsonObject(
  req: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const json = parseJson(await readBody(req, maxBytes));
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    reject(400, "body must be a JSON object");
  }
  return json as Record<string, unknown>;
}
