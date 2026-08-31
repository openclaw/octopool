import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { githubCacheKey, readEdgeGitHubCache, writeGitHubCache } from "../../src/cache";
import { loadIdentities } from "../../src/db";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { bearer, jsonResponse, POOL, seedPool } from "./harness";
import { appIdentity, PATH, requestWithEnv } from "./identity-routing-support";
import { ownedWork } from "./owned-work";

const DIFF = "/repos/openclaw/octopool/pulls/42";
const diffOptions = { headers: { accept: "application/vnd.github.diff" } };
const diffBody = "diff --git a/a b/a\n";
const coordinator = () => poolCoordinatorStub(env, POOL);
const diffResponse = () => new Response(diffBody, { headers: { etag: '"phase-diff"' } });

function upstreamWith(resource: (request: Request) => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
    if (bearer(request) === undefined) return new Response("unavailable", { status: 503 });
    return resource(request);
  });
}
async function warmExpiredDiff() {
  vi.stubGlobal(
    "fetch",
    upstreamWith(() => diffResponse()),
  );
  expect((await requestWithEnv({}, DIFF, diffOptions)).status).toBe(200);
  const rows = await env.DB.prepare("SELECT cache_key FROM github_cache_entries").all<{
    cache_key: string;
  }>();
  for (const row of rows.results) await deleteEdgeJSON("github-v1", row.cache_key);
  await env.DB.prepare(
    "UPDATE github_cache_entries SET expires_at = datetime('now', '-1 second')",
  ).run();
}
async function expectNoFills() {
  expect(
    await runInDurableObject(coordinator(), (_instance, state) =>
      state.storage.sql.exec("SELECT * FROM cache_fills").toArray(),
    ),
  ).toEqual([]);
}

