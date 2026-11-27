import { isRecord } from "./object";

export class GitHubTransportError extends Error {
  constructor(readonly failure: unknown) {
    super("GitHub transport unavailable");
  }
}

export const DEFAULT_GITHUB_API_VERSION = "2022-11-28";

const TRANSIENT_STATUSES = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524]);
const REPRESENTATION_HEADERS = new Set(["etag", "last-modified", "content-length", "link"]);

export function isTransientGitHubStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

export function transformedGitHubHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !REPRESENTATION_HEADERS.has(key.toLowerCase())),
  );
}

const RESPONSE_HEADERS = [
  "etag",
  "last-modified",
  "link",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-resource",
  "x-ratelimit-used",
  "retry-after",
  "x-github-request-id",
];

export function isSecondaryRateLimit(status: number, body: unknown): boolean {
  // GitHub can omit Retry-After on secondary limits. A permission 403 alone
  // is not enough: only the documented error message identifies this scope.
  return (status === 403 || status === 429) && hasSecondaryRateLimitMessage(body);
}

export function hasSecondaryRateLimitMessage(error: unknown): boolean {
  return (
    isRecord(error) &&
    typeof error.message === "string" &&
    /\bsecondary rate\b/i.test(error.message)
  );
}

export function githubResponseHeaders(
  headers: Headers,
  options: { contentType?: string; includeCacheControl?: boolean } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const contentType = options.contentType ?? headers.get("content-type");
  if (contentType !== null && contentType !== undefined) {
    out["content-type"] = contentType;
  }
  for (const key of [
    ...RESPONSE_HEADERS,
    ...(options.includeCacheControl === true ? ["cache-control"] : []),
  ]) {
    const value = headers.get(key);
    if (value !== null) {
      out[key] = value;
    }
  }
  return out;
}

export function defaultGitHubJSONAccept(value: string | undefined, allowBlank = true): boolean {
  if (value === undefined) {
    return true;
  }
  if (value.trim() === "") {
    return allowBlank;
  }
  const normalized = value.toLowerCase();
  return (
    normalized === "application/vnd.github+json" ||
    normalized === "application/json" ||
    normalized === "application/vnd.github.v3+json"
  );
}

export function conditionalHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...(headers?.["if-none-match"] === undefined
      ? {}
      : { "if-none-match": headers["if-none-match"] }),
    ...(headers?.["if-modified-since"] === undefined
      ? {}
      : { "if-modified-since": headers["if-modified-since"] }),
  };
}

export function hasConditionalRequestHeaders(headers: Record<string, string> | undefined): boolean {
  return headers?.["if-none-match"] !== undefined || headers?.["if-modified-since"] !== undefined;
}
