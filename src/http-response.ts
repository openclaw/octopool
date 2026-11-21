import { backendOverloadedError, HttpError } from "./http";
import { relayPhase } from "./relay-timing";

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  using _phase = relayPhase("response_encode");
  const response = Response.json(body, { status, headers: headers ?? {} });
  if (!response.headers.has("cache-control")) response.headers.set("cache-control", "no-store");
  return response;
}

export function errorResponse(error: unknown, requestId?: string): Response {
  const failure = error instanceof HttpError ? error : backendOverloadedError(error);
  return jsonResponse(
    {
      error: {
        code: failure === undefined ? "internal_error" : failure.code,
        message: failure === undefined ? "Internal error" : failure.message,
        request_id: requestId,
        ...(failure?.details === undefined ? {} : { details: failure.details }),
      },
    },
    failure === undefined ? 500 : failure.status,
  );
}

const MAX_UNEXPECTED_ERROR_FRAMES = 5;
const MAX_STACK_SCAN_CHARS = 8_192;
const STACK_LOCATION = /\.([cm]?[jt]sx?):(\d{1,8}):(\d{1,6})\)?\s*$/;

const REQUEST_ERROR_CODES = new Set([
  "admin_unconfigured",
  "fallback_local",
  "github_identity_mismatch",
  "github_identity_required",
  "invalid_admin_auth",
  "invalid_auth",
  "invalid_headers",
  "invalid_json",
  "invalid_path",
  "invalid_query",
  "invalid_request",
  "invalid_string_rewrite_policy",
  "method_denied",
  "missing_auth",
  "org_denied",
  "org_member_denied",
  "org_verification_failed",
  "org_verification_unavailable",
  "pool_not_found",
  "pool_policy_unavailable",
  "relay_overloaded",
  "string_rewrite_denied",
  "string_rewrite_policy_unavailable",
  "string_rewrite_revision_conflict",
  "unsupported_media_type",
]);

export function logExpectedWorkerError(
  request: Request,
  requestId: string,
  error: unknown,
  started: number,
): void {
  const typed = error instanceof HttpError ? error : backendOverloadedError(error);
  if (typed === undefined) {
    return;
  }
  const pathname = new URL(request.url).pathname;
  let routeFamily: "relay" | "caller_policy" | "admin_policy";
  if (request.method === "POST" && pathname === "/v1/github/request") {
    routeFamily = "relay";
  } else if (request.method === "GET" && /^\/v1\/pools\/[^/]+\/string-rewrites$/.test(pathname)) {
    routeFamily = "caller_policy";
  } else if (
    (request.method === "GET" || request.method === "PUT") &&
    pathname === "/v1/admin/string-rewrites"
  ) {
    routeFamily = "admin_policy";
  } else {
    return;
  }
  // Admission can fail before a trusted caller/pool exists for D1 auditing.
  // Keep this event content-free, including unknown future HttpError codes.
  console.error({
    event: "octopool.worker.request_error",
    request_id: requestId,
    route_family: routeFamily,
    method: request.method,
    status: typed.status,
    code: REQUEST_ERROR_CODES.has(typed.code) ? typed.code : "http_error",
    duration_ms: Math.max(0, Date.now() - started),
  });
}

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
