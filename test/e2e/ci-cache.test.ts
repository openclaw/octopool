import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { hashToken } from "../../src/auth";
import {
  GITHUB_EDGE_CACHE_NAMESPACE,
  githubCacheKey,
  type CachedGitHubResponse,
} from "../../src/cache";
import { CACHE_PUBLICATION_EPOCH } from "../../src/cache-publication";
import { loadIdentities } from "../../src/db";
import { deleteEdgeJSON, readEdgeJSON, writeEdgeJSON } from "../../src/edge-cache";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { seedPublicRepoProof, writeOwnedGitHubCache } from "./cache-publication-fixture";
import { bearer, jsonResponse, POOL, relay, seedPool } from "./harness";

const sha = "a".repeat(40);
const path = `/repos/openclaw/octopool/commits/${sha}/check-runs`;
const result = (status: string) => ({
  total_count: 1,
  check_runs: [
    { id: 1, head_sha: sha, status, conclusion: status === "completed" ? "success" : null },
  ],
});

describe("mutable commit CI cache", () => {
  it("refreshes completed checks after a same-SHA rerun within the mutable TTL", async () => {
    await seedPool();
    let status = "completed";
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`https://api.github.com${path}`);
      expect(bearer(request)).toBeUndefined();
      return jsonResponse(result(status));
    });
    vi.stubGlobal("fetch", upstream);
    const request = { pool: POOL, method: "GET" as const, path };
    const key = await githubCacheKey(
      POOL,
      request,
      classifyRoute(request, defaultPolicy("openclaw")),
    );

    expect(await (await relay(path)).json()).toMatchObject({
      body: result("completed"),
      relay: { cache: "miss" },
    });
    status = "in_progress";
    expect(await (await relay(path)).json()).toMatchObject({
      body: result("completed"),
      relay: { cache: "hit" },
    });
    expect(upstream).toHaveBeenCalledTimes(1);

    // Age the actual first publication in both stores instead of changing the
    // Worker clock while SQLite's independent storage clock remains unchanged.
    await env.DB.prepare(`UPDATE github_cache_entries SET
      created_at = datetime(created_at, '-61 seconds'),
      expires_at = datetime(expires_at, '-61 seconds'),
      stale_expires_at = datetime(stale_expires_at, '-61 seconds') WHERE cache_key = ?`)
      .bind(key)
      .run();
    const edge = await readEdgeJSON<CachedGitHubResponse & { protocol_epoch: string }>(
      GITHUB_EDGE_CACHE_NAMESPACE,
      key,
    );
    expect(edge).toBeDefined();
    const age = (value: string) =>
      new Date(Date.parse(`${value}Z`) - 61_000).toISOString().slice(0, 19).replace("T", " ");
    await writeEdgeJSON(
      GITHUB_EDGE_CACHE_NAMESPACE,
      key,
      {
        ...edge,
        created_at: age(edge!.created_at),
        expires_at: age(edge!.expires_at),
      },
      3_600,
    );

    expect(await (await relay(path)).json()).toMatchObject({
      body: result("in_progress"),
      relay: { cache: "miss" },
    });
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(
      await env.DB.prepare(`SELECT unixepoch(expires_at) - unixepoch(created_at) AS fresh,
      unixepoch(stale_expires_at) - unixepoch(expires_at) AS stale
      FROM github_cache_entries WHERE cache_key = ?`)
        .bind(key)
        .first(),
    ).toEqual({ fresh: 60, stale: 300 });
  });

  it.each(["edge", "shared", "identity", "stale"])(
    "retires old terminal %s entries and validators",
    async (storage) => {
      await seedPool();
      const request = { pool: POOL, method: "GET" as const, path };
      const route = classifyRoute(request, defaultPolicy("openclaw"));
      const identity =
        storage === "identity" ? (await loadIdentities(env, POOL, route))[0] : undefined;
      const key = await hashToken(
        JSON.stringify({
          protocol_epoch: CACHE_PUBLICATION_EPOCH,
          pool: POOL,
          method: "GET",
          path,
          query: {},
          headers: {},
          route_key: route.routeKey,
          ...(identity === undefined ? {} : { identity: `${identity.kind}:${identity.id}` }),
        }),
      );
      expect(await githubCacheKey(POOL, request, route, identity)).not.toBe(key);
      await seedPublicRepoProof(env, route);
      expect(
        await writeOwnedGitHubCache(
          env,
          key,
          request,
          route,
          {
            status: 200,
            body: result("completed"),
            headers: { etag: '"old-terminal"', "x-ratelimit-resource": "core" },
          },
          identity,
        ),
      ).toBe("shared");
      await env.DB.prepare(`UPDATE github_cache_entries SET expires_at = datetime('now', '+1 hour'),
      stale_expires_at = datetime('now', '+25 hours') WHERE cache_key = ?`)
        .bind(key)
        .run();
      const edge = await readEdgeJSON<CachedGitHubResponse & { protocol_epoch: string }>(
        GITHUB_EDGE_CACHE_NAMESPACE,
        key,
      );
      expect(edge).toBeDefined();
      if (storage === "edge") {
        await writeEdgeJSON(
          GITHUB_EDGE_CACHE_NAMESPACE,
          key,
          {
            ...edge,
            expires_at: new Date(Date.now() + 3_600_000)
              .toISOString()
              .slice(0, 19)
              .replace("T", " "),
          },
          3_600,
        );
      } else {
        await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, key);
      }
      if (storage === "stale") {
        await env.DB.prepare(`UPDATE github_cache_entries SET created_at = datetime('now', '-1 hour'),
        expires_at = datetime('now', '-1 second') WHERE cache_key = ?`)
          .bind(key)
          .run();
        await env.DB.prepare("UPDATE identities SET status = 'disabled'").run();
      }
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe(`https://api.github.com${path}`);
        expect(request.headers.get("if-none-match")).toBeNull();
        if (storage === "stale" || (storage === "identity" && bearer(request) === undefined)) {
          return jsonResponse({ message: "unavailable" }, 503);
        }
        return jsonResponse(result("queued"));
      });
      vi.stubGlobal("fetch", upstream);
      const response = await relay(path);
      if (storage === "stale") {
        expect(response.status).toBe(424);
      } else {
        expect(await response.json()).toMatchObject({
          body: result("queued"),
          relay: { cache: "miss" },
        });
      }
      expect(upstream).toHaveBeenCalledTimes(storage === "identity" ? 2 : 1);
    },
  );
});
