import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedConfigLookup,
  clearConfigCache,
  invalidateConfigValue,
  withConfigCacheScope,
} from "../src/config-cache";

describe("configuration cache", () => {
  beforeEach(clearConfigCache);
  afterEach(() => {
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("runs its own loader when another request has an unresolved lookup", async () => {
    void cachedConfigLookup("policy:abandoned", () => new Promise<string>(() => {}));
    const load = vi.fn(async () => "independent");
    const follower = cachedConfigLookup("policy:abandoned", load);
    await Promise.resolve();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    await expect(follower).resolves.toBe("independent");
  });

  it("isolates live request scopes and keeps the first settled value when a peer finishes late", async () => {
    const gate = Promise.withResolvers<string>();
    const old = withConfigCacheScope(() =>
      cachedConfigLookup("policy:fixture", () => gate.promise),
    );
    const load = vi.fn(async () => "independent");
    await expect(
      withConfigCacheScope(() => cachedConfigLookup("policy:fixture", load)),
    ).resolves.toBe("independent");
    gate.resolve("old");
    await expect(old).resolves.toBe("old");
    await expect(cachedConfigLookup("policy:fixture", load)).resolves.toBe("independent");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not republish an invalidated value from an older concurrent load", async () => {
    const gate = Promise.withResolvers<object>();
    const old = cachedConfigLookup("caller:fixture", () => gate.promise);
    const rejected = await cachedConfigLookup("caller:fixture", async () => ({}));
    invalidateConfigValue("caller:fixture", rejected);
    gate.resolve({ stale: true });
    await old;
    const load = vi.fn(async () => ({ repaired: true }));
    await expect(cachedConfigLookup("caller:fixture", load)).resolves.toEqual({ repaired: true });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("bounds settled values and fences pending loads across capacity eviction", async () => {
    const gate = Promise.withResolvers<string>();
    const old = cachedConfigLookup("policy:pending", () => gate.promise);
    for (let index = 0; index < 257; index++) {
      await cachedConfigLookup(`policy:${index}`, async () => "ready");
    }
    gate.resolve("old");
    await old;
    const load = vi.fn(async () => "reloaded");
    await expect(cachedConfigLookup("policy:0", load)).resolves.toBe("reloaded");
    await expect(cachedConfigLookup("policy:pending", load)).resolves.toBe("reloaded");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("measures TTL from load start and never caches an already expired completion", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const gate = Promise.withResolvers<string>();
    const old = cachedConfigLookup("policy:fixture", () => gate.promise);
    clock.mockReturnValue(30_000);
    gate.resolve("expired");
    await expect(old).resolves.toBe("expired");
    const load = vi.fn(async () => "fresh");
    await expect(cachedConfigLookup("policy:fixture", load)).resolves.toBe("fresh");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent cold loads within one request without joining unrelated keys", async () => {
    const gate = Promise.withResolvers<string>();
    const load = vi.fn(() => gate.promise);
    const requests = withConfigCacheScope(() =>
      Array.from({ length: 32 }, () => cachedConfigLookup("policy:fixture", load)),
    );
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
    const requests = withConfigCacheScope(() =>
      Array.from({ length: 32 }, () => cachedConfigLookup("policy:fixture", load)),
    );
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