describe("identity selection phase ownership", () => {
  it("F1 reuses the healthy PAT after pooled diff 412 revalidation with max-age zero", async () => {
    await seedPool();
    await warmExpiredDiff();
    const calls: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      upstreamWith((request) => {
        expect(bearer(request)).toBe("test-primary-token");
        calls.push(request.headers.get("if-none-match"));
        return calls.length === 1 ? new Response("precondition", { status: 412 }) : diffResponse();
      }),
    );
    const response = await requestWithEnv({}, DIFF, {
      headers: { ...diffOptions.headers, "cache-control": "max-age=0" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      identity: { id: "primary" },
      body: diffBody,
      relay: { cache: "miss" },
    });
    expect(calls).toEqual(['"phase-diff"', null]);
    expect((await coordinator().snapshot()).cooldowns).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM github_cache_entries WHERE expires_at > datetime('now')",
      ).first(),
    ).toEqual({ count: 1 });
    await expectNoFills();
  });

  it("F1 reuses the successful canonical run-list PAT for the exact filtered continuation", async () => {
    await seedPool();
    const queries: Record<string, string>[] = [];
    vi.stubGlobal(
      "fetch",
      upstreamWith((request) => {
        expect(bearer(request)).toBe("test-primary-token");
        const query = Object.fromEntries(new URL(request.url).searchParams);
        queries.push(query);
        return jsonResponse({
          total_count: 25,
          workflow_runs:
            query.branch === undefined
              ? Array.from({ length: 25 }, (_, id) => ({
                  id,
                  head_branch: "main",
                  status: "completed",
                  conclusion: "success",
                }))
              : [
                  { id: 101, head_branch: "target", status: "completed", conclusion: "success" },
                  { id: 102, head_branch: "target", status: "completed", conclusion: "success" },
                ],
        });
      }),
    );
    const response = await requestWithEnv({}, "/repos/openclaw/octopool/actions/runs", {
      query: { branch: "target", limit: "2" },
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      identity: { id: "primary" },
      body: { workflow_runs: [{ id: 101 }, { id: 102 }] },
    });
    expect(queries).toEqual([
      { page: "1", per_page: "25" },
      { branch: "target", per_page: "2" },
    ]);
    expect(
      await env.DB.prepare(
        "SELECT identity_id, query_json FROM github_cache_entries ORDER BY query_json",
      ).all(),
    ).toMatchObject({
      results: [
        { identity_id: "primary", query_json: '{"branch":"target","per_page":"2"}' },
        { identity_id: "primary", query_json: '{"page":"1","per_page":"25"}' },
      ],
    });
    expect((await coordinator().snapshot()).cooldowns).toEqual([]);
    await expectNoFills();
  });

  it("F2 serves late eligible same-colo edge-only B while A fails and B is cooling", async () => {
    await seedPool({ secondary: true });
    await coordinator().recordCredentialFailure({
      identityId: "secondary",
      reason: "identity_secret_missing",
    });
    const request = { pool: POOL, method: "GET" as const, path: DIFF, ...diffOptions };
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    const identity = (await loadIdentities(env, POOL, route, { fresh: true })).find(
      (item) => item.id === "secondary",
    )!;
    expect(identity.id).toBe("secondary");
    const key = await githubCacheKey(POOL, request, route, identity);
    const entered = ownedWork.gate();
    const release = ownedWork.gate();
    const upstream = upstreamWith(async (request) => {
      expect(bearer(request)).toBe("test-primary-token");
      entered.release();
      await release.promise;
      return new Response("unauthorized", { status: 401 });
    });
    vi.stubGlobal("fetch", upstream);
    const pending = requestWithEnv({ TEST_PAT_SECONDARY: undefined }, DIFF, diffOptions);
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Relay finished before A dispatch");
        }),
      ]);
      const body = diffBody + "x".repeat(270_000);
      expect(
        await writeGitHubCache(
          env,
          key,
          request,
          route,
          { status: 200, headers: {}, body, body_encoding: "text" },
          identity,
        ),
      ).toBe("edge_only");
      expect(await readEdgeGitHubCache(key)).toMatchObject({ body, identity: { id: "secondary" } });
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS count FROM github_cache_entries").first(),
      ).toEqual({ count: 0 });
      release.release();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        identity: { id: "secondary" },
        body,
        relay: { cache: "hit" },
      });
      expect(
        upstream.mock.calls.filter(([input, init]) => bearer(input, init) === "test-primary-token"),
      ).toHaveLength(1);
      expect((await coordinator().snapshot()).cooldowns).toHaveLength(2);
      await expectNoFills();
    } finally {
      release.release();
      await pending;
    }
  });

  it.each(["401", "403", "zero403", "429", "config", "412"])(
    "F3 revalidation %s preserves exhaustion with allowed and disallowed stale",
    async (kind) => {
      await seedPool();
      await warmExpiredDiff();
      const calls: (string | null)[] = [];
      const status = kind === "zero403" ? 403 : Number(kind);
      vi.stubGlobal(
        "fetch",
        upstreamWith((request) => {
          calls.push(request.headers.get("if-none-match"));
          if (kind === "412" && calls.length === 2) return diffResponse();
          return new Response("failure", {
            status,
            headers:
              kind === "zero403"
                ? {
                    "x-ratelimit-remaining": "0",
                    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
                  }
                : {},
          });
        }),
      );
      const overrides = kind === "config" ? { TEST_PAT_PRIMARY: undefined } : {};
      const response = await requestWithEnv(overrides, DIFF, diffOptions);
      if (kind === "config") {
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: { code: "identity_secret_missing" } });
        expect(calls).toEqual([]);
      } else if (kind === "412") {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ body: diffBody, relay: { cache: "miss" } });
        expect(calls).toEqual(['"phase-diff"', null]);
      } else {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          body: diffBody,
          relay: { cache: "stale", stale_reason: "identities_cooling_down" },
        });
        expect(calls).toEqual(['"phase-diff"']);
      }
      // Live cooldowns forbid dispatch; max-age zero must also forbid stale.
      if (kind !== "412") {
        const live = await requestWithEnv(overrides, DIFF, {
          headers: { ...diffOptions.headers, "cache-control": "max-age=0" },
        });
        expect(live.status).toBe(424);
        expect(await live.json()).toMatchObject({
          error: { details: { reason: "identities_cooling_down" } },
        });
        expect(calls).toHaveLength(kind === "config" ? 0 : 1);
      }
      await expectNoFills();
    },
  );

  it.each(["401", "403", "zero403", "429", "config", "412"])(
    "refuses stale for first revalidation %s with max-age zero",
    async (kind) => {
      await seedPool();
      await warmExpiredDiff();
      const calls: (string | null)[] = [];
      vi.stubGlobal(
        "fetch",
        upstreamWith((request) => {
          calls.push(request.headers.get("if-none-match"));
          if (kind === "412" && calls.length === 2) return diffResponse();
          return new Response("failure", {
            status: kind === "zero403" ? 403 : Number(kind),
            headers: kind === "zero403" ? { "x-ratelimit-remaining": "0" } : {},
          });
        }),
      );
      const response = await requestWithEnv(
        kind === "config" ? { TEST_PAT_PRIMARY: undefined } : {},
        DIFF,
        { headers: { ...diffOptions.headers, "cache-control": "max-age=0" } },
      );
      expect(response.status).toBe(kind === "config" ? 503 : kind === "412" ? 200 : 424);
      expect(await response.json()).toMatchObject(
        kind === "config"
          ? { error: { code: "identity_secret_missing" } }
          : kind === "412"
            ? { relay: { cache: "miss" } }
            : { error: { details: { reason: "identities_cooling_down" } } },
      );
      expect(calls).toHaveLength(kind === "config" ? 0 : kind === "412" ? 2 : 1);
    },
  );

  it.each([401, 403, 429])(
    "retains ordinary final %s stale eligibility independently of revalidation",
    async (status) => {
      await seedPool();
      await warmExpiredDiff();
      // No validator: this is an ordinary attempt, not conditional revalidation.
      await env.DB.prepare("UPDATE github_cache_entries SET response_headers_json = '{}'").run();
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        upstreamWith((request) => {
          expect(request.headers.get("if-none-match")).toBeNull();
          calls.push(bearer(request)!);
          return new Response("failure", { status });
        }),
      );
      const response = await requestWithEnv({}, DIFF, diffOptions);
      expect(response.status).toBe(status === 429 ? 200 : 424);
      expect(await response.json()).toMatchObject(
        status === 429
          ? { relay: { cache: "stale", stale_reason: "github_rate_limited" } }
          : {
              error: {
                details: {
                  reason:
                    status === 401 ? "github_identity_unauthorized" : "github_identity_forbidden",
                },
              },
            },
      );
      expect(calls).toEqual(["test-primary-token"]);
    },
  );

  it.each([401, 403, 429])(
    "uses one healthy alternative after revalidation %s instead of retrying the rejected PAT",
    async (status) => {
      await seedPool({ secondary: true });
      await warmExpiredDiff();
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        upstreamWith((request) => {
          const token = bearer(request)!;
          calls.push(token);
          return token === "test-primary-token"
            ? new Response("failure", { status })
            : diffResponse();
        }),
      );
      const response = await requestWithEnv({}, DIFF, {
        headers: { ...diffOptions.headers, "cache-control": "max-age=0" },
      });
      expect(await response.json()).toMatchObject({
        identity: { id: "secondary" },
        body: diffBody,
      });
      expect(calls).toEqual(["test-primary-token", "test-secondary-token"]);
    },
  );

  it("reuses the eligible revalidating PAT after rejecting a 304 for a revoked cache source", async () => {
    await seedPool({ secondary: true });
    await warmExpiredDiff();
    await coordinator().recordResult({
      identityId: "primary",
      routeKey: "other",
      resource: "core",
      status: 401,
      rate: {},
    });
    const calls: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      upstreamWith(async (request) => {
        expect(bearer(request)).toBe("test-secondary-token");
        calls.push(request.headers.get("if-none-match"));
        if (calls.length === 1)
          await env.DB.prepare(
            "UPDATE identities SET status = 'disabled' WHERE id = 'primary'",
          ).run();
        return calls.length === 1 ? new Response(null, { status: 304 }) : diffResponse();
      }),
    );
    const response = await requestWithEnv({}, DIFF, {
      headers: { ...diffOptions.headers, "cache-control": "max-age=0" },
    });
    expect(await response.json()).toMatchObject({ identity: { id: "secondary" }, body: diffBody });
    expect(calls).toEqual(['"phase-diff"', null]);
  });

  it.each(["page-two", "refresh"])(
    "keeps the inherited aggregate %s egress denial hard",
    async (mode) => {
      await seedPool({ secondary: true });
      await appIdentity(mode === "refresh" ? 97001 : 97002);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      let posts = 0;
      let pages = 0;
      vi.stubGlobal(
        "fetch",
        upstreamWith((request) => {
          if (request.method === "POST") {
            posts++;
            return jsonResponse({
              token: "synthetic-hard-denial-app",
              expires_at: new Date(now + 61_000).toISOString(),
            });
          }
          expect(bearer(request)).toBe("synthetic-hard-denial-app");
          if (new URL(request.url).pathname === PATH) return jsonResponse({ private: false });
          pages++;
          if (mode === "refresh") clock.mockReturnValue(now + 1_000);
          return jsonResponse({
            total_count: 101,
            jobs: Array.from({ length: 100 }, (_, id) => ({ id, status: "completed" })),
          });
        }),
      );
      expect((await requestWithEnv()).status).toBe(200);
      await env.DB.prepare("UPDATE string_rewrite_policy SET rules_json = ?")
        .bind(
          JSON.stringify([
            { pattern: mode === "refresh" ? "access_tokens" : "page=2", replacement: "blocked" },
          ]),
        )
        .run();
      const response = await requestWithEnv(
        {},
        "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs",
        { headers: { "x-octopool-public-shape": "actions-jobs-v1" } },
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "string_rewrite_denied" } });
      expect(posts).toBe(1);
      expect(pages).toBe(1);
      expect((await coordinator().snapshot()).cooldowns).toEqual([]);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM github_cache_entries WHERE route_kind = 'run_jobs'",
        ).first(),
      ).toEqual({ count: 0 });
      await expectNoFills();
      clock.mockRestore();
    },
  );
});
