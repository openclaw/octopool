import { rateFromHeaders } from "./github";
import { HttpError } from "./http";

export function localFallbackError(error: unknown): HttpError | undefined {
  if (!(error instanceof HttpError) || !localFallbackReasons.has(error.code)) {
    return undefined;
  }
  return new HttpError(424, "fallback_local", "Run this request with local GitHub credentials", {
    reason: error.code,
  });
}

export function githubResponseNeedsLocalFallback(
  status: number,
  rate: ReturnType<typeof rateFromHeaders>,
): boolean {
  return githubResponseLocalFallbackReason(status, rate) !== undefined;
}

export function githubResponseLocalFallbackReason(
  status: number,
  rate: ReturnType<typeof rateFromHeaders>,
): string | undefined {
  if (status === 401) {
    return "github_identity_unauthorized";
  }
  if (status === 429 || rate.retryAfter !== undefined) {
    return "github_rate_limited";
  }
  if (status === 403 && rate.remaining === 0) {
    return "github_identity_depleted";
  }
  if (status === 403) {
    return "github_identity_forbidden";
  }
  return undefined;
}

const localFallbackReasons = new Set([
  "identities_cooling_down",
  "logs_denied",
  "no_identity",
  "owner_denied",
  "repo_not_public",
  "repo_public_check_failed",
  "route_denied",
  "search_denied",
]);
