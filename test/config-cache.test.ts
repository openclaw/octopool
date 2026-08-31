import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedConfigLookup, clearConfigCache } from "../src/config-cache";

describe("configuration cache", () => {
  beforeEach(clearConfigCache);
  afterEach(() => {
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("retries rejected cold loads immediately and caches only successful values", async () => {
    const failure = new Error("synthetic unavailable configuration");
    const load = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue("repaired");
    await expect(cachedConfigLookup("policy:fixture", load)).rejects.toBe(failure);
    await expect(cachedConfigLookup("policy:fixture", load)).resolves.toBe("repaired");
    await expect(cachedConfigLookup("policy:fixture", load)).resolves.toBe("repaired");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not extend or serve an expired success when a reload fails", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const load = vi
      .fn()
      .mockResolvedValueOnce("valid")
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce("repaired");
    await expect(cachedConfigLookup("policy:fixture", load)).resolves.toBe("valid");
    clock.mockReturnValue(29_999);
    await expect(cachedConfigLookup("policy:fixture", load)).resolves.toBe("valid");
    expect(load).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(30_000);
    await expect(cachedConfigLookup("policy:fixture", load)).rejects.toThrow("unavailable");
    await expect(cachedConfigLookup("policy:fixture", load)).resolves.toBe("repaired");
    expect(load).toHaveBeenCalledTimes(3);
  });
});
