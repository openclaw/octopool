import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PUBLICATION_LEASE_MS, type PublicationOwner } from "../../src/cache-publication";
import { queries } from "../../src/generated/sql";
import {
  poolCoordinatorStub,
  publicProofCoordinatorStub,
  type PoolCoordinator,
} from "../../src/pool-coordinator";
import { ownedWork } from "./owned-work";
import { observePublicationD1 } from "./publication-d1-observer";

type Coordinator = DurableObjectStub<PoolCoordinator>;

async function observeCoordinator(
  stub: Coordinator,
  hooks: Parameters<typeof observePublicationD1>[1],
  run: () => Promise<void>,
): Promise<void> {
  let originalEnv!: Env;
  await runInDurableObject(stub, (instance) => {
    const target = instance as unknown as { env: Env };
    originalEnv = target.env;
    target.env = { ...target.env, DB: observePublicationD1(target.env.DB, hooks) };
  });
  try {
    await run();
  } finally {
    await ownedWork.finish();
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { env: Env }).env = originalEnv;
    });
  }
}

async function waiterCount(stub: Coordinator): Promise<number> {
  return runInDurableObject(
    stub,
    (instance) =>
      (instance as unknown as { publicationWaiters: Map<string, unknown> }).publicationWaiters.size,
  );
}

async function owner(stub: Coordinator, resource: string): Promise<PublicationOwner> {
  const acquired = await stub.acquirePublication(resource);
  expect(acquired.kind).toBe("owner");
  if (acquired.kind !== "owner") throw new Error("Expected publication owner");
  return acquired.owner;
}

