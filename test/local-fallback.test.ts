import { describe, expect, it } from "vitest";
import { HttpError } from "../src/http";
import { githubResponseLocalFallbackReason, localFallbackError } from "../src/local-fallback";

describe("local gh fallback signal", () => {
  it("converts safe relay denials into an explicit fallback response", () => {
    const fallback = localFallbackError(new HttpError(403, "route_denied", "Route is not enabled"));

    expect(fallback?.status).toBe(424);
    expect(fallback?.code).toBe("fallback_local");
    expect(fallback?.details).toMatchObject({ reason: "route_denied" });
  });

  it("converts backend overload errors into a typed retryable fallback", () => {
    const fallback = localFallbackError(
      new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."),
    );

    expect(fallback?.status).toBe(424);
    expect(fallback?.code).toBe("fallback_local");
    expect(fallback?.details).toMatchObject({ reason: "relay_overloaded" });

    expect(localFallbackError(new Error("Durable Object is overloaded"))?.details).toMatchObject({
      reason: "relay_overloaded",
    });
    expect(localFallbackError(new Error("TypeError: fetch failed"))).toBeUndefined();
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
    expect(githubResponseLocalFallbackReason(403, { remaining: 0 })).toBe(
      "github_identity_depleted",
    );
    expect(githubResponseLocalFallbackReason(403, { remaining: 42 })).toBe(
      "github_identity_forbidden",
    );
    expect(githubResponseLocalFallbackReason(429, {})).toBe("github_rate_limited");
    expect(githubResponseLocalFallbackReason(500, {})).toBeUndefined();
  });
});
