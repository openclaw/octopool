export type GitHubRate = {
  limit?: number;
  remaining?: number;
  resetAt?: number;
  retryAfter?: number;
};

export function rateFromHeaders(headers: Record<string, string>): GitHubRate {
  const out: GitHubRate = {};
  const limit = parseHeaderInt(headers["x-ratelimit-limit"]);
  const remaining = parseHeaderInt(headers["x-ratelimit-remaining"]);
  const resetAt = parseHeaderInt(headers["x-ratelimit-reset"]);
  const retryAfter = parseHeaderInt(headers["retry-after"]);
  if (limit !== undefined) {
    out.limit = limit;
  }
  if (remaining !== undefined) {
    out.remaining = remaining;
  }
  if (resetAt !== undefined) {
    out.resetAt = resetAt;
  }
  if (retryAfter !== undefined) {
    out.retryAfter = retryAfter;
  }
  return out;
}

function parseHeaderInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
