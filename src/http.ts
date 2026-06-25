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

export function errorResponse(error: unknown, requestId?: string): Response {
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
