export const DEFAULT_JSON_BODY_LIMIT = 32 * 1024;

export class RequestBodyError extends Error {
  readonly status: 400 | 413 | 415;

  constructor(message: string, status: 400 | 413 | 415) {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
  }
}

function bodyLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("JSON body limit must be a positive safe integer");
  }
  return value;
}

// Read an object-shaped JSON request without allowing a missing Content-Length header to bypass the
// byte limit. Route handlers use this before dereferencing fields, so valid JSON primitives such as
// `null` and `[]` become a deterministic 400 instead of an uncaught TypeError/500.
export async function readJsonObject(
  req: Request,
  maxBytes = DEFAULT_JSON_BODY_LIMIT,
): Promise<Record<string, unknown>> {
  const limit = bodyLimit(maxBytes);
  if (!req.body) throw new RequestBodyError("Invalid JSON body", 400);

  const mediaType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType)) {
    throw new RequestBodyError("Content-Type must be application/json", 415);
  }

  const declared = req.headers.get("content-length")?.trim();
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    throw new RequestBodyError(`JSON body exceeds the ${limit}-byte limit`, 413);
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyError(`JSON body exceeds the ${limit}-byte limit`, 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError("Invalid JSON body", 400);
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestBodyError("Invalid JSON body", 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestBodyError("JSON body must be an object", 400);
  }
  return parsed as Record<string, unknown>;
}

export function requestBodyFailure(error: unknown): { error: string; status: 400 | 413 | 415 } {
  return error instanceof RequestBodyError
    ? { error: error.message, status: error.status }
    : { error: "Invalid JSON body", status: 400 };
}

// Browser state mutations must come from this exact origin. Non-browser clients may omit Fetch
// Metadata and Origin; browsers cannot do that for a cross-site POST, so an explicit mismatch or
// cross-site/same-site Fetch Metadata value is rejected. This keeps zero-config local/open mode
// usable without turning localhost APIs into CSRF targets.
export function browserMutationFailure(req: Request): { error: string; status: 403 } | null {
  const suppliedOrigin = req.headers.get("origin")?.trim();
  if (suppliedOrigin) {
    // Behind a TLS-terminating reverse proxy, `req.url` keeps the loopback origin the Node server
    // was bound to, so the public origin must be allowed explicitly via APP_URL. Deployments reached
    // through more than one hostname list the others in APP_EXTRA_ORIGINS (comma-separated).
    const allowed = new Set([new URL(req.url).origin]);
    for (const configured of [process.env.APP_URL, ...(process.env.APP_EXTRA_ORIGINS?.split(",") ?? [])]) {
      if (!configured?.trim()) continue;
      try {
        allowed.add(new URL(configured.trim()).origin);
      } catch {
        // An unparsable configured origin simply adds nothing.
      }
    }
    try {
      if (!allowed.has(new URL(suppliedOrigin).origin)) {
        return { error: "Cross-origin request is not allowed", status: 403 };
      }
    } catch {
      return { error: "Cross-origin request is not allowed", status: 403 };
    }
    return null;
  }

  const fetchSite = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return { error: "Cross-origin request is not allowed", status: 403 };
  }
  return null;
}
