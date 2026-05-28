import { describe, expect, it } from "vitest";
import { HttpError } from "../src/http";
import {
  githubResponseLocalFallbackReason,
  githubResponseNeedsLocalFallback,
  localFallbackError,
} from "../src/local-fallback";

describe("local gh fallback signal", () => {
  it("converts safe relay denials into an explicit fallback response", () => {
    const fallback = localFallbackError(new HttpError(403, "route_denied", "Route is not enabled"));

    expect(fallback?.status).toBe(424);
    expect(fallback?.code).toBe("fallback_local");
    expect(fallback?.details).toMatchObject({ reason: "route_denied" });
  });

  it("does not hide auth or malformed-request failures behind local fallback", () => {
    expect(localFallbackError(new HttpError(401, "missing_auth", "Missing bearer token"))).toBe(
      undefined,
    );
    expect(localFallbackError(new HttpError(400, "invalid_query", "query key token"))).toBe(
      undefined,
    );
  });

  it("falls back when the pooled GitHub identity is unusable", () => {
    expect(githubResponseLocalFallbackReason(401, {})).toBe("github_identity_unauthorized");
    expect(githubResponseNeedsLocalFallback(403, { remaining: 0 })).toBe(true);
    expect(githubResponseNeedsLocalFallback(403, { remaining: 42 })).toBe(true);
    expect(githubResponseNeedsLocalFallback(429, {})).toBe(true);
    expect(githubResponseNeedsLocalFallback(500, {})).toBe(false);
  });
});
