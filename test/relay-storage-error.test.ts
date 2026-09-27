import { describe, expect, it } from "vitest";
import { GitHubTransportError } from "../src/github";
import { HttpError } from "../src/http";
import { isTransientRelayStorageError } from "../src/relay-storage-error";

describe("transient relay storage errors", () => {
  it.each([
    "D1_ERROR: Network connection lost.",
    "D1_ERROR: Network connection lost",
    "D1_ERROR: internal error",
    "D1_ERROR: overloaded",
    "D1_ERROR: D1 DB is overloaded. Requests queued for too long.",
    "D1_ERROR: D1 DB is overloaded. Too many requests queued.",
    "D1_ERROR: D1 DB reset because its code was updated.",
    "D1_ERROR: Internal error while starting up D1 DB storage caused object to be reset.",
    "D1_ERROR: Internal error in D1 DB storage caused object to be reset.",
    "D1_ERROR: Cannot resolve D1 DB due to transient issue on remote node.",
    "D1_ERROR: Replica disconnected from primary.",
    "D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.",
    "D1 DB is overloaded. Too many requests queued.",
    "Network connection lost.",
    "Durable Object reset",
    "Durable Object reset because its code was updated.",
    "Durable Object is overloaded",
    "Durable Object is overloaded. Too much data queued.",
    "Durable Object storage operation exceeded timeout which caused object to be reset.",
  ])("recognizes Cloudflare signal: %s", (message) => {
    expect(isTransientRelayStorageError(new Error(message))).toBe(true);
  });

  it.each(["retryable", "overloaded"])("requires the boolean %s flag", (property) => {
    expect(
      isTransientRelayStorageError(Object.assign(new Error("RPC failed"), { [property]: true })),
    ).toBe(true);
    for (const value of [false, "true", 1]) {
      expect(
        isTransientRelayStorageError(Object.assign(new Error("RPC failed"), { [property]: value })),
      ).toBe(false);
    }
  });

  it.each([
    new Error("D1_ERROR: no such table: cache_publication_owners"),
    new Error('D1_ERROR: near "overloaded": syntax error'),
    new Error("D1_TYPE_ERROR: Type 'undefined' not supported"),
    new Error("D1_ERROR: UNIQUE constraint failed"),
    new Error("D1_ERROR: unknown failure"),
    new Error("internal error"),
    new Error("storage timeout"),
    new Error("GitHub is overloaded"),
    new Error("GitHub 503: Network connection lost."),
    new TypeError("Cannot read properties of undefined"),
    new HttpError(503, "github_unavailable", "Network connection lost."),
    Object.assign(new HttpError(503, "string_rewrite_policy_unavailable", "Policy unavailable"), {
      retryable: true,
    }),
    new GitHubTransportError(new Error("Network connection lost.")),
    new Error("unrecognized wrapper", { cause: new Error("D1_ERROR: Network connection lost.") }),
    { status: 503, body: { message: "Network connection lost." } },
    { retryable: true },
    "D1_ERROR: Network connection lost.",
    null,
    undefined,
  ])("does not classify unknown, upstream, or policy errors: %s", (error) => {
    expect(isTransientRelayStorageError(error)).toBe(false);
  });
});
