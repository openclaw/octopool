import { describe, expect, it, vi } from "vitest";
import { coalesceGitHubCacheMiss } from "../src/cache-coalesce";
import { acquireOwnedCacheFill } from "../src/cache-fill";
import type { GitHubCacheRead } from "../src/cache";
import { fakeCacheFillCoordinator } from "./cache-fill-test-support";

describe("cache miss coalescing", () => {
  it("rechecks the cache after becoming the owner", async () => {
    const coordinator = fakeCacheFillCoordinator([{ kind: "owner", token: "leader" }]);
    const readShared = vi.fn(async () => undefined);

    const result = await coalesceGitHubCacheMiss({} as Env, coordinator, "cache-key", {
      readShared,
    });

    expect(result.owner?.capability.owner_token).toBe("leader");
    expect(readShared).toHaveBeenCalledOnce();
    await result.owner?.fail();
    expect(coordinator.completePublication).toHaveBeenCalledWith(
      expect.objectContaining({ owner_token: "leader" }),
      "failed",
      undefined,
    );
  });

  it.each([
    {
      name: "shared-cache recheck",
      readShared: async () => {
        throw new Error("recheck failed");
      },
      acceptCached: undefined,
    },
    {
      name: "cached acceptance",
      readShared: async () => sharedRead(),
      acceptCached: async () => {
        throw new Error("acceptance failed");
      },
    },
  ])("fails an acquired owner when $name throws", async ({ readShared, acceptCached }) => {
    vi.useFakeTimers();
    try {
      const coordinator = fakeCacheFillCoordinator([{ kind: "owner", token: "leader" }]);
      await expect(
        coalesceGitHubCacheMiss({} as Env, coordinator, "cache-key", {
          readShared,
          ...(acceptCached === undefined ? {} : { acceptCached }),
        }),
      ).rejects.toThrow();

      expect(coordinator.completePublication).toHaveBeenCalledWith(
        expect.objectContaining({ owner_token: "leader" }),
        "failed",
        undefined,
      );
      await vi.advanceTimersByTimeAsync(6_000);
      expect(coordinator.renewPublication).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rereads the shared cache once after completion", async () => {
    const coordinator = fakeCacheFillCoordinator([{ kind: "completed", outcome: "shared" }]);
    const readShared = vi.fn(async () => sharedRead());
    const readEdge = vi.fn(async () => undefined);

    const result = await coalesceGitHubCacheMiss({} as Env, coordinator, "cache-key", {
      readShared,
      readEdge,
    });

    expect(result.cached).toMatchObject({ body: { status: "completed" } });
    expect(readShared).toHaveBeenCalledOnce();
    expect(readEdge).not.toHaveBeenCalled();
    expect(coordinator.acquirePublication).toHaveBeenCalledOnce();
  });

  it("serves an edge-only completion from the same colo without D1", async () => {
    const coordinator = fakeCacheFillCoordinator([{ kind: "completed", outcome: "edge_only" }]);
    const readShared = vi.fn(async () => undefined);
    const readEdge = vi.fn(async () => sharedRead().cached);

    const result = await coalesceGitHubCacheMiss({} as Env, coordinator, "cache-key", {
      readShared,
      readEdge,
    });

    expect(result.cached).toMatchObject({ body: { status: "completed" } });
    expect(readEdge).toHaveBeenCalledOnce();
    expect(readShared).not.toHaveBeenCalled();
  });

  it("reacquires immediately after an edge-only remote-colo miss", async () => {
    const coordinator = fakeCacheFillCoordinator([
      { kind: "completed", outcome: "edge_only" },
      { kind: "owner", token: "takeover" },
    ]);
    const readShared = vi.fn(async () => undefined);
    const readEdge = vi.fn(async () => undefined);

    const result = await coalesceGitHubCacheMiss({} as Env, coordinator, "cache-key", {
      readShared,
      readEdge,
    });

    expect(result.owner?.capability.owner_token).toBe("takeover");
    expect(readEdge).toHaveBeenCalledOnce();
    expect(readShared).toHaveBeenCalledOnce();
    expect(coordinator.acquirePublication).toHaveBeenCalledTimes(2);
    await result.owner?.fail();
  });

  it("does not read either cache as a completion channel after failed publication", async () => {
    const coordinator = fakeCacheFillCoordinator([
      { kind: "completed", outcome: "failed" },
      { kind: "owner", token: "retry-owner" },
    ]);
    const readShared = vi.fn(async () => undefined);
    const readEdge = vi.fn(async () => undefined);

    const result = await coalesceGitHubCacheMiss({} as Env, coordinator, "cache-key", {
      readShared,
      readEdge,
    });

    expect(result.owner?.capability.owner_token).toBe("retry-owner");
    expect(readShared).toHaveBeenCalledOnce();
    expect(readEdge).not.toHaveBeenCalled();
    await result.owner?.fail();
  });

  it("blocks stale completion after renewal loss", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = fakeCacheFillCoordinator([{ kind: "owner", token: "lost-owner" }]);
      coordinator.renewPublication.mockResolvedValueOnce(false);
      const acquisition = await acquireOwnedCacheFill(coordinator, "cache-key");
      expect(acquisition.kind).toBe("owner");
      if (acquisition.kind !== "owner") {
        return;
      }

      await expect(acquisition.owner.renew()).resolves.toBe(false);
      await expect(acquisition.owner.complete("shared")).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(coordinator.renewPublication).toHaveBeenCalledOnce();
      expect(coordinator.completePublication).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses one in-flight final renewal and leaves no queued timer after publication", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = fakeCacheFillCoordinator([{ kind: "owner", token: "leader" }]);
      let resolveRenewal!: (renewed: boolean) => void;
      const renewal = new Promise<boolean>((resolve) => {
        resolveRenewal = resolve;
      });
      coordinator.renewPublication.mockReturnValue(renewal);
      const acquisition = await acquireOwnedCacheFill(coordinator, "cache-key");
      expect(acquisition.kind).toBe("owner");
      if (acquisition.kind !== "owner") {
        return;
      }

      const explicitRenewal = acquisition.owner.renew();
      const publication = acquisition.owner.publish(async () => "shared");
      expect(coordinator.renewPublication).toHaveBeenCalledOnce();
      resolveRenewal(true);
      await expect(explicitRenewal).resolves.toBe(true);
      await expect(publication).resolves.toEqual({ storage: "shared", completion: "accepted" });
      expect(coordinator.completePublication).toHaveBeenCalledWith(
        expect.objectContaining({ owner_token: "leader" }),
        "shared",
        acquisition.owner.capability.id,
      );

      await vi.advanceTimersByTimeAsync(6_000);
      expect(coordinator.renewPublication).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-enters acquisition after a waiting RPC is reset", async () => {
    const coordinator = fakeCacheFillCoordinator([{ kind: "owner", token: "recovered-owner" }]);
    coordinator.acquirePublication.mockRejectedValueOnce(new Error("Durable Object reset"));

    const result = await coalesceGitHubCacheMiss({} as Env, coordinator, "cache-key", {
      readShared: async () => undefined,
    });

    expect(result.owner?.capability.owner_token).toBe("recovered-owner");
    expect(coordinator.acquirePublication).toHaveBeenCalledTimes(2);
    await result.owner?.fail();
  });
});

function sharedRead(): GitHubCacheRead {
  return {
    source: "shared",
    cached: {
      status: 200,
      headers: {},
      body: { status: "completed" },
      body_encoding: "json",
      created_at: "2026-08-09 00:00:00",
      expires_at: "2026-08-09 01:00:00",
    },
  };
}
