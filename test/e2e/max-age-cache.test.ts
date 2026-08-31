import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { bearer, jsonResponse, rateHeaders, relay, seedPool } from "./harness";

const REPO_PATH = "/repos/openclaw/freshness-fixture";
const PR_PATH = `${REPO_PATH}/pulls/73`;
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
        if (url.pathname === REPO_PATH) {
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
    await deleteEdgeJSON("github-publication-v1", cacheRow!.cache_key);

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

  describe.each(["anonymous", "identity"])("%s cache source", (source) => {
    describe.each(["raw", "public-shaped"])("%s request", (shape) => {
      it.each([
        { maxAge: 0, age: 30, expired: false },
        { maxAge: 20, age: 30, expired: false },
        { maxAge: 0, age: 180, expired: true },
        { maxAge: 20, age: 180, expired: true },
      ])(
        "rejects out-of-bound outage success: max-age=$maxAge, expired=$expired",
        async ({ maxAge, age, expired }) => {
          await seedPool();
          const headers: Record<string, string> =
            shape === "raw" ? {} : { "x-octopool-public-shape": "pr-summary-v1" };
          let head = FIRST_HEAD;
          let unavailable = false;
          let limitedCalls = 0;
          vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(async (input, init) => {
              const request = new Request(input, init);
              const url = new URL(request.url);
              if (url.pathname === REPO_PATH) {
                return jsonResponse({ private: false });
              }
              if (url.hostname === "api.github.com" && url.pathname === PR_PATH) {
                if (unavailable && bearer(request) === "test-primary-token") {
                  limitedCalls++;
                  return jsonResponse(
                    { message: "fixture rate limit" },
                    429,
                    rateHeaders({ remaining: 0, retryAfter: 60 }),
                  );
                }
                if (
                  !unavailable &&
                  (source === "anonymous" ||
                    head === SECOND_HEAD ||
                    bearer(request) === "test-primary-token")
                ) {
                  return jsonResponse({ state: "open", merged_at: null, head: { sha: head } });
                }
              }
              return jsonResponse({ message: "fixture upstream unavailable" }, 503);
            }),
          );

          const primed = await relay(PR_PATH, undefined, { headers });
          expect(await primed.json<RelayEnvelope>()).toMatchObject({
            body: { head: { sha: FIRST_HEAD } },
            relay: { cache: "miss" },
          });
          const row = await env.DB.prepare(
            "SELECT cache_key, identity_id FROM github_cache_entries WHERE route_kind = 'pr_view'",
          ).first<{ cache_key: string; identity_id: string | null }>();
          expect(row).toMatchObject({ identity_id: source === "anonymous" ? null : "primary" });
          await env.DB.prepare(
            `UPDATE github_cache_entries
             SET created_at = datetime('now', ?), expires_at = datetime('now', ?),
                 stale_expires_at = datetime('now', '+1 hour') WHERE cache_key = ?`,
          )
            .bind(`-${age} seconds`, expired ? "-60 seconds" : "+90 seconds", row!.cache_key)
            .run();
          await deleteEdgeJSON("github-publication-v1", row!.cache_key);

          head = SECOND_HEAD;
          unavailable = true;
          const bounded = { headers: { ...headers, "Cache-Control": `max-age=${maxAge}` } };
          const rejected = await relay(PR_PATH, undefined, bounded);
          expect(rejected.status).toBe(424);
          expect(await rejected.json()).toMatchObject({
            error: { code: "fallback_local", details: { reason: "github_rate_limited" } },
          });
          expect(limitedCalls).toBe(1);

          // The coordinator now skips the cooling identity; error fallback must also honor the bound.
          const cooling = await relay(PR_PATH, undefined, bounded);
          expect(cooling.status).toBe(424);
          expect(await cooling.json()).toMatchObject({
            error: { code: "fallback_local", details: { reason: "identities_cooling_down" } },
          });
          expect(limitedCalls).toBe(1);

          // Neither a rejected bound nor a failed refresh destroys ordinary outage availability.
          for (const allowedHeaders of [headers, { ...headers, "cache-control": "max-age=600" }]) {
            const allowed = await relay(PR_PATH, undefined, { headers: allowedHeaders });
            expect(allowed.status).toBe(200);
            expect(await allowed.json<RelayEnvelope>()).toMatchObject({
              body: { head: { sha: FIRST_HEAD } },
              relay: { cache: expired ? "stale" : "hit", stale_ok: expired },
            });
          }

          unavailable = false;
          const recovered = await relay(PR_PATH, undefined, bounded);
          expect(await recovered.json<RelayEnvelope>()).toMatchObject({
            body: { head: { sha: SECOND_HEAD } },
            relay: { cache: "miss" },
          });
          const shared = await relay(PR_PATH, undefined, { headers });
          expect(await shared.json<RelayEnvelope>()).toMatchObject({
            body: { head: { sha: SECOND_HEAD } },
            relay: { cache: "hit" },
          });
        },
      );
    });
  });
});
