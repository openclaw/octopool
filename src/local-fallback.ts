import type { GitHubRate } from "./github-rate";
import { backendOverloadedError, HttpError } from "./http";

export function localFallbackError(error: unknown): HttpError | undefined {
  const typed = error instanceof HttpError ? error : backendOverloadedError(error);
  if (typed === undefined || !localFallbackReasons.has(typed.code)) {
    return undefined;
  }
  return new HttpError(424, "fallback_local", "Run this request with local GitHub credentials", {
    reason: typed.code,
  });
}

export function githubResponseLocalFallbackReason(
  status: number,
  rate: GitHubRate,
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
  // A body over MAX_RESPONSE_BYTES is one the relay can never serve, no matter
  // how often it is retried; the caller's own gh has no such cap, so this is a
  // handoff rather than a failure.
  "github_response_too_large",
  "identities_cooling_down",
  "logs_denied",
  "no_identity",
  "owner_denied",
  "relay_overloaded",
  "repo_not_public",
  "repo_public_check_failed",
  "route_denied",
  "search_denied",
]);
