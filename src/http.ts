import { isRecord } from "./object";
import type { JsonObject } from "./types";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: JsonObject,
  ) {
    super(message);
  }
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...headers,
    },
  });
}

// D1 and Durable Objects throw untyped Errors when their request queues back up
// ("D1 DB is overloaded. Requests queued for too long."). Without this mapping the
// worker boundary reports internal_error 500, which callers cannot distinguish
// from a bug and therefore never retry or fall back on.
export function backendOverloadedError(error: unknown): HttpError | undefined {
  if (error instanceof HttpError || !(error instanceof Error)) {
    return undefined;
  }
  if (!/is overloaded|queued for too long/i.test(error.message)) {
    return undefined;
  }
  return new HttpError(503, "relay_overloaded", "Octopool backend is overloaded; retry shortly");
}

export function errorResponse(error: unknown, requestId?: string): Response {
  const overloaded = backendOverloadedError(error);
  if (overloaded !== undefined) {
    error = overloaded;
  }
  if (error instanceof HttpError) {
    return jsonResponse(
      {
        error: {
          code: error.code,
          message: error.message,
          request_id: requestId,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
      error.status,
    );
  }
  return jsonResponse(
    {
      error: {
        code: "internal_error",
        message: "Internal error",
        request_id: requestId,
      },
    },
    500,
  );
}

const MAX_UNEXPECTED_ERROR_FRAMES = 5;
const MAX_STACK_SCAN_CHARS = 8_192;
const STACK_LOCATION = /\.([cm]?[jt]sx?):(\d{1,8}):(\d{1,6})\)?\s*$/;

function safeErrorName(error: Error): string {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof ReferenceError) return "ReferenceError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof URIError) return "URIError";
  if (error instanceof EvalError) return "EvalError";
  return "Error";
}

function safeErrorFrames(error: Error): { extension: string; line: number; column: number }[] {
  let stack: unknown;
  try {
    stack = error.stack;
  } catch {
    return [];
  }
  if (typeof stack !== "string") {
    return [];
  }
  const frames: { extension: string; line: number; column: number }[] = [];
  for (const rawLine of stack.slice(0, MAX_STACK_SCAN_CHARS).split("\n")) {
    const match = STACK_LOCATION.exec(rawLine);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
      continue;
    }
    const line = Number(match[2]);
    const column = Number(match[3]);
    if (line < 1 || column < 1) {
      continue;
    }
    frames.push({ extension: match[1], line, column });
    if (frames.length === MAX_UNEXPECTED_ERROR_FRAMES) {
      break;
    }
  }
  return frames;
}

export function logUnexpectedWorkerError(
  request: Request,
  requestId: string,
  error: unknown,
): void {
  if (error instanceof HttpError || backendOverloadedError(error) !== undefined) {
    return;
  }
  const frames = error instanceof Error ? safeErrorFrames(error) : [];
  const detail = {
    name: error instanceof Error ? safeErrorName(error) : "NonErrorThrown",
    ...(error instanceof Error ? {} : { type: typeof error }),
    ...(frames.length === 0 ? {} : { frames }),
  };
  // request_id is always client-visible; relay-owned failures also join D1 audit metadata.
  console.error({
    event: "octopool.worker.unexpected_exception",
    code: "internal_error",
    request_id: requestId,
    method: request.method,
    pathname: new URL(request.url).pathname,
    error: detail,
  });
}

export async function parseJsonObject(request: Request): Promise<JsonObject> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected application/json");
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Expected a valid JSON object");
  }
  if (!isRecord(value)) {
    throw new HttpError(400, "invalid_json", "Expected a JSON object");
  }
  return value;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "invalid_request", `${field} must be a non-empty string`);
  }
  return value.trim();
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function requestBearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match?.[1] === undefined || match[1].trim() === "") {
    throw new HttpError(401, "missing_auth", "Missing bearer token");
  }
  return match[1].trim();
}

export function routeParam(pathname: string, pattern: RegExp, field: string): string {
  const match = pattern.exec(pathname);
  const value = match?.groups?.[field];
  if (value === undefined || value === "") {
    throw new HttpError(404, "not_found", "Route not found");
  }
  return value;
}
