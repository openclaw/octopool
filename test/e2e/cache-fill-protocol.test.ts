import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { poolCoordinatorStub } from "../../src/pool-coordinator";

describe("PoolCoordinator cache-fill protocol", () => {
  it("allows completion RPC to wake a waiting acquisition", async () => {
    const coordinator = poolCoordinatorStub(env, "cache-fill-wakeup");
    const leader = await coordinator.acquireCacheFill("key");
    expect(leader.kind).toBe("owner");
    if (leader.kind !== "owner") {
      return;
    }

    const followers = [coordinator.acquireCacheFill("key"), coordinator.acquireCacheFill("key")];
    expect(await coordinator.completeCacheFill("key", leader.token, "shared")).toBe(true);

    await expect(Promise.all(followers)).resolves.toEqual([
      { kind: "completed", outcome: "shared" },
      { kind: "completed", outcome: "shared" },
    ]);
  });

  it("rejects stale tokens after expiry without releasing a newer owner", async () => {
    const coordinator = poolCoordinatorStub(env, "cache-fill-fencing");
    const stale = await coordinator.acquireCacheFill("key");
    expect(stale.kind).toBe("owner");
    if (stale.kind !== "owner") {
      return;
    }
    const staleFollower = coordinator.acquireCacheFill("key");

    await new Promise((resolve) => setTimeout(resolve, 8_100));
    const current = await coordinator.acquireCacheFill("key");
    expect(current.kind).toBe("owner");
    if (current.kind !== "owner") {
      return;
    }

    await expect(staleFollower).resolves.toEqual({ kind: "retry" });
    expect(await coordinator.renewCacheFill("key", stale.token)).toBe(false);
    expect(await coordinator.completeCacheFill("key", stale.token, "shared")).toBe(false);
    expect(await coordinator.completeCacheFill("key", "wrong-token", "failed")).toBe(false);
    expect(await coordinator.renewCacheFill("key", current.token)).toBe(true);

    const currentFollower = coordinator.acquireCacheFill("key");
    expect(await coordinator.completeCacheFill("key", current.token, "failed")).toBe(true);
    await expect(currentFollower).resolves.toEqual({ kind: "completed", outcome: "failed" });
  }, 15_000);
});
