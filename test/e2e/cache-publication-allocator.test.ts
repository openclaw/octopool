import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { queries } from "../../src/generated/sql";

type Owner = {
  id: number;
  protocol_epoch: string;
  resource_key: string;
  owner_token: string;
  lease_until_ms: number;
};
const acquire = (key: string, token: string) =>
  env.DB.prepare(queries.acquirePublicationOwner)
    .bind("allocator-test", key, token, 8_000)
    .all<Owner>();
const sequence = () =>
  env.DB.prepare(
    "SELECT seq FROM sqlite_sequence WHERE name = 'cache_publication_owners'",
  ).first<number>("seq");

describe("native D1 publication allocator", () => {
  it("returns the committed replacement ID, preserves sequence after deletion and prefilters busy attempts", async () => {
    const first = await acquire("key", "replayed-token");
    expect(first.results[0]).toMatchObject({ id: 1, owner_token: "replayed-token" });
    const busy = await acquire("key", "busy");
    expect(busy.results).toEqual([]);
    expect(await sequence()).toBe(1);
    await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0").run();
    const replacement = await acquire("key", "replacement");
    expect(replacement.results[0]?.id).toBe(2);
    expect(replacement.meta.last_row_id).toBe(1);
    expect(await sequence()).toBe(2);
    await env.DB.prepare("DELETE FROM cache_publication_owners").run();
    expect(await sequence()).toBe(2);
    const replay = await acquire("key", "replayed-token");
    expect(replay.results[0]?.id).toBe(3);
    const stale = ["allocator-test", "key", 1, "replayed-token"];
    expect(
      (
        await env.DB.prepare(queries.renewPublicationOwner)
          .bind(...stale, 8_000)
          .all()
      ).results,
    ).toEqual([]);
    expect(
      (
        await env.DB.prepare(queries.completePublicationOwner)
          .bind(...stale)
          .all()
      ).results,
    ).toEqual([]);
    console.log("native D1 allocator receipts", {
      first: first.meta,
      busy: busy.meta,
      replacement: replacement.meta,
      replay: replay.meta,
    });
  });

  it("establishes unfiltered native allocator behavior separately from the adopted busy prefilter", async () => {
    const canonical = queries.acquirePublicationOwner;
    const unfiltered =
      canonical.slice(0, canonical.indexOf("\nWHERE NOT EXISTS (")) +
      canonical.slice(canonical.indexOf("\nON CONFLICT"));
    const run = (token: string) =>
      env.DB.prepare(unfiltered).bind("allocator-test", "key", token, 8_000).all<Owner>();
    expect((await run("first")).results[0]?.id).toBe(1);
    expect((await run("busy")).results).toEqual([]);
    expect(await sequence()).toBe(2);
    await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0").run();
    const replacement = await run("replacement");
    expect(replacement.results[0]?.id).toBe(3);
    expect(replacement.meta.last_row_id).toBe(1);
  });

  it("fails at the safe integer boundary and rolls back an unsuccessful binding batch", async () => {
    await acquire("seed", "seed");
    await env.DB.prepare(
      "UPDATE sqlite_sequence SET seq = 9007199254740990 WHERE name = 'cache_publication_owners'",
    ).run();
    const last = await acquire("last", "last");
    expect(last.results[0]?.id).toBe(Number.MAX_SAFE_INTEGER);
    await expect(acquire("overflow", "overflow")).rejects.toThrow(/owner_fence_safe_integer/);
    expect(await sequence()).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      (
        await env.DB.prepare(queries.renewPublicationOwner)
          .bind("allocator-test", "last", Number.MAX_SAFE_INTEGER, "last", 8_000)
          .all()
      ).results,
    ).toHaveLength(1);
    await env.DB.prepare("DELETE FROM cache_publication_owners").run();
    await expect(acquire("empty", "empty")).rejects.toThrow(/owner_fence_safe_integer/);
  });

  it("does not expose a grant from a batch that fails after allocation", async () => {
    await expect(
      env.DB.batch([
        env.DB.prepare(queries.acquirePublicationOwner).bind(
          "allocator-test",
          "rolled-back",
          "token",
          8_000,
        ),
        env.DB.prepare(
          "INSERT INTO cache_publication_owners (protocol_epoch, resource_key, owner_token, lease_until_ms) VALUES (NULL, 'bad', 'bad', 0)",
        ),
      ]),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM cache_publication_owners").first("n"),
    ).toBe(0);
    expect((await acquire("committed", "token")).results[0]?.id).toBe(1);
  });

  it("collects only sixteen expired owners atomically using the expiry index", async () => {
    for (let i = 0; i < 20; i++) await acquire(`key-${i}`, `token-${i}`);
    await env.DB.prepare(
      "UPDATE cache_publication_owners SET lease_until_ms = 0 WHERE id <= 18",
    ).run();
    const result = await env.DB.prepare(queries.deleteExpiredPublicationOwners).bind(16).all();
    expect(result.results).toHaveLength(16);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM cache_publication_owners").first("n"),
    ).toBe(4);
    expect(await sequence()).toBe(20);
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN ${queries.deleteExpiredPublicationOwners}`,
    )
      .bind(16)
      .all();
    expect(JSON.stringify(plan.results)).toContain("cache_publication_owners_expiry");
    console.log("native D1 owner GC", { meta: result.meta, plan: plan.results });
  });
});
