import { describe, expect, it } from "vitest";
import { parsePositiveInt } from "../src/http";
import { requestTimeoutMs, responseCapBytes } from "../src/github-limits";

describe("positive integer configuration", () => {
  it.each([
    ["1", 1],
    [" 15000 ", 15000],
    ["00016", 16],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])("accepts the complete decimal value %s", (value, expected) => {
    expect(parsePositiveInt(String(value), 42)).toBe(expected);
  });

  it.each([
    undefined,
    "",
    "   ",
    "0",
    "-1",
    "+1",
    "1.5",
    "2MiB",
    "15s",
    "16workers",
    "1e3",
    "0x10",
    "Infinity",
    "NaN",
    "9007199254740992",
    "9".repeat(400),
  ])("uses the supplied default for invalid value %s", (value) => {
    expect(parsePositiveInt(value, 42)).toBe(42);
  });

  it("retains operational defaults rather than truncating suffixed values", () => {
    const env = { MAX_RESPONSE_BYTES: "2MiB", REQUEST_TIMEOUT_MS: "15s" } as unknown as Env;
    expect(responseCapBytes(env)).toBe(2_097_152);
    expect(requestTimeoutMs(env)).toBe(15_000);
  });
});
