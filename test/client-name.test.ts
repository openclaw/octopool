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
