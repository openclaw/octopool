import { describe, expect, it } from "vitest";
import { normalizeClientName, parseClientName } from "../src/client-name";

describe("client name normalization", () => {
  it.each([
    ["clawstudio.local", "clawstudio"],
    ["clawstudio.LOCAL", "clawstudio"],
    ["  clawstudio.local  ", "clawstudio"],
    ["clawstudio", "clawstudio"],
    ["local", "local"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeClientName(input)).toBe(expected);
  });
});

describe("client name validation", () => {
  it("returns normalized hostname-safe names", () => {
    expect(parseClientName("  ci-runner.local  ")).toBe("ci-runner");
  });

  it.each(["", "not a hostname", "-leading-dash", "a".repeat(81)])(
    "rejects invalid name %j",
    (input) => {
      expect(() => parseClientName(input)).toThrowError(
        expect.objectContaining({ status: 400, code: "client_name_invalid" }),
      );
    },
  );
});

describe("fixed-point client names", () => {
  it.each([
    ["Host.LoCaL.local.LOCAL", "Host"],
    ["local.local.local", "local"],
    [".local.local", ".local"],
    ["Host.locality.local", "Host.locality"],
    ["Host.local-x.local", "Host.local-x"],
    ["  Host.local.local\t", "Host"],
    ["legacy", "legacy"],
    ["admin", "admin"],
    ["unknown", "unknown"],
  ])("normalizes %s idempotently", (input, expected) => {
    expect(normalizeClientName(input)).toBe(expected);
    expect(normalizeClientName(normalizeClientName(input))).toBe(expected);
  });

  it("normalizes long suffix chains without shortening the base", () => {
    expect(parseClientName("a".repeat(80) + ".local".repeat(10_000))).toBe("a".repeat(80));
  });

  it("validates after normalization without truncating explicit inputs", () => {
    expect(parseClientName("a".repeat(80) + ".local.local")).toBe("a".repeat(80));
    expect(parseClientName("host..local")).toBe("host.");
    for (const input of [
      "a".repeat(81) + ".local.local",
      ".local.local",
      "host/path.local",
      1,
      null,
    ]) {
      expect(() => parseClientName(input)).toThrowError(
        expect.objectContaining({ code: "client_name_invalid" }),
      );
    }
  });
});
