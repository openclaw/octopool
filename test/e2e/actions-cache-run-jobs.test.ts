import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bearer, jsonResponse, rateHeaders, relay, seedPool } from "./harness";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { historicalHead, runPage } from "../fixtures/actions-ownership";
import { GITHUB_EDGE_CACHE_NAMESPACE, githubCacheKey } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { seedPublicRepoProof, writeOwnedGitHubCache } from "./cache-publication-fixture";

type RelayEnvelope = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  body_encoding: string;
  relay: { cache: string; cacheable: boolean; route_kind: string };
};

describe("Actions attempt job-list cache", () => {
  beforeEach(seedPool);

  it.each([
    { identity: false, network: false, fresh: false },
    { identity: false, network: true, fresh: false },
    { identity: true, network: false, fresh: false },
    { identity: true, network: true, fresh: false },
    { identity: false, network: false, fresh: true },
    { identity: false, network: true, fresh: true },
    { identity: true, network: false, fresh: true },
    { identity: true, network: true, fresh: true },
  ])(
    "recovers a complete cached aggregate after a later-page outage (identity:$identity, network:$network, fresh:$fresh)",
    async ({ identity, network, fresh }) => {
      const path = "/repos/openclaw/octopool/actions/runs/42/jobs";
      const options = {
        query: { per_page: "100" },
        headers: { "x-octopool-public-shape": "actions-jobs-v1" },
      };
      const jobs = Array.from({ length: 200 }, (_, index) => ({ id: index + 1, status: "queued" }));
      let failing = false;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          const token = bearer(request);
          if (token === "test-org-token") return jsonResponse({ private: false });
          const url = new URL(request.url);
          if (url.hostname === "github.com") return new Response(null, { status: 404 });
          expect(url.pathname).toBe(path);
          if (identity && token === undefined) return jsonResponse({}, 503);
          const page = Number(url.searchParams.get("page"));
          if (failing && page === 2) {
            if (network) throw new Error("Synthetic page transport failure");
            return jsonResponse({}, 503);
          }
          return jsonResponse(
            {
              total_count: 200,
              jobs: jobs
                .slice((page - 1) * 100, page * 100)
                .map((job) => (failing && job.id === 1 ? { ...job, status: "in_progress" } : job)),
            },
            200,
            rateHeaders({ remaining: 4_999 }),
          );
        }),
      );
      expect((await relay(path, undefined, options)).status).toBe(200);
      await env.DB.prepare(
        "UPDATE github_cache_entries SET created_at = datetime('now', '-180 seconds'), expires_at = datetime('now', '-1 second') WHERE path = ?",
      )
        .bind(path)
        .run();
      const before = await env.DB.prepare(
        "SELECT cache_key, created_at, expires_at, stale_expires_at, body_json FROM github_cache_entries WHERE path = ?",
      )
        .bind(path)
        .first<{ cache_key: string; body_json: string }>();
      expect(before).not.toBeNull();
      await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, before!.cache_key);
      failing = true;
      const response = await relay(path, undefined, {
        ...options,
        headers: { ...options.headers, ...(fresh ? { "cache-control": "max-age=0" } : {}) },
      });
      const wire = await response.json<RelayEnvelope>();
      if (fresh) {
        expect(response.status).toBe(424);
        expect(wire).toMatchObject({
          error: { code: "fallback_local", details: { reason: "pagination_exhausted" } },
        });
      } else {
        expect(response.status).toBe(200);
        expect(wire).toMatchObject({
          status: 200,
          body: { total_count: 200, jobs: expect.arrayContaining([jobs[0]]) },
          relay: { cache: "stale", stale_ok: true },
        });
      }
      expect(
        await env.DB.prepare(
          "SELECT cache_key, created_at, expires_at, stale_expires_at, body_json FROM github_cache_entries WHERE path = ?",
        )
          .bind(path)
          .first(),
      ).toEqual(before);
    },
  );

  it.each([
    { count: 100, forced: false },
    { count: 100, forced: true },
    { count: 200, forced: false },
    { count: 200, forced: true },
  ])("refreshes a legacy $count-job cache entry (forced: $forced)", async ({ count, forced }) => {
    const request = {
      pool: "maintainers",
      method: "GET" as const,
      path: "/repos/openclaw/octopool/actions/runs/42/jobs",
      query: { page: "1", per_page: "100" },
      headers: { "x-octopool-public-shape": "actions-jobs-v1" },
    };
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    const key = await githubCacheKey(request.pool, request, route);
    const jobs = Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      status: index < 100 ? "completed" : "queued",
    }));
    const validators = {
      ...(forced ? {} : { etag: '"page-one"' }),
      "last-modified": "Sun, 20 Sep 2026 00:00:00 GMT",
      ...rateHeaders({ remaining: 59 }),
    };
    await seedPublicRepoProof(env, route);
    // Old writers retained the first page's validators on merged bodies.
    expect(
      await writeOwnedGitHubCache(env, key, request, route, {
        status: 200,
        headers: validators as Record<string, string>,
        body: { total_count: count, jobs },
        body_encoding: "json",
      }),
    ).toBe("shared");
    const pages: number[] = [];
    let conditionalCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const fetched = new Request(input, init);
        const url = new URL(fetched.url);
        if (url.hostname === "github.com") return new Response(null, { status: 404 });
        expect(bearer(fetched)).toBeUndefined();
        expect(url.pathname).toBe(request.path);
        const page = Number(url.searchParams.get("page"));
        pages.push(page);
        if (fetched.headers.has("if-none-match") || fetched.headers.has("if-modified-since")) {
          conditionalCalls++;
          expect(page).toBe(1);
          return new Response(null, { status: 304, headers: validators });
        }
        return jsonResponse(
          {
            total_count: count,
            jobs: jobs
              .slice((page - 1) * 100, page * 100)
              .map((job) => (job.id === 101 ? { ...job, status: "in_progress" } : job)),
          },
          200,
          validators,
        );
      }),
    );
    expect(
      (await (await relay(request.path, undefined, request)).json<RelayEnvelope>()).relay.cache,
    ).toBe("hit");
    expect(pages).toEqual([]);
    if (!forced) {
      await env.DB.prepare(
        `UPDATE github_cache_entries SET
          created_at = datetime(created_at, '-61 seconds'),
          expires_at = datetime(expires_at, '-61 seconds'),
          stale_expires_at = datetime(stale_expires_at, '-61 seconds')
        WHERE cache_key = ?`,
      )
        .bind(key)
        .run();
      await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, key);
    }
    const refreshed = await relay(request.path, undefined, {
      ...request,
      headers: { ...request.headers, ...(forced ? { "cache-control": "max-age=0" } : {}) },
    });
    expect(refreshed.status).toBe(200);
    expect(pages).toEqual(count === 100 ? [1] : [1, 2]);
    expect(conditionalCalls).toBe(count === 100 ? 1 : 0);
    const stored = await env.DB.prepare(
      "SELECT body_json, response_headers_json FROM github_cache_entries WHERE cache_key = ?",
    )
      .bind(key)
      .first<{ body_json: string; response_headers_json: string }>();
    const body = JSON.parse(stored!.body_json) as { jobs: { id: number; status: string }[] };
    expect(body.jobs).toHaveLength(count);
    if (count > 100) {
      expect(body.jobs[100]).toEqual({ id: 101, status: "in_progress" });
      expect(JSON.parse(stored!.response_headers_json)).not.toHaveProperty("etag");
      expect(JSON.parse(stored!.response_headers_json)).not.toHaveProperty("last-modified");
    } else {
      expect(JSON.parse(stored!.response_headers_json)).toHaveProperty(
        forced ? "last-modified" : "etag",
        forced ? validators["last-modified"] : '"page-one"',
      );
    }
    if (count > 100 && !forced) {
      await env.DB.prepare(
        "UPDATE github_cache_entries SET expires_at = datetime('now', '-1 second') WHERE cache_key = ?",
      )
        .bind(key)
        .run();
      await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, key);
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const fetched = new Request(input, init);
          if (new URL(fetched.url).pathname === "/repos/openclaw/octopool") {
            return jsonResponse({ private: false });
          }
          return jsonResponse(
            { message: "API rate limit exceeded" },
            429,
            rateHeaders({ remaining: 0, retryAfter: 60 }),
          );
        }),
      );
      expect(await (await relay(request.path, undefined, request)).json()).toMatchObject({
        body: { total_count: count },
        relay: { cache: "stale" },
      });
      const live = await relay(request.path, undefined, {
        ...request,
        headers: { ...request.headers, "cache-control": "max-age=0" },
      });
      expect(live.status).toBe(424);
    }
  });

  it.each<{
    source: string;
    attemptPath: boolean;
    shaped?: boolean;
    reject?: string;
    identityOutage?: boolean;
  }>([
    { source: "anonymous", attemptPath: false },
    { source: "anonymous", attemptPath: true },
    { source: "pooled", attemptPath: false },
    { source: "pooled", attemptPath: true },
    { source: "anonymous", attemptPath: false, shaped: true },
    { source: "pooled", attemptPath: true, shaped: true },
    { source: "anonymous", attemptPath: false, identityOutage: true },
    { source: "anonymous", attemptPath: true, shaped: true, identityOutage: true },
    { source: "pooled", attemptPath: true, identityOutage: true, reject: "identity lookup outage" },
    ...[
      "different attempt",
      "active",
      "wrong run",
      "force fresh",
      "expired",
      "revoked identity",
    ].map((reject) => ({ source: "pooled", attemptPath: false, reject })),
  ])(
    "checks $source run proof (attempt: $attemptPath, shaped: $shaped, rejection: $reject, identity outage: $identityOutage)",
    async ({ source, attemptPath, shaped, reject, identityOutage }) => {
      const runPath = "/repos/openclaw/octopool/actions/runs/42";
      const attempt = `${runPath}/attempts/2`;
      let warmingRun = true;
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
        if (url.hostname === "api.github.com" && url.pathname.endsWith("/jobs")) {
          return jsonResponse({ total_count: 1, jobs: [{ id: 1, status: "completed" }] });
        }
        if (
          url.hostname === "github.com" ||
          (source === "pooled" && bearer(request) !== "test-primary-token")
        ) {
          return jsonResponse({ message: "public backend unavailable" }, 503);
        }
        if (!warmingRun) return jsonResponse({ message: "metadata unavailable" }, 503);
        return jsonResponse({
          id: reject === "wrong run" ? 43 : 42,
          status: reject === "active" ? "in_progress" : "completed",
          run_attempt: reject === "different attempt" ? 3 : 2,
        });
      });
      vi.stubGlobal("fetch", upstream);
      expect(
        (
          await relay(
            attemptPath ? attempt : runPath,
            undefined,
            shaped ? { headers: { "x-octopool-public-shape": "actions-summary-v1" } } : {},
          )
        ).status,
      ).toBe(200);
      if (reject === "expired") {
        const row = await env.DB.prepare(
          "SELECT cache_key FROM github_cache_entries WHERE route_kind = 'run_view'",
        ).first<{ cache_key: string }>();
        await env.DB.prepare(
          "UPDATE github_cache_entries SET expires_at = datetime('now', '-1 second') WHERE cache_key = ?",
        )
          .bind(row!.cache_key)
          .run();
        await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, row!.cache_key);
      }
      if (reject === "revoked identity") {
        await env.DB.prepare(
          "UPDATE identities SET status = 'disabled' WHERE id = 'primary'",
        ).run();
      }
      if (identityOutage) {
        await env.DB.prepare("ALTER TABLE identities RENAME TO unavailable_identities").run();
      }
      warmingRun = false;
      upstream.mockClear();

      const options = {
        query: { per_page: "100" },
        headers: {
          ...(shaped ? { "x-octopool-public-shape": "actions-jobs-v1" } : {}),
          ...(reject === "force fresh" ? { "cache-control": "max-age=0" } : {}),
        },
      };
      const response = await relay(`${attempt}/jobs`, undefined, options);
      expect(response.status).toBe(200);
      expect(
        await env.DB.prepare(
          `SELECT unixepoch(expires_at) - unixepoch(created_at) AS ttl
       FROM github_cache_entries WHERE route_kind = 'run_jobs'`,
        ).first(),
      ).toEqual({ ttl: reject === undefined ? 3600 : 60 });
      const metadataFetches = upstream.mock.calls.filter(([input, init]) => {
        const path = new URL(new Request(input, init).url).pathname;
        return path.endsWith("/actions/runs/42") || path.endsWith("/actions/runs/42/attempts/2");
      });
      expect(metadataFetches).toHaveLength(reject === undefined ? 0 : 2);
      upstream.mockClear();
      const next = await relay(`${attempt}/jobs`, undefined, {
        ...options,
        headers: shaped ? { "x-octopool-public-shape": "actions-jobs-v1" } : {},
      });
      expect((await next.json<RelayEnvelope>()).relay.cache).toBe("hit");
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("records a secondary limit from a later identity-backed jobs page", async () => {
    const pages: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
        if (bearer(request) !== "test-primary-token")
          return jsonResponse({ message: "anonymous unavailable" }, 503);
        pages.push(url.searchParams.get("page")!);
        if (url.searchParams.get("page") === "2") {
          return jsonResponse(
            { message: "You have exceeded a secondary rate limit." },
            403,
            rateHeaders({ remaining: 4_998 }),
          );
        }
        return jsonResponse(
          { total_count: 200, jobs: Array.from({ length: 100 }, (_, id) => ({ id })) },
          200,
          rateHeaders({ remaining: 4_999 }),
        );
      }),
    );
    const response = await relay(
      "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs",
      undefined,
      {
        query: { per_page: "100" },
        headers: { "x-octopool-public-shape": "actions-jobs-v1" },
      },
    );
    expect(response.status).toBe(424);
    expect(pages).toEqual(["1", "2"]);
    const coordinator = poolCoordinatorStub(env, "maintainers");
    expect((await coordinator.snapshot()).cooldowns).toEqual([
      expect.objectContaining({ identity_id: "primary", route_key: "*", status: 403 }),
    ]);
    expect(
      await coordinator.selectIdentity({
        routeKey: "another route",
        resource: "search",
        candidates: [{ id: "primary", weight: 200 }],
      }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("shares bounded latest variants on an attempt-qualified complete page", async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "github.com") {
        return jsonResponse({ message: "public parser unavailable" }, 404);
      }
      expect(request.headers.get("authorization")).toBeNull();
      if (url.pathname.endsWith("/attempts/2")) {
        return jsonResponse({ id: 42, status: "completed", run_attempt: 2 });
      }
      return jsonResponse({
        total_count: 2,
        jobs: [
          { id: 1, status: "completed", conclusion: "success" },
          { id: 2, status: "completed", conclusion: "success" },
        ],
      });
    });
    vi.stubGlobal("fetch", upstream);
    const path = "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs";

    const first = await relay(path, undefined, {
      query: { per_page: "1" },
      headers: { "x-octopool-public-shape": "actions-jobs-v1" },
    });
    expect(await first.json<RelayEnvelope>()).toMatchObject({
      body: { total_count: 2, jobs: [{ id: 1 }] },
      relay: { cache: "miss", route_kind: "run_jobs" },
    });
    const second = await relay(path, undefined, {
      query: { filter: "latest", page: "1", per_page: "2" },
      headers: { "x-octopool-public-shape": "actions-jobs-v1" },
    });
    expect(await second.json<RelayEnvelope>()).toMatchObject({
      body: { total_count: 2, jobs: [{ id: 1 }, { id: 2 }] },
      relay: { cache: "hit", route_kind: "run_jobs" },
    });
    expect(upstream).toHaveBeenCalledTimes(4);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count,
                unixepoch(MAX(expires_at)) - unixepoch(MAX(created_at)) AS ttl
         FROM github_cache_entries WHERE route_kind = 'run_jobs'`,
      ).first(),
    ).toEqual({ count: 1, ttl: 3600 });
  });

  it("keeps completed-looking jobs short-lived until the owning attempt is terminal", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = new URL(new Request(input).url);
        urls.push(url.toString());
        if (url.hostname === "github.com" && url.pathname.endsWith("/attempts/2")) {
          return new Response(
            runPage(42, historicalHead, 2)
              .replaceAll("openclaw/Peekaboo", "openclaw/octopool")
              .replace('aria-label="failed: "', 'aria-label="in progress: "')
              .replace(
                '<span class="markdown-title">fixture</span>',
                '<span class="markdown-title">completed successfully: failed pushed workflow dispatch</span>',
              ),
          );
        }
        if (url.hostname === "github.com") {
          return jsonResponse({ message: "public parser unavailable" }, 404);
        }
        if (url.pathname.endsWith("/attempts/2")) {
          return jsonResponse({ id: 42, status: "in_progress", run_attempt: 2 });
        }
        return jsonResponse({
          total_count: 1,
          jobs: [{ id: 1, status: "completed", conclusion: "success" }],
        });
      }),
    );
    const response = await relay(
      "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs",
      undefined,
      {
        query: { per_page: "100" },
        headers: { "x-octopool-public-shape": "actions-jobs-v1" },
      },
    );

    expect(response.status).toBe(200);
    expect(
      await env.DB.prepare(
        `SELECT unixepoch(expires_at) - unixepoch(created_at) AS ttl
         FROM github_cache_entries WHERE route_kind = 'run_jobs'`,
      ).first(),
    ).toEqual({ ttl: 60 });
    expect(urls).toContain("https://github.com/openclaw/octopool/actions/runs/42/attempts/2");
    expect(urls).not.toContain(
      "https://api.github.com/repos/openclaw/octopool/actions/runs/42/attempts/2",
    );
  });

  it("merges and caches all API pages for a 250-job run", async () => {
    const jobAPIRequests: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "github.com") {
        return jsonResponse({ message: "public parser unavailable" }, 404);
      }
      expect(bearer(request)).toBeUndefined();
      if (url.pathname.endsWith("/attempts/2")) {
        return jsonResponse({ id: 42, status: "completed", run_attempt: 2 });
      }
      jobAPIRequests.push(url);
      const page = Number(url.searchParams.get("page"));
      const first = (page - 1) * 100 + 1;
      const count = page === 3 ? 50 : 100;
      return jsonResponse({
        total_count: 250,
        jobs: Array.from({ length: count }, (_, index) => ({
          id: first + index,
          status: "completed",
          conclusion: "success",
        })),
      });
    });
    vi.stubGlobal("fetch", upstream);
    const path = "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs";

    const first = await relay(path, undefined, {
      query: { per_page: "100" },
      headers: { "x-octopool-public-shape": "actions-jobs-v1" },
    });
    expect(await first.json<RelayEnvelope>()).toMatchObject({
      body: { total_count: 250 },
      relay: { cache: "miss", route_kind: "run_jobs" },
    });
    const second = await relay(path, undefined, {
      query: { per_page: "100" },
      headers: { "x-octopool-public-shape": "actions-jobs-v1" },
    });
    expect((await second.json<RelayEnvelope>()).relay.cache).toBe("hit");
    expect(jobAPIRequests.map((url) => url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    const cached = await env.DB.prepare(
      "SELECT body_json FROM github_cache_entries WHERE route_kind = 'run_jobs'",
    ).first<{ body_json: string }>();
    expect(JSON.parse(cached!.body_json)).toMatchObject({ total_count: 250 });
    expect((JSON.parse(cached!.body_json) as { jobs: unknown[] }).jobs).toHaveLength(250);
    expect(
      await env.DB.prepare(
        `SELECT unixepoch(expires_at) - unixepoch(created_at) AS ttl
         FROM github_cache_entries WHERE route_kind = 'run_jobs'`,
      ).first(),
    ).toEqual({ ttl: 3600 });
  });

  it("fails closed above the three-page API bound", async () => {
    const jobAPIRequests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = new URL(new Request(input).url);
        if (url.hostname === "github.com") {
          return jsonResponse({ message: "public parser unavailable" }, 404);
        }
        jobAPIRequests.push(url);
        return jsonResponse({
          total_count: 350,
          jobs: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
        });
      }),
    );
    const response = await relay(
      "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs",
      undefined,
      {
        query: { per_page: "100" },
        headers: { "x-octopool-public-shape": "actions-jobs-v1" },
      },
    );

    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "pagination_exhausted" } },
    });
    expect(jobAPIRequests.map((url) => url.searchParams.get("page"))).toEqual(["1"]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM github_cache_entries WHERE route_kind = 'run_jobs'",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it.each(["rerun count mismatch", "next link with matching count", "next link at cap"])(
    "rejects %s without caching or inventing successful jobs",
    async (variant) => {
      const pages: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input) => {
          const url = new URL(new Request(input).url);
          if (url.hostname === "github.com") {
            return jsonResponse({ message: "public parser unavailable" }, 404);
          }
          expect(url.pathname).toBe("/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs");
          const page = Number(url.searchParams.get("page"));
          pages.push(String(page));
          const atCap = variant === "next link at cap";
          return jsonResponse(
            {
              total_count: atCap ? 300 : variant === "rerun count mismatch" ? 3 : 1,
              jobs: Array.from({ length: atCap ? 100 : 1 }, (_, index) => ({
                id: (page - 1) * 100 + index + 1,
                name: "Swift",
                run_attempt: 2,
                status: "completed",
                conclusion: "success",
              })),
            },
            200,
            variant === "rerun count mismatch"
              ? {}
              : {
                  Link: `<https://api.github.com${url.pathname}?page=${page + 1}>; rel="next"`,
                },
          );
        }),
      );
      const response = await relay(
        "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs",
        undefined,
        {
          query: { per_page: "100" },
          headers: { "x-octopool-public-shape": "actions-jobs-v1" },
        },
      );
      expect(response.status).toBe(424);
      expect(await response.json()).toMatchObject({
        error: { code: "fallback_local", details: { reason: "pagination_exhausted" } },
      });
      expect(pages).toEqual(variant === "next link at cap" ? ["1", "2", "3"] : ["1"]);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM github_cache_entries WHERE route_kind = 'run_jobs'",
        ).first(),
      ).toEqual({ count: 0 });
    },
  );

  it.each([false, true])(
    "preserves the exact attempt job set (reused successes: %s)",
    async (includeReused) => {
      const jobs = [
        ...(includeReused
          ? [
              {
                id: 1,
                name: "actions",
                run_attempt: 1,
                status: "completed",
                conclusion: "success",
              },
              {
                id: 2,
                name: "JavaScript",
                run_attempt: 1,
                status: "completed",
                conclusion: "success",
              },
            ]
          : []),
        { id: 3, name: "Swift", run_attempt: 2, status: "completed", conclusion: "failure" },
      ];
      const apiPaths: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input) => {
          const url = new URL(new Request(input).url);
          if (url.hostname === "github.com") {
            return jsonResponse({ message: "public parser unavailable" }, 404);
          }
          apiPaths.push(url.pathname);
          if (url.pathname.endsWith("/attempts/2")) {
            return jsonResponse({
              id: 42,
              run_attempt: 2,
              status: "completed",
              conclusion: "failure",
            });
          }
          return jsonResponse({ total_count: jobs.length, jobs });
        }),
      );
      const path = "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs";
      const response = await relay(path, undefined, {
        query: { per_page: "100" },
        headers: { "x-octopool-public-shape": "actions-jobs-v1" },
      });
      expect(response.status).toBe(200);
      expect((await response.json<RelayEnvelope>()).body).toEqual({
        total_count: jobs.length,
        jobs,
      });
      expect(apiPaths).toEqual([path, path.replace(/\/jobs$/, "")]);
    },
  );

  it("keeps raw REST metadata exact even when the count includes absent rerun jobs", async () => {
    const body = { total_count: 3, jobs: [{ id: 3, name: "Swift", run_attempt: 2 }] };
    const upstream = vi.fn<typeof fetch>(async () => jsonResponse(body));
    vi.stubGlobal("fetch", upstream);
    const response = await relay("/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs");
    expect(response.status).toBe(200);
    expect((await response.json<RelayEnvelope>()).body).toEqual(body);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("falls back without caching a partial merge when page two fails", async () => {
    const apiRequests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.hostname === "github.com") {
          return jsonResponse({ message: "public parser unavailable" }, 404);
        }
        apiRequests.push(request);
        if (url.searchParams.get("page") === "2") {
          return jsonResponse({ message: "unavailable" }, 503);
        }
        return jsonResponse({
          total_count: 250,
          jobs: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
        });
      }),
    );

    const response = await relay(
      "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs",
      undefined,
      {
        query: { per_page: "100" },
        headers: { "x-octopool-public-shape": "actions-jobs-v1" },
      },
    );

    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "pagination_exhausted" } },
    });
    expect(apiRequests.map((request) => new URL(request.url).searchParams.get("page"))).toEqual([
      "1",
      "2",
    ]);
    expect(apiRequests.every((request) => bearer(request) === undefined)).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM github_cache_entries WHERE route_kind = 'run_jobs'",
      ).first(),
    ).toEqual({ count: 0 });
  });
});
