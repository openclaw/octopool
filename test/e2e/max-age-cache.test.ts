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
  it.each([
    {
      path: PR_PATH,
      body: { state: "open", merged_at: null },
      changed: { state: "open" },
      ttl: 300,
      stale: 3_600,
    },
    {
      path: PR_PATH,
      body: { state: "closed", merged_at: null },
      changed: { state: "open" },
      ttl: 3_600,
      stale: 3_600,
    },
    {
      path: `${REPO_PATH}/actions/runs/42`,
      body: { status: "completed" },
      changed: { status: "queued" },
      ttl: 600,
      stale: 300,
    },
  ])(
    "persists age-scaled TTL $ttl for $body and keeps zero-age reads live",
    async ({ path, body, changed, ttl, stale }) => {
      await seedPool();
      let fetches = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const url = new URL(new Request(input, init).url);
          if (url.pathname === REPO_PATH) return jsonResponse({ private: false });
          if (url.pathname === path) {
            fetches++;
            return jsonResponse(
              fetches === 1
                ? { ...body, updated_at: new Date(Date.now() - 86_400_000).toISOString() }
                : { ...changed, updated_at: new Date().toISOString() },
            );
          }
          return jsonResponse({ message: "unexpected upstream request" }, 500);
        }),
      );

      const fill = await relay(path);
      expect(await fill.json()).toMatchObject({ body, relay: { cache: "miss" } });
      const row = await env.DB.prepare(`SELECT unixepoch(expires_at) - unixepoch(created_at) AS ttl,
      unixepoch(stale_expires_at) - unixepoch(expires_at) AS stale FROM github_cache_entries`).first();
      expect(row).toEqual({ ttl, stale });

      const hit = await relay(path, undefined, { headers: { "Cache-Control": "max-age=30" } });
      expect(await hit.json()).toMatchObject({ body, relay: { cache: "hit" } });
      expect(fetches).toBe(1);
      const live = await relay(path, undefined, { headers: { "Cache-Control": "max-age=0" } });
      expect(await live.json()).toMatchObject({ body: changed, relay: { cache: "miss" } });
      expect(fetches).toBe(2);
      const shared = await relay(path);
      expect(await shared.json()).toMatchObject({ body: changed, relay: { cache: "hit" } });
      expect(fetches).toBe(2);

      const audits = await env.DB.prepare(
        "SELECT cache_status, requested_max_age FROM audit_events ORDER BY rowid",
      ).all();
      expect(audits.results).toEqual([
        { cache_status: "miss", requested_max_age: null },
        { cache_status: "hit", requested_max_age: 30 },
        { cache_status: "miss", requested_max_age: 0 },
        { cache_status: "hit", requested_max_age: null },
      ]);
    },
  );

  it.each([undefined, 0, 30])(
    "audits requested max-age %j before route preparation succeeds",
    async (maxAge) => {
      await seedPool();
      const headers = maxAge === undefined ? {} : { "Cache-Control": `max-age=${maxAge}` };
      const denied = await relay(`${REPO_PATH}/unsupported`, undefined, { headers });
      expect(denied.status).toBe(424);
      expect(
        await env.DB.prepare("SELECT route_kind, requested_max_age FROM audit_events").first(),
      ).toEqual({
        route_kind: "denied",
        requested_max_age: maxAge ?? null,
      });
    },
  );

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
      "SELECT cache_status, requested_max_age FROM audit_events ORDER BY rowid",
    ).all();
    expect(audits.results).toEqual([
      { cache_status: "miss", requested_max_age: 20 },
      { cache_status: "hit", requested_max_age: 20 },
      { cache_status: "hit", requested_max_age: null },
      { cache_status: "miss", requested_max_age: 20 },
      { cache_status: "hit", requested_max_age: 20 },
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
          expect(
            await env.DB.prepare(
              "SELECT requested_max_age FROM audit_events WHERE status = 424 ORDER BY rowid",
            ).all(),
          ).toMatchObject({
            results: [{ requested_max_age: maxAge }, { requested_max_age: maxAge }],
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
