import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedConfigLookup, clearConfigCache, invalidateConfigValue } from "../src/config-cache";

describe("configuration cache", () => {
  beforeEach(clearConfigCache);
  afterEach(() => {
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("coalesces concurrent cold loads without joining unrelated keys", async () => {
    const gate = Promise.withResolvers<string>();
    const load = vi.fn(() => gate.promise);
    const requests = Array.from({ length: 32 }, () => cachedConfigLookup("policy:fixture", load));
    await expect(cachedConfigLookup("policy:other", async () => "other")).resolves.toBe("other");
    expect(load).toHaveBeenCalledTimes(1);
    gate.resolve("ready");
    expect(await Promise.all(requests)).toEqual(Array(32).fill("ready"));
    await expect(cachedConfigLookup("policy:fixture", load)).resolves.toBe("ready");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retries a shared rejected load without retaining the failure", async () => {
    const gate = Promise.withResolvers<string>();
    const load = vi.fn(() => gate.promise);
    const requests = Array.from({ length: 32 }, () => cachedConfigLookup("policy:fixture", load));
    const settled = Promise.allSettled(requests);
    const failure = new Error("unavailable");
    gate.reject(failure);
    expect(await settled).toEqual(Array(32).fill({ status: "rejected", reason: failure }));
    expect(load).toHaveBeenCalledTimes(1);
    await expect(cachedConfigLookup("policy:fixture", async () => "repaired")).resolves.toBe(
      "repaired",
    );
  });

  it.each(["resolve", "reject"] as const)(
    "does not let a cleared load %s over its replacement",
    async (settle) => {
      const gate = Promise.withResolvers<string>();
      const old = cachedConfigLookup("policy:fixture", () => gate.promise);
      const settled = Promise.allSettled([old]);
      clearConfigCache();
      const load = vi.fn(async () => "replacement");
      await expect(cachedConfigLookup("policy:fixture", load)).resolves.toBe("replacement");
      gate[settle]("old");
      await settled;
      await expect(cachedConfigLookup("policy:fixture", load)).resolves.toBe("replacement");
      expect(load).toHaveBeenCalledTimes(1);
    },
  );

  it("expires pending loads at the original deadline and fences their late completion", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const gate = Promise.withResolvers<string>();
    const old = cachedConfigLookup("policy:fixture", () => gate.promise);
    clock.mockReturnValue(30_000);
    const load = vi.fn(async () => "replacement");
    await expect(cachedConfigLookup("policy:fixture", load)).resolves.toBe("replacement");
    gate.resolve("old");
    await expect(old).resolves.toBe("old");
    clock.mockReturnValue(59_999);
    await expect(cachedConfigLookup("policy:fixture", load)).resolves.toBe("replacement");
    expect(load).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(60_000);
    await cachedConfigLookup("policy:fixture", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("invalidates only the matching value after asynchronous validation fails", async () => {
    const old = await cachedConfigLookup("caller:fixture", async () => ({ id: "old" }));
    clearConfigCache();
    const load = vi.fn(async () => ({ id: "replacement" }));
    const replacement = await cachedConfigLookup("caller:fixture", load);
    invalidateConfigValue("caller:fixture", old);
    expect(await cachedConfigLookup("caller:fixture", load)).toBe(replacement);
    expect(load).toHaveBeenCalledTimes(1);
    invalidateConfigValue("caller:fixture", replacement);
    await cachedConfigLookup("caller:fixture", load);
    expect(load).toHaveBeenCalledTimes(2);
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
