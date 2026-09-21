import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { deleteEdgeJSON } from "../../src/edge-cache";
import {
  bearer,
  CALLER_TOKEN,
  callWorker,
  jsonResponse,
  POOL,
  rateHeaders,
  relay,
  seedPool,
} from "./harness";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { githubCacheKey } from "../../src/cache";
import { loadIdentities } from "../../src/db";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { seedPublicRepoProof, writeOwnedGitHubCache } from "./cache-publication-fixture";
import { ownedWork } from "./owned-work";
import { exactRun, historicalHead, runPage } from "../fixtures/actions-ownership";
import { queries } from "../../src/generated/sql";
import { requestWithEnv } from "./identity-routing-support";
import { observePublicationD1 } from "./publication-d1-observer";

const RUN_PATH = "/repos/openclaw/octopool/actions/runs/123";

type RelayEnvelope = {
  status: number;
  body: { id?: number; status?: string; content?: string } | null;
  relay: { cache: string; coalesced?: boolean; route_kind: string };
};

describe("Worker end-to-end cache revalidation", () => {
  it.each([
    { shaped: true, pageWorks: true },
    { shaped: true, pageWorks: false },
    { shaped: false, pageWorks: true },
  ])("orders PR pages before stored API validators: %j", async ({ shaped, pageWorks }) => {
    await seedPool();
    const path = "/repos/openclaw/octopool/pulls/11";
    const options = { headers: shaped ? { "x-octopool-public-shape": "pr-summary-v1" } : {} };
    const calls: string[] = [];
    let warm = true;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(bearer(request)).toBeUndefined();
        if (new URL(request.url).hostname === "github.com") {
          calls.push("page");
          if (warm || !pageWorks) return new Response(null, { status: 503 });
          return new Response(
            `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({
              payload: {
                pullRequestsLayoutRoute: {
                  pullRequest: {
                    number: 11,
                    relayId: "PR_fixture",
                    title: "Live page",
                    state: "OPEN",
                    createdTime: "2026-09-20T00:00:00Z",
                    closedTime: null,
                    mergedTime: null,
                    headBranch: "fix",
                    headSha: "a".repeat(40),
                    baseBranch: "main",
                  },
                  repository: { ownerLogin: "openclaw", name: "octopool" },
                },
              },
            })}</script>`,
          );
        }
        expect(request.url).toBe(`https://api.github.com${path}`);
        calls.push(request.headers.get("if-none-match") ?? "api");
        return warm
          ? jsonResponse({ number: 11, title: "Stored API" }, 200, apiHeaders('"stored"'))
          : new Response(null, { status: 304, headers: apiHeaders('"stored"') });
      }),
    );
    expect((await relay(path, undefined, options)).status).toBe(200);
    await expireCacheEntry("pr_view");
    warm = false;
    calls.length = 0;
    const response = await relay(path, undefined, options);
    expect(response.status).toBe(200);
    const usedPage = shaped && pageWorks;
    expect(await response.json()).toMatchObject({
      body: { title: usedPage ? "Live page" : "Stored API" },
      relay: { cache: usedPage ? "miss" : "hit" },
    });
    expect(calls).toEqual(usedPage ? ["page"] : shaped ? ["page", '"stored"'] : ['"stored"']);
    expect(
      await env.DB.prepare(
        "SELECT backend, fallback_reason FROM audit_events ORDER BY rowid DESC LIMIT 1",
      ).first(),
    ).toEqual({
      backend: usedPage ? "github_web" : "github_api",
      fallback_reason: usedPage ? null : "cache_revalidated",
    });
  });

  it("skips zero-age body reads through identity fallback while retaining validators and owners", async () => {
    await seedPool({ secondary: true });
    let warm = true;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const token = bearer(request);
        if (warm) return jsonResponse({ id: 123 }, 200, apiHeaders('"stored"'));
        if (token === "test-org-token") return jsonResponse({ private: false });
        calls.push(token ?? request.headers.get("if-none-match") ?? "anonymous");
        if (token === "test-secondary-token")
          return jsonResponse({ id: 123 }, 200, rateHeaders({ remaining: 4999 }));
        return new Response(null, { status: 429 });
      }),
    );
    expect((await relay(RUN_PATH)).status).toBe(200);
    warm = false;
    const reads: string[] = [];
    const db = observePublicationD1(env.DB, {
      before: async (sql) => {
        reads.push(sql);
      },
    });
    const edge = vi.spyOn(caches.default, "match");
    const response = await requestWithEnv({ DB: db }, RUN_PATH, {
      headers: { "cache-control": "max-age=0" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      identity: { id: "secondary" },
      body: { id: 123 },
    });
    expect(calls).toEqual(['"stored"', "test-primary-token", "test-secondary-token"]);
    expect(reads.filter((sql) => sql === queries.readGitHubCache)).toHaveLength(0);
    expect(reads.filter((sql) => sql === queries.readGitHubCacheAny)).toHaveLength(3);
    expect(
      edge.mock.calls.filter(([request]) =>
        String(request instanceof Request ? request.url : request).includes(
          "github-publication-v1",
        ),
      ),
    ).toHaveLength(0);
    // Successful publication proves the upstream path retained its fenced fill owner.
    expect(
      await env.DB.prepare(
        "SELECT identity_id FROM github_cache_entries WHERE identity_id = 'secondary'",
      ).first(),
    ).toEqual({ identity_id: "secondary" });
  });

  it("does not retry depleted anonymous quota for completed-jobs proof", async () => {
    await seedPool();
    const path = `${RUN_PATH}/attempts/2/jobs`;
    const body = {
      total_count: 1,
      jobs: [{ id: 42, run_id: 123, run_attempt: 2, status: "completed" }],
    };
    let warm = true;
    const anonymous: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
        if (bearer(request) === "test-primary-token")
          return jsonResponse(body, 200, rateHeaders({ remaining: 4999 }));
        if (new URL(request.url).hostname === "github.com")
          return new Response(null, { status: 404 });
        if (new URL(request.url).pathname === path) {
          if (warm) return jsonResponse(body, 200, apiHeaders('"jobs"'));
          expect(request.headers.get("if-none-match")).toBe('"jobs"');
        }
        if (!warm) anonymous.push(new URL(request.url).pathname);
        return new Response(null, { status: 429 });
      }),
    );
    expect((await relay(path)).status).toBe(200);
    warm = false;
    expect(
      (await relay(path, undefined, { headers: { "cache-control": "max-age=0" } })).status,
    ).toBe(200);
    expect(anonymous).toEqual([path]);
  });

  it.each<{
    scenario: string;
    status: number;
    headers: Record<string, string>;
    attempts: number;
    jobs?: boolean;
    fresh?: boolean;
    privateRepo?: boolean;
  }>([
    {
      scenario: "depleted core quota",
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
      attempts: 1,
    },
    { scenario: "429 response", status: 429, headers: {}, attempts: 1 },
    {
      scenario: "explicit retry window",
      status: 403,
      headers: { "retry-after": "30" },
      attempts: 1,
    },
    {
      scenario: "forced-fresh jobs",
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
      attempts: 1,
      jobs: true,
      fresh: true,
    },
    {
      scenario: "upstream permission refusal",
      status: 403,
      headers: { "x-ratelimit-remaining": "58" },
      attempts: 2,
    },
    { scenario: "transient server failure", status: 503, headers: {}, attempts: 2 },
    {
      scenario: "repository becomes private",
      status: 429,
      headers: {},
      attempts: 1,
      privateRepo: true,
    },
  ])("avoids a repeated anonymous throttled request: $scenario", async (test) => {
    await seedPool();
    const path = RUN_PATH + (test.jobs ? "/jobs" : "");
    const body = test.jobs
      ? { total_count: 1, jobs: [{ id: 42, status: "completed" }] }
      : { id: 123, status: "completed" };
    let phase: "warm" | "throttled" | "next" = "warm";
    const anonymous: boolean[] = [];
    let canceled = 0;
    let pooled = 0;
    let visibilityChecks = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (bearer(request) === "test-org-token") {
          visibilityChecks++;
          return jsonResponse({ private: test.privateRepo === true });
        }
        if (bearer(request) === "test-primary-token") {
          pooled++;
          return jsonResponse(body, 200, rateHeaders({ remaining: 4_999 }));
        }
        expect(bearer(request)).toBeUndefined();
        if (phase !== "throttled") return jsonResponse(body, 200, apiHeaders('"before"'));
        anonymous.push(request.headers.has("if-none-match"));
        return new Response(
          new ReadableStream({
            cancel() {
              canceled++;
            },
          }),
          {
            status: test.status,
            headers: { ...rateHeaders({ remaining: 58 }), ...test.headers },
          },
        );
      }),
    );
    expect((await relay(path)).status).toBe(200);
    await expireCacheEntry(test.jobs ? "run_jobs" : "run_view");
    phase = "throttled";
    const response = await relay(path, undefined, {
      headers: test.fresh ? { "cache-control": "max-age=0" } : {},
    });
    expect(anonymous).toEqual(test.attempts === 1 ? [true] : [true, false]);
    expect(canceled).toBe(test.attempts);
    expect(visibilityChecks).toBe(1);
    if (test.privateRepo) {
      expect(response.status).toBe(424);
      expect(await response.json()).toMatchObject({
        error: { details: { reason: "repo_not_public" } },
      });
      expect(pooled).toBe(0);
      return;
    }
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      body,
      identity: { id: "primary" },
      relay: { cache: "miss" },
    });
    expect(pooled).toBe(1);
    expect((await poolCoordinatorStub(env, POOL).snapshot()).cooldowns).toEqual([]);
    phase = "next";
    const next = await relay(path, undefined, { headers: { "cache-control": "max-age=0" } });
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ body, relay: { backend: "web", cache: "miss" } });
    expect(pooled).toBe(1);
  });

  it.each([false, true])(
    "prefers the public HTML alternative and retains its policy guard (denied: %s)",
    async (denied) => {
      await seedPool();
      const path = "/repos/openclaw/Peekaboo/actions/runs/42";
      const options = { headers: { "x-octopool-public-shape": "actions-summary-v1" } };
      let warm = true;
      let anonymous = 0;
      let pages = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          expect(bearer(request)).toBeUndefined();
          if (new URL(request.url).hostname === "github.com") {
            if (warm) return new Response(null, { status: 404 });
            pages++;
            return new Response(runPage(42, historicalHead));
          }
          if (warm) return jsonResponse(exactRun(42), 200, apiHeaders('"before"'));
          anonymous++;
          expect(request.headers.get("if-none-match")).toBe('"before"');
          return new Response(null, { status: 429 });
        }),
      );
      expect((await relay(path, undefined, options)).status).toBe(200);
      await expireCacheEntry("run_view");
      warm = false;
      if (denied) {
        const policy = await callWorker("/v1/admin/string-rewrites", {
          method: "PUT",
          headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" },
          body: JSON.stringify({
            schema_version: 1,
            expected_revision: 1,
            rules: [{ pattern: "^https://github[.]com/openclaw/Peekaboo", replacement: "public" }],
          }),
        });
        expect(policy.status).toBe(200);
      }
      const response = await relay(path, undefined, options);
      expect(anonymous).toBe(0);
      if (denied) {
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: "string_rewrite_denied" } });
        expect(pages).toBe(0);
      } else {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          body: { id: 42, head_sha: historicalHead },
          relay: { backend: "web", cache: "miss" },
        });
        expect(pages).toBe(1);
      }
    },
  );

  it.each([
    { failure: "http", status: 500, maxAge: undefined, stale: true },
    { failure: "http", status: 502, maxAge: undefined, stale: true },
    { failure: "http", status: 503, maxAge: undefined, stale: true },
    { failure: "http", status: 504, maxAge: undefined, stale: true },
    { failure: "network", status: 200, maxAge: undefined, stale: true },
    { failure: "runtime", status: 200, maxAge: undefined, stale: true },
    { failure: "timeout", status: 200, maxAge: undefined, stale: true },
    { failure: "body", status: 200, maxAge: undefined, stale: true },
    { failure: "http", status: 503, maxAge: 0, stale: false },
    { failure: "http", status: 503, maxAge: 20, stale: false },
    { failure: "network", status: 200, maxAge: 0, stale: false },
    { failure: "runtime", status: 200, maxAge: 0, stale: false },
    { failure: "unknown", status: 200, maxAge: undefined, stale: false },
    { failure: "locked", status: 200, maxAge: undefined, stale: false },
    { failure: "http", status: 404, maxAge: undefined, stale: false },
    { failure: "http", status: 422, maxAge: undefined, stale: false },
    { failure: "http", status: 501, maxAge: undefined, stale: false },
    { failure: "http", status: 503, maxAge: undefined, stale: true, path: "/users/octocat" },
    { failure: "network", status: 200, maxAge: undefined, stale: true, path: "/users/octocat" },
    { failure: "http", status: 503, maxAge: 0, stale: false, path: "/users/octocat" },
  ])(
    "handles $failure/$status with cache bound $maxAge (stale: $stale, path: $path)",
    async ({ failure, status, maxAge, stale, path = RUN_PATH }) => {
      await seedPool();
      let failing = false;
      const routeKind = path === RUN_PATH ? "run_view" : "user_view";
      const warmBody =
        path === RUN_PATH ? { id: 123, status: "in_progress" } : { id: 8, login: "octocat" };
      const cacheMetadata = () =>
        env.DB.prepare(
          "SELECT created_at, expires_at, stale_expires_at FROM github_cache_entries WHERE route_kind = ?",
        )
          .bind(routeKind)
          .first();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
          expect(request.url).toBe(`https://api.github.com${path}`);
          if (!failing) return jsonResponse(warmBody);
          if (failure === "network") throw new TypeError("Synthetic network failure");
          if (failure === "runtime") throw new Error("Synthetic platform transport failure");
          if (failure === "timeout") throw new DOMException("Synthetic timeout", "TimeoutError");
          if (failure === "unknown") {
            const response = jsonResponse(warmBody);
            Object.defineProperty(response, "headers", {
              get() {
                throw new Error("Synthetic post-fetch header failure");
              },
            });
            return response;
          }
          if (failure === "locked") {
            const response = jsonResponse({ id: 123, status: "completed" });
            response.body!.getReader();
            return response;
          }
          if (failure === "body") {
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new TypeError("Synthetic response stream failure"));
                },
              }),
              { headers: { "content-type": "application/json" } },
            );
          }
          return jsonResponse(
            { message: "upstream failure" },
            status,
            rateHeaders({ remaining: 4_999 }),
          );
        }),
      );
      expect((await relay(path)).status).toBe(200);
      await expireCacheEntry(routeKind);
      const cached = await cacheMetadata();
      failing = true;
      const response = await relay(path, undefined, {
        headers: maxAge === undefined ? {} : { "cache-control": `max-age=${maxAge}` },
      });
      const wire = await response.json();
      if (stale) {
        expect(response.status).toBe(200);
        expect(wire).toMatchObject({
          status: 200,
          body: warmBody,
          relay: { cache: "stale", stale_ok: true },
        });
        expect(await cacheMetadata()).toEqual(cached);
      } else if (failure === "http") {
        expect(response.status).toBe(200);
        expect(wire).toMatchObject({ status });
        expect(wire).toHaveProperty(
          "body",
          path === RUN_PATH ? { message: "upstream failure" } : {},
        );
      } else {
        expect(response.status).toBe(500);
        expect(wire).toMatchObject({ error: { code: "internal_error" } });
      }
      if (failure === "http" && path === RUN_PATH) {
        expect((await poolCoordinatorStub(env, POOL).snapshot()).rates).toEqual([
          expect.objectContaining({ identity_id: "primary", remaining: 4_999 }),
        ]);
      }
    },
  );

  it.each([true, false])(
    "reuses a fresh identity entry before upstream reads (validator: %s)",
    async (validator) => {
      await seedPool();
      let anonymousAvailable = false;
      const resourceRequests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
          expect(request.url).toBe(`https://api.github.com${RUN_PATH}`);
          const identity = bearer(request) === "test-primary-token";
          resourceRequests.push(identity ? "identity" : "anonymous");
          if (!identity && !anonymousAvailable)
            return jsonResponse({ message: "unavailable" }, 503);
          return jsonResponse({ id: 123, status: identity ? "in_progress" : "completed" }, 200, {
            ...rateHeaders({ remaining: 4_999 }),
            ...(validator ? { etag: '"run-v1"' } : {}),
          });
        }),
      );
      expect(await (await relay(RUN_PATH)).json()).toMatchObject({
        body: { status: "in_progress" },
        identity: { id: "primary" },
        relay: { cache: "miss" },
      });
      const firstRequests = [...resourceRequests];
      anonymousAvailable = true;
      expect(await (await relay(RUN_PATH)).json()).toMatchObject({
        body: { status: "in_progress" },
        identity: { id: "primary" },
        relay: { cache: "hit" },
      });
      expect(resourceRequests).toEqual(firstRequests);
      expect(
        await env.DB.prepare(
          "SELECT backend, cache_status, fallback_reason FROM audit_events ORDER BY rowid DESC LIMIT 1",
        ).first(),
      ).toEqual({ backend: null, cache_status: "hit", fallback_reason: null });

      expect(
        await (
          await relay(RUN_PATH, undefined, { headers: { "cache-control": "max-age=0" } })
        ).json(),
      ).toMatchObject({ body: { status: "completed" }, relay: { cache: "miss" } });
      expect(resourceRequests).toEqual([...firstRequests, "anonymous"]);
    },
  );

  it("does not reuse a secondary-limited revalidation identity for another route", async () => {
    await seedPool({ secondary: true });
    let limited = false;
    let primaryRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const token = bearer(request);
        if (token === "test-org-token") return jsonResponse({ private: false });
        if (token === "test-primary-token") {
          primaryRequests++;
          return limited
            ? jsonResponse(
                { message: "You have exceeded a secondary rate limit." },
                403,
                rateHeaders({ remaining: 4_998 }),
              )
            : jsonResponse({ id: 123, status: "in_progress" }, 200, {
                ...rateHeaders({ remaining: 4_999 }),
                etag: '"identity-run"',
              });
        }
        if (token === "test-secondary-token")
          return jsonResponse({ id: 123, status: "completed" }, 200);
        return jsonResponse({ message: "anonymous unavailable" }, 503);
      }),
    );
    await relay(RUN_PATH);
    await expireCacheEntry("run_view");
    limited = true;
    for (const path of [RUN_PATH, "/repos/openclaw/octopool/issues/42"]) {
      expect(await (await relay(path)).json()).toMatchObject({ identity: { id: "secondary" } });
    }
    expect(primaryRequests).toBe(2);
    expect((await poolCoordinatorStub(env, POOL).snapshot()).cooldowns).toEqual([
      expect.objectContaining({ identity_id: "primary", route_key: "*", status: 403 }),
    ]);
  });

  it.each(["network", "timeout"])(
    "recovers an asynchronous %s failure in explicit public API revalidation",
    async (failure) => {
      await seedPool();
      const path = "/users/octocat";
      let fullCalls = 0;
      let conditionalCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          expect(request.url).toBe(`https://api.github.com${path}`);
          expect(bearer(request)).toBeUndefined();
          if (request.headers.get("if-none-match") === '"user-v1"') {
            conditionalCalls++;
            await Promise.resolve();
            if (failure === "timeout") throw new DOMException("Synthetic timeout", "TimeoutError");
            throw new TypeError("Synthetic network failure");
          }
          fullCalls++;
          return jsonResponse(
            { id: 8, login: "octocat", name: fullCalls === 1 ? "Before" : "After" },
            200,
            apiHeaders('"user-v1"'),
          );
        }),
      );
      expect((await relay(path)).status).toBe(200);
      await expireCacheEntry("user_view");
      const refreshed = await relay(path);
      expect(refreshed.status).toBe(200);
      expect(await refreshed.json<RelayEnvelope>()).toMatchObject({
        body: { id: 8, name: "After" },
        relay: { backend: "github_public", cache: "miss", route_kind: "user_view" },
      });
      expect(await (await relay(path)).json<RelayEnvelope>()).toMatchObject({
        body: { id: 8, name: "After" },
        relay: { cache: "hit" },
      });
      expect({ fullCalls, conditionalCalls }).toEqual({ fullCalls: 2, conditionalCalls: 1 });
    },
  );

  // Persisted audit/stats must describe this API verifier, not the materialized body.
  // Existing native 304 coverage omitted backend/identity accounting; no new seam.
  it.each([
    [undefined, "etag"],
    [0, "etag"],
    [20, "etag"],
    [undefined, "last-modified"],
  ] as const)(
    "refreshes an anonymous API entry on 304 with max-age=%s and %s",
    async (maxAge, validator) => {
      await seedPool();
      let apiCalls = 0;
      const value = validator === "etag" ? '"run-v1"' : "Mon, 31 Aug 2026 00:00:00 GMT";
      const validatorHeader = validator === "etag" ? "if-none-match" : "if-modified-since";
      const headers = { ...rateHeaders({ remaining: 59 }), [validator]: value };
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(bearer(request)).toBeUndefined();
        expect(request.url).toBe(`https://api.github.com${RUN_PATH}`);
        apiCalls++;
        if (request.headers.get(validatorHeader) === value) {
          return new Response(null, { status: 304, headers });
        }
        return jsonResponse({ id: 123, status: "in_progress", conclusion: null }, 200, headers);
      });
      vi.stubGlobal("fetch", upstream);

      await relay(RUN_PATH);
      await expireCacheEntry("run_view");
      const response = await relay(RUN_PATH, undefined, {
        headers: maxAge === undefined ? {} : { "cache-control": `max-age=${maxAge}` },
      });

      expect(await response.json<RelayEnvelope>()).toMatchObject({
        status: 200,
        body_encoding: "json",
        headers: { [validator]: value },
        body: { id: 123, status: "in_progress" },
        relay: { backend: "web", cache: "hit", route_kind: "run_view" },
      });
      expect(apiCalls).toBe(2);
      expect(
        await env.DB.prepare(
          `SELECT unixepoch(expires_at) - unixepoch(created_at) AS ttl
         FROM github_cache_entries WHERE route_kind = 'run_view'`,
        ).first(),
      ).toEqual({ ttl: 60 });
      expect(
        await env.DB.prepare(
          "SELECT backend, identity_id, status, cache_status, fallback_reason FROM audit_events ORDER BY rowid DESC LIMIT 1",
        ).first(),
      ).toEqual({
        backend: "github_api",
        identity_id: null,
        status: 200,
        cache_status: "hit",
        fallback_reason: "cache_revalidated",
      });
      const shared = await relay(RUN_PATH);
      expect(await shared.json<RelayEnvelope>()).toMatchObject({
        body: { id: 123, status: "in_progress" },
        relay: { cache: "hit" },
      });
      expect(apiCalls).toBe(2);
      await expectAnonymousAuditStats(true);
    },
  );

  // Conditional 200 uses the actual API payload marker; observe stored audits and stats.
  // This extends the real replacement fixture rather than testing a private classifier.
  it.each([undefined, 0, 20])(
    "stores a conditional 200 replacement with max-age=%s",
    async (maxAge) => {
      await seedPool();
      let apiCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          expect(request.url).toBe(`https://api.github.com${RUN_PATH}`);
          apiCalls++;
          if (request.headers.get("if-none-match") === '"run-v1"') {
            return jsonResponse(
              { id: 123, status: "completed", conclusion: "success" },
              200,
              apiHeaders('"run-v2"'),
            );
          }
          return jsonResponse(
            { id: 123, status: "in_progress", conclusion: null },
            200,
            apiHeaders('"run-v1"'),
          );
        }),
      );

      await relay(RUN_PATH);
      await expireCacheEntry("run_view");
      const response = await relay(RUN_PATH, undefined, {
        headers: maxAge === undefined ? {} : { "cache-control": `max-age=${maxAge}` },
      });

      expect(await response.json<RelayEnvelope>()).toMatchObject({
        body: { id: 123, status: "completed" },
        relay: { cache: "miss", route_kind: "run_view" },
      });
      expect(apiCalls).toBe(2);
      expect(
        await env.DB.prepare(
          "SELECT backend, identity_id, status, cache_status, fallback_reason FROM audit_events ORDER BY rowid DESC LIMIT 1",
        ).first(),
      ).toEqual({
        backend: "github_api",
        identity_id: null,
        status: 200,
        cache_status: "miss",
        fallback_reason: null,
      });
      expect(
        await env.DB.prepare(
          `SELECT json_extract(body_json, '$.status') AS status,
                unixepoch(expires_at) - unixepoch(created_at) AS ttl
         FROM github_cache_entries WHERE route_kind = 'run_view'`,
        ).first(),
      ).toEqual({ status: "completed", ttl: 60 });
      const shared = await relay(RUN_PATH);
      expect(await shared.json<RelayEnvelope>()).toMatchObject({
        body: { id: 123, status: "completed" },
        relay: { cache: "hit" },
      });
      expect(apiCalls).toBe(2);
      await expectAnonymousAuditStats(false);
    },
  );

  it.each([202, 204])(
    "publishes a %i replacement response without a second fill",
    async (replacementStatus) => {
      await seedPool();
      let apiCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          if (request.url !== `https://api.github.com${RUN_PATH}`) {
            return new Response("unavailable", { status: 503 });
          }
          apiCalls++;
          if (request.headers.get("if-none-match") === '"run-v1"') {
            return replacementStatus === 204
              ? new Response(null, { status: 204, headers: apiHeaders('"run-v2"') })
              : jsonResponse(
                  { id: 123, status: "queued" },
                  replacementStatus,
                  apiHeaders('"run-v2"'),
                );
          }
          return jsonResponse({ id: 123, status: "in_progress" }, 200, apiHeaders('"run-v1"'));
        }),
      );

      await relay(RUN_PATH);
      await expireCacheEntry("run_view");
      const replacement = await relay(RUN_PATH);

      expect(await replacement.json<RelayEnvelope>()).toMatchObject({
        status: replacementStatus,
        body: replacementStatus === 204 ? null : { id: 123, status: "queued" },
        relay: { cache: "miss", route_kind: "run_view" },
      });
      const cached = await relay(RUN_PATH);
      expect(await cached.json<RelayEnvelope>()).toMatchObject({
        status: replacementStatus,
        body: replacementStatus === 204 ? null : { id: 123, status: "queued" },
        relay: { cache: "hit", route_kind: "run_view" },
      });
      expect(apiCalls).toBe(2);
      expect(
        await env.DB.prepare(
          "SELECT status, body_json FROM github_cache_entries WHERE route_kind = 'run_view'",
        ).first(),
      ).toEqual({
        status: replacementStatus,
        body_json: replacementStatus === 204 ? "null" : '{"id":123,"status":"queued"}',
      });
    },
  );

  it("falls through to the normal anonymous fill when identity loading fails", async () => {
    await seedPool();
    let apiCalls = 0;
    let conditionalCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (request.url !== `https://api.github.com${RUN_PATH}`) {
          return new Response("unavailable", { status: 503 });
        }
        apiCalls++;
        if (request.headers.has("if-none-match") || request.headers.has("if-modified-since")) {
          conditionalCalls++;
        }
        return jsonResponse(
          { id: 123, status: apiCalls === 1 ? "in_progress" : "completed" },
          200,
          apiHeaders('"run-v1"'),
        );
      }),
    );

    await relay(RUN_PATH);
    await expireCacheEntry("run_view");
    await env.DB.prepare("ALTER TABLE identities RENAME TO unavailable_identities").run();
    const response = await relay(RUN_PATH);

    expect(await response.json<RelayEnvelope>()).toMatchObject({
      body: { id: 123, status: "completed" },
      relay: { cache: "miss", route_kind: "run_view" },
    });
    expect(apiCalls).toBe(2);
    expect(conditionalCalls).toBe(0);
  });

  it("uses the normal fill chain when an API entry has no validator", async () => {
    await seedPool();
    let apiCalls = 0;
    let conditionalCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        apiCalls++;
        if (request.headers.has("if-none-match") || request.headers.has("if-modified-since")) {
          conditionalCalls++;
        }
        return jsonResponse(
          { id: 123, status: apiCalls === 1 ? "in_progress" : "completed" },
          200,
          rateHeaders({ remaining: 59 }),
        );
      }),
    );

    await relay(RUN_PATH);
    await expireCacheEntry("run_view");
    const response = await relay(RUN_PATH);

    expect(await response.json<RelayEnvelope>()).toMatchObject({
      body: { status: "completed" },
      relay: { cache: "miss" },
    });
    expect(apiCalls).toBe(2);
    expect(conditionalCalls).toBe(0);
  });

  it("does not send web-origin validators to the GitHub API", async () => {
    await seedPool();
    const path = "/repos/openclaw/octopool/pulls/42";
    const options = { headers: { accept: "application/vnd.github.diff" } };
    const webURL = "https://github.com/openclaw/octopool/pull/42.diff";
    const oldBody = "diff --git a/old b/old\n";
    const newBody = "diff --git a/new b/new\n";
    let webCalls = 0;
    let conditionalCalls = 0;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.headers.has("if-none-match") || request.headers.has("if-modified-since")) {
        conditionalCalls++;
      }
      expect(request.url).toBe(webURL);
      expect(bearer(request)).toBeUndefined();
      webCalls++;
      return new Response(webCalls === 1 ? oldBody : newBody, {
        headers: { etag: '"web-etag"', "content-type": "text/x-diff" },
      });
    });
    vi.stubGlobal("fetch", upstream);

    expect((await relay(path, undefined, options)).status).toBe(200);
    await expireCacheEntry("pr_view");
    const response = await relay(path, undefined, options);

    expect(await response.json()).toMatchObject({
      body: newBody,
      body_encoding: "text",
      relay: { cache: "miss", route_kind: "pr_view" },
    });
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(webCalls).toBe(2);
    expect(conditionalCalls).toBe(0);
  });

  it("falls through to a fresh fill when a 304 source identity is revoked", async () => {
    await seedPool();
    let phase: "prime" | "revalidate" = "prime";
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const token = bearer(request);
      if (token === "test-org-token") {
        return jsonResponse({ private: false });
      }
      if (token === "test-primary-token") {
        return jsonResponse({ id: 123, status: "in_progress" }, 200, apiHeaders('"identity-run"'));
      }
      if (phase === "prime") {
        return jsonResponse({ message: "anonymous unavailable" }, 503);
      }
      if (request.headers.get("if-none-match") === '"identity-run"') {
        await env.DB.prepare(
          "UPDATE identities SET status = 'disabled' WHERE id = 'primary'",
        ).run();
        return new Response(null, { status: 304, headers: apiHeaders('"identity-run"') });
      }
      return jsonResponse({ id: 123, status: "completed" }, 200, apiHeaders('"anonymous-run"'));
    });
    vi.stubGlobal("fetch", upstream);

    await relay(RUN_PATH);
    await expireCacheEntry("run_view");
    phase = "revalidate";
    const response = await relay(RUN_PATH);

    expect(await response.json<RelayEnvelope>()).toMatchObject({
      body: { id: 123, status: "completed" },
      relay: { cache: "miss", route_kind: "run_view" },
    });
    expect(
      upstream.mock.calls.filter(([input, init]) => {
        const request = new Request(input, init);
        return request.headers.get("if-none-match") === '"identity-run"';
      }),
    ).toHaveLength(1);
  });

  // Behavior: the anonymous verifier owns audit attribution while original source
  // eligibility and body storage retain their contracts. Gap: no native cross-source
  // audit proof existed; reuse the actual owned publication fixture and stats endpoint.
  it("audits an anonymous 304 of an eligible identity body without pooled quota", async () => {
    await seedPool();
    const request = { pool: POOL, method: "GET" as const, path: RUN_PATH };
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    const identity = (await loadIdentities(env, POOL, route))[0]!;
    const key = await githubCacheKey(POOL, request, route, identity);
    await seedPublicRepoProof(env, route);
    expect(
      await writeOwnedGitHubCache(
        env,
        key,
        request,
        route,
        {
          status: 200,
          headers: apiHeaders('"identity-run"') as Record<string, string>,
          body: { id: 123, status: "in_progress" },
          body_encoding: "json",
        },
        identity,
      ),
    ).toBe("shared");
    await expireCacheEntry("run_view");
    const original = await env.DB.prepare("SELECT * FROM github_cache_entries WHERE cache_key = ?")
      .bind(key)
      .first();
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`https://api.github.com${RUN_PATH}`);
      expect(bearer(request)).toBeUndefined();
      expect(request.headers.get("if-none-match")).toBe('"identity-run"');
      return new Response(null, { status: 304, headers: apiHeaders('"identity-run"') });
    });
    vi.stubGlobal("fetch", upstream);
    const result = await (await relay(RUN_PATH)).json<Record<string, unknown>>();
    expect(result).toMatchObject({
      status: 200,
      body: { id: 123, status: "in_progress" },
      body_encoding: "json",
      relay: { backend: "web", cache: "hit" },
    });
    expect(result).not.toHaveProperty("identity");
    expect(result).not.toHaveProperty("upstreamBackend");
    expect(
      await env.DB.prepare("SELECT * FROM github_cache_entries WHERE cache_key = ?")
        .bind(key)
        .first(),
    ).toEqual(original);
    expect(
      await env.DB.prepare(
        "SELECT identity_id, body_json FROM github_cache_entries WHERE cache_key != ?",
      )
        .bind(key)
        .first(),
    ).toEqual({ identity_id: null, body_json: '{"id":123,"status":"in_progress"}' });
    expect(
      await env.DB.prepare(
        "SELECT backend, identity_id, status, cache_status, fallback_reason FROM audit_events",
      ).first(),
    ).toEqual({
      backend: "github_api",
      identity_id: null,
      status: 200,
      cache_status: "hit",
      fallback_reason: "cache_revalidated",
    });
    await relay(RUN_PATH);
    await expectAnonymousAuditStats(true, 1);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("fails closed before authenticated revalidation when a repository becomes private", async () => {
    await seedPool();
    const path = "/repos/openclaw/octopool/pulls/42";
    const options = { headers: { accept: "application/vnd.github.diff" } };
    let privateRepo = false;
    let authenticatedCallsAfterPrivate = 0;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const token = bearer(request);
      if (request.url === "https://github.com/openclaw/octopool/pull/42.diff") {
        return new Response("unavailable", { status: 503 });
      }
      if (token === "test-org-token") {
        return jsonResponse({ private: privateRepo });
      }
      if (token === "test-primary-token") {
        if (privateRepo) {
          authenticatedCallsAfterPrivate++;
        }
        return new Response("diff --git a/a b/a\n", {
          headers: {
            "content-type": "text/plain",
            etag: '"private-boundary"',
            ...rateHeaders({ remaining: 4_999 }),
          },
        });
      }
      throw new Error(`unexpected upstream ${request.url}`);
    });
    vi.stubGlobal("fetch", upstream);

    const primed = await relay(path, undefined, options);
    expect(primed.status).toBe(200);
    await expireCacheEntry("pr_view");
    privateRepo = true;

    const response = await relay(path, undefined, options);

    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "repo_not_public" } },
    });
    expect(authenticatedCallsAfterPrivate).toBe(0);
    expect(
      upstream.mock.calls.filter(([input, init]) => {
        const request = new Request(input, init);
        return (
          bearer(request) === "test-primary-token" &&
          request.headers.get("if-none-match") === '"private-boundary"'
        );
      }),
    ).toHaveLength(0);
  });

  it.each(["limit", "per_page"])(
    "keeps filtered run lists complete after coalescing pooled revalidation (%s)",
    async (pageSizeField) => {
      await seedPool();
      const path = "/repos/openclaw/octopool/actions/runs";
      // A JSON media parameter keeps this request on the pooled API transport.
      const headers = {
        accept: "application/json; charset=utf-8",
        "x-octopool-public-shape": "actions-summary-v1",
      };
      const canonical = {
        pool: POOL,
        method: "GET" as const,
        path,
        query: { page: "1", per_page: "25" },
        headers,
      };
      const route = classifyRoute(canonical, defaultPolicy("openclaw"));
      const identity = (await loadIdentities(env, POOL, route))[0]!;
      const key = await githubCacheKey(POOL, canonical, route, identity);
      await seedPublicRepoProof(env, route);
      expect(
        await writeOwnedGitHubCache(
          env,
          key,
          canonical,
          route,
          {
            status: 200,
            headers: apiHeaders('"canonical-v1"') as Record<string, string>,
            body: canonicalRunListBody(),
            body_encoding: "json",
          },
          identity,
        ),
      ).toBe("shared");
      await expireCacheEntry("run_list");

      const revalidationEntered = ownedWork.gate();
      const secondPastFreshScan = ownedWork.gate();
      const revalidation = ownedWork.gate();
      let publicChecks = 0;
      let conditionalCalls = 0;
      let exactCalls = 0;
      const exactBody = {
        total_count: 3,
        workflow_runs: [101, 102].map((id) => ({
          id,
          head_branch: "target",
          status: "completed",
          conclusion: "success",
        })),
      };
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (bearer(request) === "test-org-token") {
            if (++publicChecks === 2) secondPastFreshScan.release();
            return jsonResponse({ private: false });
          }
          expect(bearer(request)).toBe("test-primary-token");
          expect(url.pathname).toBe(path);
          if (url.searchParams.get("branch") === "target") {
            exactCalls++;
            expect(url.searchParams.get("per_page")).toBe("2");
            return jsonResponse(exactBody, 200, apiHeaders('"exact-v1"'));
          }
          expect(request.headers.get("if-none-match")).toBe('"canonical-v1"');
          conditionalCalls++;
          revalidationEntered.release();
          await revalidation.promise;
          return new Response(null, { status: 304, headers: apiHeaders('"canonical-v1"') });
        }),
      );

      const options = { query: { branch: "target", [pageSizeField]: "2" }, headers };
      const requests = [relay(path, undefined, options)];
      try {
        await revalidationEntered.promise;
        requests.push(relay(path, undefined, options));
        // The second request has missed fresh identity cache and entered revalidation.
        await secondPastFreshScan.promise;
        revalidation.release();
        const responses = await Promise.all(
          requests.map(async (request) => (await request).json()),
        );
        expect(responses).toEqual([
          expect.objectContaining({ body: exactBody }),
          expect.objectContaining({ body: exactBody }),
        ]);
        expect(conditionalCalls).toBe(1);
        expect(exactCalls).toBe(1);
      } finally {
        revalidation.release();
        await Promise.allSettled(requests);
      }
    },
  );

  it("rejects legacy filtered run-list entries containing a canonical body during an outage", async () => {
    await seedPool();
    const request = {
      pool: POOL,
      method: "GET" as const,
      path: "/repos/openclaw/octopool/actions/runs",
      query: { page: "1", per_page: "25" },
      headers: {
        accept: "application/json; charset=utf-8",
        "x-octopool-public-shape": "actions-summary-v1",
      },
    };
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    const identity = (await loadIdentities(env, POOL, route))[0]!;
    await seedPublicRepoProof(env, route);
    // Captured before retirement: the old writer stored its canonical body/query
    // under both the canonical key and branch=target&per_page=2's exact key.
    for (const key of [
      "GhPsgPpelA5QOLajBiXGCgTUaCUfheCcw8lA13ysQmk",
      "Z3AMVklaYXj1u4QyCOKXGmaBVgTMDGH822vWBw-slTs",
    ]) {
      expect(
        await writeOwnedGitHubCache(
          env,
          key,
          request,
          route,
          {
            status: 200,
            headers: apiHeaders('"legacy-canonical"') as Record<string, string>,
            body: canonicalRunListBody(),
            body_encoding: "json",
          },
          identity,
        ),
      ).toBe("shared");
    }
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const fetched = new Request(input, init);
      if (bearer(fetched) === "test-org-token") return jsonResponse({ private: false });
      return jsonResponse(
        { message: "API rate limit exceeded" },
        429,
        rateHeaders({ remaining: 0, retryAfter: 60 }),
      );
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(request.path, undefined, {
      headers: request.headers,
      query: { branch: "target", per_page: "2" },
    });
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({ error: { code: "fallback_local" } });
    expect(upstream).toHaveBeenCalled();
  });

  it("publishes a 304 refresh to coalesced waiters", async () => {
    await seedPool();
    let revalidationStarted!: () => void;
    const { promise: gate, release: releaseRevalidation } = ownedWork.gate();
    const started = new Promise<void>((resolve) => {
      revalidationStarted = resolve;
    });
    let conditionalCalls = 0;
    let publicRepoChecks = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (request.url === "https://api.github.com/repos/openclaw/octopool") {
          publicRepoChecks++;
          return jsonResponse({ private: false });
        }
        expect(request.url).toBe(`https://api.github.com${RUN_PATH}`);
        if (request.headers.get("if-none-match") === '"run-v1"') {
          conditionalCalls++;
          revalidationStarted();
          await gate;
          return new Response(null, { status: 304, headers: apiHeaders('"run-v1"') });
        }
        return jsonResponse({ id: 123, status: "in_progress" }, 200, apiHeaders('"run-v1"'));
      }),
    );

    await relay(RUN_PATH);
    await expireCacheEntry("run_view");
    // Cover the original entry, but require the follower to refresh proof for the new timestamp.
    await env.DB.prepare(
      `UPDATE github_public_repo_proofs
       SET checked_at = datetime(
         (SELECT created_at FROM github_cache_entries WHERE route_kind = 'run_view' LIMIT 1),
         '-5 seconds'
       )
       WHERE owner = 'openclaw' AND repo = 'octopool'`,
    ).run();
    await deleteEdgeJSON("public-repo-publication-v1", "openclaw/octopool");
    const leader = relay(RUN_PATH);
    const requests = [leader];
    try {
      await started;
      const follower = relay(RUN_PATH);
      requests.push(follower);
      // Outlast the first 4s coalescing wait while the leader still owns its 8s fill lease.
      // A follower must wait/claim again instead of starting another conditional request.
      await new Promise((resolve) => setTimeout(resolve, 4_250));
      const conditionalCallsBeforePublish = conditionalCalls;
      releaseRevalidation();
      const envelopes = await Promise.all(
        [leader, follower].map(async (responsePromise) =>
          (await responsePromise).json<RelayEnvelope>(),
        ),
      );

      expect(envelopes).toEqual([
        expect.objectContaining({
          body: expect.objectContaining({ id: 123, status: "in_progress" }),
          relay: expect.objectContaining({ cache: "hit" }),
        }),
        expect.objectContaining({
          body: expect.objectContaining({ id: 123, status: "in_progress" }),
          relay: expect.objectContaining({ cache: "hit", coalesced: true }),
        }),
      ]);
      expect(conditionalCallsBeforePublish).toBe(1);
      expect(conditionalCalls).toBe(1);
      expect(publicRepoChecks).toBe(1);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE fallback_reason = 'cache_revalidated'",
        ).first(),
      ).toEqual({ count: 1 });
    } finally {
      releaseRevalidation();
      await Promise.allSettled(requests);
    }
  });
});

