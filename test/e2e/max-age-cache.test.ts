import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { jsonResponse, relay, seedPool } from "./harness";

const PR_PATH = "/repos/openclaw/octopool/pulls/42";
const FIRST_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECOND_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type RelayEnvelope = {
  body: { head?: { sha?: string } };
  relay: { cache: string; route_kind: string };
};

describe("Worker end-to-end bounded-freshness cache", () => {
  it("re-fills entries older than the requested max-age through the shared cache", async () => {
    await seedPool();
    let prFetches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === PR_PATH) {
          prFetches++;
          return jsonResponse({
            state: "open",
            merged_at: null,
            head: { sha: prFetches === 1 ? FIRST_HEAD : SECOND_HEAD },
          });
        }
        if (url.pathname === "/repos/openclaw/octopool") {
          return jsonResponse({ private: false });
        }
        return jsonResponse({ message: "unexpected upstream request" }, 500);
      }),
    );
    const bounded = { headers: { "cache-control": "max-age=20" } };

    const fill = await relay(PR_PATH, undefined, bounded);
    expect(await fill.json<RelayEnvelope>()).toMatchObject({
      body: { head: { sha: FIRST_HEAD } },
      relay: { cache: "miss", route_kind: "pr_view" },
    });
    expect(prFetches).toBe(1);

    const boundedHit = await relay(PR_PATH, undefined, bounded);
    expect(await boundedHit.json<RelayEnvelope>()).toMatchObject({
      body: { head: { sha: FIRST_HEAD } },
      relay: { cache: "hit", route_kind: "pr_view" },
    });
    expect(prFetches).toBe(1);

    // Age the shared entry past the freshness bound while its normal TTL stays valid.
    const cacheRow = await env.DB.prepare(
      "SELECT cache_key FROM github_cache_entries WHERE route_kind = 'pr_view' LIMIT 1",
    ).first<{ cache_key: string }>();
    expect(cacheRow).not.toBeNull();
    await env.DB.prepare(
      "UPDATE github_cache_entries SET created_at = datetime('now', '-30 seconds') WHERE cache_key = ?",
    )
      .bind(cacheRow!.cache_key)
      .run();
    await deleteEdgeJSON("github-v1", cacheRow!.cache_key);

    const unbounded = await relay(PR_PATH);
    expect(await unbounded.json<RelayEnvelope>()).toMatchObject({
      body: { head: { sha: FIRST_HEAD } },
      relay: { cache: "hit", route_kind: "pr_view" },
    });
    expect(prFetches).toBe(1);

    const boundedRefill = await relay(PR_PATH, undefined, bounded);
    expect(await boundedRefill.json<RelayEnvelope>()).toMatchObject({
      body: { head: { sha: SECOND_HEAD } },
      relay: { cache: "miss", route_kind: "pr_view" },
    });
    expect(prFetches).toBe(2);

    // The bounded refill wrote through, so everyone shares the fresh entry again.
    const sharedHit = await relay(PR_PATH, undefined, bounded);
    expect(await sharedHit.json<RelayEnvelope>()).toMatchObject({
      body: { head: { sha: SECOND_HEAD } },
      relay: { cache: "hit", route_kind: "pr_view" },
    });
    expect(prFetches).toBe(2);

    const audits = await env.DB.prepare(
      "SELECT cache_status FROM audit_events ORDER BY rowid",
    ).all<{ cache_status: string }>();
    expect(audits.results.map(({ cache_status }) => cache_status)).toEqual([
      "miss",
      "hit",
      "hit",
      "miss",
      "hit",
    ]);
  });
});
