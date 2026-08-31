import { describe, expect, it } from "vitest";
import { rateFromHeaders } from "../src/github-rate";

describe("GitHub numeric header authority", () => {
  it("accepts whole decimal integers and optional limit metadata", () => {
    expect(
      rateFromHeaders({
        "x-ratelimit-remaining": "0009",
        "x-ratelimit-reset": "1800000000",
        "retry-after": "0",
      }),
    ).toEqual({ remaining: 9, resetAt: 1800000000, retryAfter: 0 });
    expect(
      rateFromHeaders({
        "x-ratelimit-limit": "9007199254740991",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "9007199254740",
      }),
    ).toEqual({ limit: Number.MAX_SAFE_INTEGER, remaining: 0, resetAt: 9007199254740 });
  });

  it.each([
    "",
    "12junk",
    "1e3",
    "1.5",
    "-1",
    "+1",
    " 1",
    "1 ",
    "1\n",
    "NaN",
    "Infinity",
    "9007199254740992",
    "Wed, 21 Oct 2015 07:28:00 GMT",
  ])("rejects unusable integer Retry-After: %s", (value) => {
    expect(rateFromHeaders({ "retry-after": value })).toEqual({});
  });

  it("rejects unsafe seconds-to-milliseconds conversions independently of valid quota", () => {
    expect(
      rateFromHeaders({
        "x-ratelimit-remaining": "9",
        "x-ratelimit-reset": "9007199254741",
        "retry-after": "9007199254741",
      }),
    ).toEqual({ remaining: 9 });
  });
});
