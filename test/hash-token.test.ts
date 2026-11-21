import { describe, expect, it } from "vitest";
import { hashToken } from "../src/encoding";

describe("persisted SHA-256 hashes", () => {
  it.each([
    ["", "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"],
    ["abc", "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"],
    ["octopool 🐙", "d2AtCK68kOMPQOYMN74JIGNFFeVDsFPlbxAGD_h-NWA"],
  ] as const)("preserves the unpadded base64url digest of %j", async (input, expected) => {
    await expect(hashToken(input)).resolves.toBe(expected);
  });
});
