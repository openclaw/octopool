import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { bearer, jsonResponse, POOL, rateHeaders, relay, seedPool } from "./harness";

const path = "/repos/openclaw/octopool/pulls/42";
const snapshot = (head: string) => ({
  data: { repository: { pullRequest: { state: "OPEN", headRefOid: head } } },
});
const options = (shape: string, fresh = false) => ({
  headers: {
    "x-octopool-public-shape": shape,
    ...(fresh ? { "cache-control": "max-age=0" } : {}),
  },
});

type Envelope = {
  status: number;
  body: unknown;
  identity?: { id: string };
  relay: { cache: string };
};

describe("public landing GraphQL cache", () => {
  it.each([
    ["pr-ci-summary-v1", "checkRunCountsByState", "pr"],
    ["pr-ci-rollup-v1", "contexts(first:100,after:$cursor)", "pr"],
    ["pr-merge-snapshot-v1", 'ref(qualifiedName:"refs/heads/main")', "number"],
  ])("pools %s, reuses it, and revalidates once with max-age=0", async (shape, field, variable) => {
    await seedPool();
    let queries = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (request.url === "https://api.github.com/repos/openclaw/octopool") {
          expect(bearer(request)).toBe("test-org-token");
          return jsonResponse({ private: false });
        }
        expect(request.url).toBe("https://api.github.com/graphql");
        expect(request.method).toBe("POST");
        expect(bearer(request)).toBe("test-primary-token");
        const body = (await request.json()) as { query: string; variables: unknown };
        expect(body.variables).toEqual({ owner: "openclaw", name: "octopool", [variable]: 42 });
        expect(body.query).toContain(field);
        expect(body.query).not.toMatch(/viewer|mutation/);
        queries++;
        return jsonResponse(snapshot(`head-${queries}`), 200, {
          ...Object.fromEntries(new Headers(rateHeaders({ remaining: 4_999 - queries }))),
          "x-ratelimit-resource": "graphql",
          etag: '"not-a-graphql-validator"',
        });
      }),
    );

    expect(await (await relay(path, undefined, options(shape))).json<Envelope>()).toMatchObject({
      body: snapshot("head-1"),
      identity: { id: "primary" },
      relay: { cache: "miss" },
    });
    expect(await (await relay(path, undefined, options(shape))).json<Envelope>()).toMatchObject({
      body: snapshot("head-1"),
      relay: { cache: "hit" },
    });
    expect(queries).toBe(1);
    expect(
      await (await relay(path, undefined, options(shape, true))).json<Envelope>(),
    ).toMatchObject({
      body: snapshot("head-2"),
      relay: { cache: "miss" },
    });
    expect(queries).toBe(2);
    expect(await (await relay(path, undefined, options(shape))).json<Envelope>()).toMatchObject({
      body: snapshot("head-2"),
      relay: { cache: "hit" },
    });
    expect(queries).toBe(2);
    const cached = await env.DB.prepare(`SELECT
      unixepoch(expires_at) - unixepoch(created_at) AS ttl,
      unixepoch(stale_expires_at) - unixepoch(expires_at) AS stale,
      response_headers_json AS headers FROM github_cache_entries`).all<{
      ttl: number;
      stale: number;
      headers: string;
    }>();
    expect(cached.results).toHaveLength(1);
    expect(cached.results[0]).toMatchObject({ ttl: 60, stale: 0 });
    expect(JSON.parse(cached.results[0]!.headers)).not.toHaveProperty("etag");
    expect((await poolCoordinatorStub(env, POOL).snapshot()).rates).toMatchObject([
      { identity_id: "primary", resource: "graphql", remaining: 4_997 },
    ]);
  });

  it("keeps GraphQL cursors and REST representations in separate cache entries", async () => {
    await seedPool();
    const queries: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (request.url === "https://api.github.com/repos/openclaw/octopool")
          return jsonResponse({ private: false });
        if (request.url === "https://api.github.com/graphql") {
          const body = (await request.json()) as { variables: { cursor?: string } };
          queries.push(body.variables);
          return jsonResponse(snapshot(body.variables.cursor ?? "first"));
        }
        expect(request.url).toBe(`https://api.github.com${path}`);
        expect(bearer(request)).toBeUndefined();
        return jsonResponse({ number: 42, state: "open" });
      }),
    );
    const first = options("pr-ci-rollup-v1");
    const next = { ...first, query: { cursor: "next-page" } };
    await relay(path, undefined, first);
    expect(await (await relay(path, undefined, next)).json<Envelope>()).toMatchObject({
      body: snapshot("next-page"),
    });
    expect(await (await relay(path, undefined, first)).json<Envelope>()).toMatchObject({
      body: snapshot("first"),
      relay: { cache: "hit" },
    });
    expect(await (await relay(path)).json<Envelope>()).toMatchObject({
      body: { number: 42, state: "open" },
    });
    expect(queries).toEqual([
      { owner: "openclaw", name: "octopool", pr: 42 },
      { owner: "openclaw", name: "octopool", pr: 42, cursor: "next-page" },
    ]);
  });

  it.each([
    { errors: [{ type: "FORBIDDEN", message: "Unavailable" }], ...snapshot("partial") },
    { data: null },
    { data: { repository: { pullRequest: null } } },
  ])("returns GraphQL failures unchanged without caching them: %j", async (body) => {
    await seedPool();
    let queries = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (request.url === "https://api.github.com/repos/openclaw/octopool")
          return jsonResponse({ private: false });
        expect(request.url).toBe("https://api.github.com/graphql");
        queries++;
        return jsonResponse(body);
      }),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        await (await relay(path, undefined, options("pr-ci-summary-v1"))).json<Envelope>(),
      ).toMatchObject({ status: 200, body });
    }
    expect(queries).toBe(2);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM github_cache_entries").first(),
    ).toEqual({ count: 0 });
  });

  it("does not serve an expired landing snapshot during an upstream failure", async () => {
    await seedPool();
    let failed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (request.url === "https://api.github.com/repos/openclaw/octopool")
          return jsonResponse({ private: false });
        expect(request.url).toBe("https://api.github.com/graphql");
        return failed
          ? jsonResponse({ message: "unavailable" }, 503)
          : jsonResponse(snapshot("old"));
      }),
    );
    await relay(path, undefined, options("pr-merge-snapshot-v1"));
    const row = await env.DB.prepare("SELECT cache_key FROM github_cache_entries").first<{
      cache_key: string;
    }>();
    expect(row).not.toBeNull();
    await env.DB.prepare(
      "UPDATE github_cache_entries SET expires_at=datetime('now', '-1 second')",
    ).run();
    await deleteEdgeJSON("github-publication-v1", row!.cache_key);
    failed = true;
    expect(
      await (await relay(path, undefined, options("pr-merge-snapshot-v1"))).json<Envelope>(),
    ).toMatchObject({ status: 503, body: { message: "unavailable" }, relay: { cache: "miss" } });
  });

  it("records HTTP-200 GraphQL quota exhaustion without depleting the core bucket", async () => {
    await seedPool();
    let queries = 0;
    const body = { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (request.url === "https://api.github.com/repos/openclaw/octopool")
          return jsonResponse({ private: false });
        expect(request.url).toBe("https://api.github.com/graphql");
        queries++;
        return jsonResponse(body, 200, rateHeaders({ remaining: 0 }));
      }),
    );
    expect(
      await (await relay(path, undefined, options("pr-ci-summary-v1"))).json<Envelope>(),
    ).toMatchObject({ status: 200, body });
    const coordinator = poolCoordinatorStub(env, POOL);
    expect((await coordinator.snapshot()).rates).toMatchObject([
      { resource: "graphql", remaining: 0 },
    ]);
    expect((await relay(path, undefined, options("pr-ci-summary-v1"))).status).toBe(424);
    expect(queries).toBe(1);
    expect(
      (
        await coordinator.selectIdentity({
          routeKey: "core-read",
          resource: "core",
          candidates: [{ id: "primary", weight: 200 }],
        })
      ).kind,
    ).toBe("selected");
  });

  it("rejects invalid landing shapes before any resource request", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const summary = options("pr-ci-summary-v1");
    const cases: [string, Parameters<typeof relay>[2]][] = [
      [path, { ...summary, query: { cursor: "not-valid-for-summary" } }],
      [path, { ...summary, query: { query: "mutation{deleteRepository}" } }],
      [
        path,
        { ...summary, headers: { ...summary.headers, accept: "application/vnd.github.diff" } },
      ],
      [path, { ...summary, headers: { ...summary.headers, "if-none-match": '"old"' } }],
      ["/repos/openclaw/octopool/issues/42", summary],
      ["/repos/openclaw/octopool/pulls/2147483648", summary],
      [path, { ...options("pr-ci-rollup-v1"), query: { cursor: ["first", "second"] } }],
      [path, { ...options("pr-ci-rollup-v1"), query: { cursor: "prefix\u0001suffix" } }],
      [path, { ...options("pr-ci-rollup-v1"), query: { cursor: "x".repeat(513) } }],
    ];
    for (const [target, requestOptions] of cases) {
      expect((await relay(target, undefined, requestOptions)).status).toBe(424);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("requires public visibility before using a pooled GraphQL identity", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://api.github.com/repos/openclaw/octopool");
      expect(bearer(request)).toBe("test-org-token");
      return jsonResponse({ private: true });
    });
    vi.stubGlobal("fetch", upstream);
    expect((await relay(path, undefined, options("pr-ci-summary-v1"))).status).toBe(424);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
