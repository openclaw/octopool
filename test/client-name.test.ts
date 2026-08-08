import { describe, expect, it } from "vitest";
import { normalizeClientName } from "../src/client-name";

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