describe.each(["pool", "proof"] as const)("%s publication resource serialization", (kind) => {
  const coordinator = () =>
    kind === "pool"
      ? poolCoordinatorStub(env, "publication-concurrency")
      : publicProofCoordinatorStub(env);
  const resource = kind === "pool" ? "cache:slow" : "public-repo:example/slow";
  const otherResource = kind === "pool" ? "cache:fast" : "public-repo:example/fast";

  it("serves unrelated acquisitions and quota RPCs while acquisition D1 is pending", async () => {
    const stub = coordinator();
    const gate = ownedWork.gate();
    let entered = false;
    let independentFinished = false;
    await observeCoordinator(
      stub,
      {
        before: async (sql, values) => {
          if (sql === queries.acquirePublicationOwner && values[1] === resource) {
            entered = true;
            await gate.promise;
          }
        },
      },
      async () => {
        const slow = ownedWork.track(owner(stub, resource));
        await expect.poll(() => entered).toBe(true);
        const independent = ownedWork.track(
          (async () => {
            const fast = await owner(stub, otherResource);
            expect(await stub.renewPublication(fast)).toBe(true);
            expect(await stub.completePublication(fast, "none")).toBe(true);
            if (kind === "pool") {
              await stub.recordResult({
                identityId: "a",
                routeKey: "route",
                resource: "core",
                status: 200,
                rate: { remaining: 0, resetAt: Math.floor(Date.now() / 1000) + 60 },
              });
              expect(
                await stub.selectIdentity({
                  routeKey: "route",
                  resource: "core",
                  candidates: [{ id: "a", weight: 1 }],
                }),
              ).toMatchObject({ kind: "unavailable" });
              expect((await stub.snapshot()).rates).toHaveLength(1);
            }
            independentFinished = true;
          })(),
        );
        await expect.poll(() => independentFinished, { timeout: 1_000 }).toBe(true);
        gate.release();
        await independent;
        expect(await stub.completePublication(await slow, "none")).toBe(true);
      },
    );
  });

  it.each(["acquire", "try"])(
    "orders acquire/%s races and shares follower completion",
    async (mode) => {
      const stub = coordinator();
      const gate = ownedWork.gate();
      let acquired = false;
      let attempts = 0;
      await observeCoordinator(
        stub,
        {
          before: async (sql) => {
            if (sql === queries.acquirePublicationOwner) attempts++;
          },
          after: async (sql) => {
            if (sql === queries.acquirePublicationOwner && !acquired) {
              acquired = true;
              await gate.promise;
            }
          },
        },
        async () => {
          const first = ownedWork.track(owner(stub, resource));
          await expect.poll(() => acquired).toBe(true);
          const second = ownedWork.track(
            mode === "try"
              ? stub.tryAcquirePublication(resource)
              : stub.acquirePublication(resource),
          );
          // A separate RPC can enter the object while the same-resource request queues.
          await stub.snapshot();
          expect(attempts).toBe(1);
          gate.release();
          const grant = await first;
          if (mode === "try") {
            expect(await second).toBeUndefined();
          } else {
            await expect.poll(() => waiterCount(stub)).toBe(1);
          }
          expect(await stub.completePublication(grant, "shared", grant.id)).toBe(true);
          if (mode === "acquire") {
            expect(await second).toEqual({
              kind: "completed",
              outcome: "shared",
              publicationId: grant.id,
            });
          }
          expect(await waiterCount(stub)).toBe(0);
        },
      );
    },
  );

  it("cannot lose completion between owner lookup and follower registration", async () => {
    const stub = coordinator();
    const grant = await owner(stub, resource);
    const gate = ownedWork.gate();
    let read = false;
    let completed = false;
    await observeCoordinator(
      stub,
      {
        after: async (sql) => {
          if (sql === queries.readPublicationOwner) {
            read = true;
            await gate.promise;
          }
          if (sql === queries.completePublicationOwner) completed = true;
        },
      },
      async () => {
        const follower = ownedWork.track(stub.acquirePublication(resource));
        await expect.poll(() => read).toBe(true);
        const completion = ownedWork.track(stub.completePublication(grant, "shared", grant.id));
        await stub.snapshot();
        expect(completed).toBe(false);
        gate.release();
        expect(await completion).toBe(true);
        expect(await follower).toEqual({
          kind: "completed",
          outcome: "shared",
          publicationId: grant.id,
        });
        expect(await waiterCount(stub)).toBe(0);
      },
    );
  });

  it("notifies the old group before granting a replacement after completion", async () => {
    const stub = coordinator();
    const grant = await owner(stub, resource);
    const follower = ownedWork.track(stub.acquirePublication(resource));
    await expect.poll(() => waiterCount(stub)).toBe(1);
    const gate = ownedWork.gate();
    let deleted = false;
    let attempts = 0;
    await observeCoordinator(
      stub,
      {
        before: async (sql) => {
          if (sql === queries.acquirePublicationOwner) attempts++;
        },
        after: async (sql) => {
          if (sql === queries.completePublicationOwner) {
            deleted = true;
            await gate.promise;
          }
        },
      },
      async () => {
        const completion = ownedWork.track(stub.completePublication(grant, "shared", grant.id));
        await expect.poll(() => deleted).toBe(true);
        const replacement = ownedWork.track(owner(stub, resource));
        await stub.snapshot();
        expect(attempts).toBe(0);
        gate.release();
        expect(await completion).toBe(true);
        expect(await follower).toEqual({
          kind: "completed",
          outcome: "shared",
          publicationId: grant.id,
        });
        const next = await replacement;
        expect(next.id).toBeGreaterThan(grant.id);
        expect(await stub.completePublication(grant, "failed")).toBe(false);
        expect(await stub.completePublication(next, "none")).toBe(true);
      },
    );
  });

  it("retries followers when D1 expiry permits takeover during a held owner read", async () => {
    const stub = coordinator();
    const grant = await owner(stub, resource);
    const gate = ownedWork.gate();
    let read = false;
    await observeCoordinator(
      stub,
      {
        after: async (sql) => {
          if (sql === queries.readPublicationOwner) {
            read = true;
            await gate.promise;
          }
        },
      },
      async () => {
        const follower = ownedWork.track(stub.acquirePublication(resource));
        await expect.poll(() => read).toBe(true);
        await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0 WHERE id = ?")
          .bind(grant.id)
          .run();
        const takeover = ownedWork.track(stub.tryAcquirePublication(resource));
        gate.release();
        const next = (await takeover)!;
        expect(next.id).toBeGreaterThan(grant.id);
        expect(await follower).toEqual({ kind: "retry" });
        expect(await stub.renewPublication(grant)).toBe(false);
        expect(await stub.completePublication(grant, "shared", grant.id)).toBe(false);
        expect(await stub.completePublication(next, "none")).toBe(true);
      },
    );
  });
});

