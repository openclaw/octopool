export type GitHubRate = {
  limit?: number;
  remaining?: number;
  resetAt?: number;
  retryAfter?: number;
};

export function rateFromHeaders(headers: Record<string, string>): GitHubRate {
  const out: GitHubRate = {};
  const limit = parseRateHeaderInt(headers["x-ratelimit-limit"]);
  const remaining = parseRateHeaderInt(headers["x-ratelimit-remaining"]);
  const resetAt = parseRateHeaderInt(headers["x-ratelimit-reset"]);
  const retryAfter = parseRateHeaderInt(headers["retry-after"]);
  if (limit !== undefined) {
    out.limit = limit;
  }
  if (remaining !== undefined) {
    out.remaining = remaining;
  }
  // An invalid supplied limit must not become an apparently complete observation
  // with default metadata at the coordinator. Keep valid remaining for fallback.
  if (
    isRateSeconds(resetAt) &&
    resetAt > 0 &&
    (headers["x-ratelimit-limit"] === undefined || limit !== undefined)
  ) {
    out.resetAt = resetAt;
  }
  if (isRateSeconds(retryAfter)) {
    out.retryAfter = retryAfter;
  }
  return out;
}

export function parseRateHeaderInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "" || /[^0-9]/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return isRateInteger(parsed) ? parsed : undefined;
}

export function isRateInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isRateSeconds(value: unknown): value is number {
  return isRateInteger(value) && Number.isSafeInteger(value * 1000);
}