function canonicalRunListBody() {
  return {
    total_count: 200,
    workflow_runs: Array.from({ length: 25 }, (_, index) => ({
      id: 201 + index,
      head_branch: "main",
      status: "completed",
      conclusion: "success",
    })),
  };
}

async function expireCacheEntry(routeKind: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT cache_key FROM github_cache_entries WHERE route_kind = ? LIMIT 1",
  )
    .bind(routeKind)
    .first<{ cache_key: string }>();
  expect(row).not.toBeNull();
  await env.DB.prepare(
    `UPDATE github_cache_entries
     SET created_at = datetime('now', '-180 seconds'),
         expires_at = datetime('now', '-1 second'),
         stale_expires_at = datetime('now', '+1 hour')
     WHERE cache_key = ?`,
  )
    .bind(row!.cache_key)
    .run();
  await deleteEdgeJSON("github-publication-v1", row!.cache_key);
}

function apiHeaders(etag: string): HeadersInit {
  return { ...rateHeaders({ remaining: 59 }), etag };
}

async function expectAnonymousAuditStats(revalidated: boolean, requests = 2): Promise<void> {
  expect(
    await env.DB.prepare(
      "SELECT backend, identity_id, status, cache_status, fallback_reason FROM audit_events ORDER BY rowid DESC LIMIT 1",
    ).first(),
  ).toEqual({
    backend: null,
    identity_id: null,
    status: 200,
    cache_status: "hit",
    fallback_reason: null,
  });
  const stats = await callWorker(`/v1/pools/${POOL}/stats`, {
    headers: { authorization: `Bearer ${CALLER_TOKEN}` },
  });
  expect(stats.status).toBe(200);
  expect(await stats.json()).toMatchObject({
    pool_usage: {
      cache_served_responses: revalidated ? 2 : 1,
      uncached_outcomes: revalidated ? requests - 1 : requests,
      saved_github_requests: revalidated ? 2 : 1,
      backend_requests: revalidated ? requests - 1 : requests,
    },
    backends: [
      {
        backend: "github_api",
        route_kind: "run_view",
        requests,
        cache_misses: revalidated ? requests - 1 : requests,
        revalidated: revalidated ? 1 : 0,
      },
    ],
  });
  expect((await poolCoordinatorStub(env, POOL).snapshot()).rates).toEqual([]);
  expect(
    await env.DB.prepare(
      "SELECT remaining FROM github_public_api_rates WHERE resource = 'core'",
    ).first(),
  ).toEqual({ remaining: 59 });
}