it("releases the resource after a lost acquisition acknowledgment", async () => {
  const stub = poolCoordinatorStub(env, "publication-lost-acquisition");
  let lost = false;
  await observeCoordinator(
    stub,
    {
      after: async (sql) => {
        if (sql === queries.acquirePublicationOwner && !lost) {
          lost = true;
          throw new Error("synthetic lost acquisition acknowledgment");
        }
      },
    },
    async () => {
      await runInDurableObject(stub, async (instance) => {
        await expect(instance.acquirePublication("cache:lost")).rejects.toThrow("synthetic lost");
      });
      expect(await stub.tryAcquirePublication("cache:lost")).toBeUndefined();
      await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0").run();
      const next = await owner(stub, "cache:lost");
      expect(await stub.completePublication(next, "none")).toBe(true);
      expect(
        await runInDurableObject(
          stub,
          (instance) =>
            (instance as unknown as { publicationOperations: Map<string, unknown> })
              .publicationOperations.size,
        ),
      ).toBe(0);
    },
  );
});

it("retries after a lost completion notification without poisoning the resource queue", async () => {
  const stub = poolCoordinatorStub(env, "publication-lost-notification");
  const grant = await owner(stub, "cache:lost");
  await observeCoordinator(
    stub,
    {
      after: async (sql) => {
        if (sql === queries.completePublicationOwner)
          throw new Error("synthetic lost completion acknowledgment");
      },
    },
    async () => {
      const follower = ownedWork.track(stub.acquirePublication(grant.resource_key));
      await expect.poll(() => waiterCount(stub)).toBe(1);
      await runInDurableObject(stub, async (instance) => {
        await expect(instance.completePublication(grant, "shared", grant.id)).rejects.toThrow(
          "synthetic lost",
        );
      });
      expect(await follower).toEqual({ kind: "retry" });
      const next = await owner(stub, grant.resource_key);
      expect(next.id).toBeGreaterThan(grant.id);
      expect(await stub.completePublication(next, "none")).toBe(true);
    },
  );
});

it("does not let an expiry queued during renewal wake the renewed waiter group", async () => {
  const stub = poolCoordinatorStub(env, "publication-queued-expiry");
  const grant = await owner(stub, "cache:renewed");
  const follower = ownedWork.track(stub.acquirePublication(grant.resource_key));
  await expect.poll(() => waiterCount(stub)).toBe(1);
  // Keep D1 authority live while deliberately holding a renewal ack past the notification timer.
  await env.DB.prepare(
    "UPDATE cache_publication_owners SET lease_until_ms = lease_until_ms + 60000 WHERE id = ?",
  )
    .bind(grant.id)
    .run();
  const gate = ownedWork.gate();
  let renewed = false;
  await observeCoordinator(
    stub,
    {
      after: async (sql) => {
        if (sql === queries.renewPublicationOwner) {
          renewed = true;
          await gate.promise;
        }
      },
    },
    async () => {
      const renewal = ownedWork.track(stub.renewPublication(grant));
      await expect.poll(() => renewed).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, PUBLICATION_LEASE_MS + 100));
      gate.release();
      expect(await renewal).toBe(true);
      expect(await waiterCount(stub)).toBe(1);
      expect(await stub.completePublication(grant, "shared", grant.id)).toBe(true);
      expect(await follower).toEqual({
        kind: "completed",
        outcome: "shared",
        publicationId: grant.id,
      });
    },
  );
});
