import { writeOwnedGitHubCache as writeGitHubCache } from "./cache-publication-fixture";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubCacheKey } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { sanitizeGitHubResponse } from "../../src/github-sanitize";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../../src/policy";
import { seedPublicRepoProof as recordPublicGitHubRepo } from "./cache-publication-fixture";
import type { Identity } from "../../src/types";
import { issueEventCases, legacyIssueEventKey } from "../fixtures/issue-event-visibility";
import { jsonResponse, rateHeaders, relay, seedPool } from "./harness";

type Envelope = {
  status: number;
  body: unknown;
  identity?: unknown;
  headers: Record<string, string>;
  relay: { cache: string; stale_ok: boolean; stale_reason?: string };
};

const legacyIdentity: Identity = {
  id: "primary",
  kind: "pat",
  login: "primary",
  secret_ref: "TEST_PAT_PRIMARY",
  installation_id: null,
  weight: 200,
};

describe.each(issueEventCases)("$kind anonymous visibility at the Worker boundary", (fixture) => {
  const { path, publicBody, privilegedBody } = fixture;
  const request = validateRelayRequest({ pool: "maintainers", method: "GET", path });
  const route = classifyRoute(request, defaultPolicy("openclaw"));
  beforeEach(seedPool);

  function mockUpstream(publicResponse: (request: Request) => Response) {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const upstream = new Request(input, init);
        calls.push(upstream);
        if (upstream.url === "https://api.github.com/repos/openclaw/octopool") {
          return jsonResponse({ private: false });
        }
        if (new URL(upstream.url).pathname !== path) {
          return jsonResponse({ message: "unavailable" }, 503);
        }
        return upstream.headers.has("authorization")
          ? jsonResponse(privilegedBody, 200, apiHeaders('"private"'))
          : publicResponse(upstream);
      }),
    );
    return calls;
  }

  it.each(["if-none-match", "if-modified-since"])(
    "keeps %s on the anonymous transport despite a proven-public target",
    async (header) => {
      await recordPublicGitHubRepo(env, route);
      const calls = mockUpstream(() => jsonResponse(publicBody, 200, apiHeaders('"public"')));
      const value = header === "if-none-match" ? '"old-client"' : "Sat, 01 Aug 2026 12:00:00 GMT";
      const response = await relay(path, undefined, { headers: { [header]: value } });
      expect(response.status).toBe(200);
      const envelope = await response.json<Envelope>();
      // Red proof exposes the enclosing source.issue after repository becomes null.
      expect(envelope.body).toEqual(publicBody);
      expect(envelope.identity).toBeUndefined();
      expect(envelope.relay.cache).toBe("bypass");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.headers.has("authorization")).toBe(false);
      expect(calls[0]!.headers.get(header)).toBe(value);
      expect(await cacheRows()).toEqual([]);
      expect(
        await env.DB.prepare("SELECT identity_id, backend, cache_status FROM audit_events").first(),
      ).toEqual({ identity_id: null, backend: "github_api", cache_status: "bypass" });
    },
  );

  it("serves exact public events directly and from edge and D1 without a repo probe", async () => {
    const calls = mockUpstream(() => jsonResponse(publicBody, 200, apiHeaders('"public"')));
    for (const layer of ["miss", "edge", "shared"]) {
      if (layer === "shared")
        await deleteEdgeJSON(
          "github-publication-v1",
          await githubCacheKey(request.pool, request, route),
        );
      const response = await relay(path);
      expect(response.status).toBe(200);
      const envelope = await response.json<Envelope>();
      expect(envelope.body).toEqual(publicBody);
      expect(envelope.identity).toBeUndefined();
      expect(envelope.relay.cache).toBe(layer === "miss" ? "miss" : "hit");
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.github.com${path}`);
    expect(calls[0]!.headers.has("authorization")).toBe(false);
    expect(await cacheRows()).toEqual([
      expect.objectContaining({ identity_id: null, body_json: JSON.stringify(publicBody) }),
    ]);
  });

  it("passes anonymous 304 through without reviving a legacy body", async () => {
    const oldKey = await legacyIssueEventKey(request, route);
    await writeGitHubCache(env, oldKey, request, route, {
      status: 200,
      headers: apiHeaders('"legacy-private"'),
      body: privilegedBody,
      body_encoding: "json",
    });
    const before = await cacheRows();
    const calls = mockUpstream(
      () => new Response(null, { status: 304, headers: apiHeaders('"public"') }),
    );
    const response = await relay(path, undefined, { headers: { "if-none-match": '"client"' } });
    expect(response.status).toBe(200);
    const envelope = await response.json<Envelope>();
    expect(envelope).toMatchObject({
      status: 304,
      body: null,
      headers: { etag: '"public"' },
      relay: { cache: "bypass" },
    });
    expect(envelope.identity).toBeUndefined();
    const eventCalls = calls.filter((call) => new URL(call.url).pathname === path);
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0]!.headers.has("authorization")).toBe(false);
    expect(eventCalls[0]!.headers.get("if-none-match")).toBe('"client"');
    // A 304 is not a new repository proof; the existing metadata guard still runs.
    expect(
      calls.filter((call) => new URL(call.url).pathname === "/repos/openclaw/octopool"),
    ).toHaveLength(1);
    expect(await cacheRows()).toEqual(before);
  });

  it("preserves pagination, API version, response headers, and no-content status", async () => {
    const link = `<https://api.github.com${path}?page=3>; rel="next"`;
    const calls = mockUpstream(
      () => new Response(null, { status: 204, headers: { etag: '"empty"', link } }),
    );
    const response = await relay(path, undefined, {
      query: { page: "2", per_page: "10" },
      headers: { "x-github-api-version": "2022-11-28", "if-none-match": '"client"' },
    });
    expect(await response.json()).toMatchObject({
      status: 204,
      body: null,
      body_encoding: "text",
      headers: { etag: '"empty"', link },
      relay: { cache: "bypass" },
    });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.toString()).toBe("page=2&per_page=10");
    expect(calls[0]!.headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(calls[0]!.headers.has("authorization")).toBe(false);
    expect(await cacheRows()).toEqual([]);
  });

  it("hands unsupported media to native credentials without trying a pool", async () => {
    const calls = mockUpstream(() => jsonResponse(publicBody));
    const response = await relay(path, undefined, {
      headers: { accept: "application/vnd.github.full+json" },
    });
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "web_only_unavailable" } },
    });
    expect(calls).toEqual([]);
    expect(await cacheRows()).toEqual([]);
  });

  it.each([403, 429, 503])(
    "falls back safely on anonymous %i without using a pool",
    async (status) => {
      await recordPublicGitHubRepo(env, route);
      const calls = mockUpstream(() =>
        jsonResponse({ message: "unavailable" }, status, rateHeaders({ remaining: 0 })),
      );
      for (const headers of [{}, { "if-none-match": '"old-client"' }]) {
        const response = await relay(path, undefined, { headers });
        expect(await response.json()).toMatchObject({
          error: { code: "fallback_local", details: { reason: "web_only_unavailable" } },
        });
        expect(response.status).toBe(424);
      }
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => !call.headers.has("authorization"))).toBe(true);
      expect(await cacheRows()).toEqual([]);
    },
  );

  it.each(["edge", "shared", "stale"])(
    "retires legacy privileged %s bodies and validators",
    async (layer) => {
      await recordPublicGitHubRepo(env, route);
      const oldKeys: string[] = [];
      for (const identity of [undefined, legacyIdentity]) {
        const key = await legacyIssueEventKey(request, route, identity);
        oldKeys.push(key);
        await writeGitHubCache(
          env,
          key,
          request,
          route,
          sanitizeGitHubResponse(route, {
            status: 200,
            headers: apiHeaders('"legacy-private"'),
            body: privilegedBody,
            body_encoding: "json",
          }),
          identity,
        );
        if (layer === "stale") await expire(key);
        if (layer === "shared") await deleteEdgeJSON("github-publication-v1", key);
      }
      const before = await cacheRows();
      const calls = mockUpstream((upstream) =>
        upstream.headers.has("if-none-match")
          ? new Response(null, { status: 304, headers: apiHeaders('"legacy-private"') })
          : jsonResponse(publicBody, 200, apiHeaders('"public"')),
      );
      const response = await relay(path);
      const envelope = await response.json<Envelope>();
      expect(envelope.body).toEqual(publicBody);
      expect(envelope.relay.cache).toBe("miss");
      expect(envelope.identity).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.headers.has("authorization")).toBe(false);
      expect(calls[0]!.headers.has("if-none-match")).toBe(false);
      const key = await githubCacheKey(request.pool, request, route);
      expect(oldKeys).not.toContain(key);
      expect((await cacheRows()).filter((row) => oldKeys.includes(row.cache_key))).toEqual(before);
    },
  );

  it("never uses legacy stale data during anonymous failure", async () => {
    await recordPublicGitHubRepo(env, route);
    for (const identity of [undefined, legacyIdentity]) {
      const key = await legacyIssueEventKey(request, route, identity);
      await writeGitHubCache(
        env,
        key,
        request,
        route,
        {
          status: 200,
          headers: apiHeaders('"legacy"'),
          body: privilegedBody,
          body_encoding: "json",
        },
        identity,
      );
      await expire(key);
    }
    const before = await cacheRows();
    const calls = mockUpstream(() => jsonResponse({ message: "unavailable" }, 503));
    const response = await relay(path);
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "web_only_unavailable" } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.has("authorization")).toBe(false);
    expect(calls[0]!.headers.has("if-none-match")).toBe(false);
    expect(await cacheRows()).toEqual(before);
  });

  it("revalidates new anonymous data and bounds stale fallback by age and retention", async () => {
    let phase: "fill" | "revalidate" | "outage" = "fill";
    const calls = mockUpstream((upstream) => {
      if (phase === "outage") return jsonResponse({ message: "unavailable" }, 503);
      if (phase === "revalidate") {
        expect(upstream.headers.get("if-none-match")).toBe('"public"');
        return new Response(null, { status: 304, headers: apiHeaders('"public"') });
      }
      return jsonResponse(publicBody, 200, apiHeaders('"public"'));
    });
    expect((await relay(path)).status).toBe(200);
    const key = await githubCacheKey(request.pool, request, route);
    await expire(key);
    phase = "revalidate";
    const revalidated = await (await relay(path)).json<Envelope>();
    expect(revalidated.body).toEqual(publicBody);
    expect(revalidated.relay.cache).toBe("hit");
    phase = "outage";
    await expire(key);
    const stale = await (await relay(path)).json<Envelope>();
    expect(stale.body).toEqual(publicBody);
    expect(stale.relay).toMatchObject({
      cache: "stale",
      stale_ok: true,
      stale_reason: "web_only_unavailable",
    });
    expect(
      (await relay(path, undefined, { headers: { "cache-control": "max-age=0" } })).status,
    ).toBe(424);
    await env.DB.prepare(
      "UPDATE github_cache_entries SET stale_expires_at = datetime('now', '-1 second') WHERE cache_key = ?",
    )
      .bind(key)
      .run();
    expect((await relay(path)).status).toBe(424);
    expect(calls.every((call) => !call.headers.has("authorization"))).toBe(true);
  });

  it("rejects stale public events after the target repository becomes private", async () => {
    mockUpstream(() => jsonResponse(publicBody, 200, apiHeaders('"public"')));
    expect((await relay(path)).status).toBe(200);
    await expire(await githubCacheKey(request.pool, request, route));
    await env.DB.prepare("DELETE FROM github_public_repo_proofs").run();
    await deleteEdgeJSON("public-repo-publication-v1", "openclaw/octopool");
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const upstream = new Request(input, init);
        calls.push(upstream);
        return new URL(upstream.url).pathname === path
          ? jsonResponse({ message: "unavailable" }, 503)
          : jsonResponse({ private: true });
      }),
    );
    const response = await relay(path);
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({ error: { code: "fallback_local" } });
    expect(
      calls
        .filter((call) => new URL(call.url).pathname === path)
        .every((call) => !call.headers.has("authorization")),
    ).toBe(true);
  });
});

async function expire(key: string) {
  await env.DB.prepare(
    "UPDATE github_cache_entries SET expires_at = datetime('now', '-1 second'), stale_expires_at = datetime('now', '+1 hour') WHERE cache_key = ?",
  )
    .bind(key)
    .run();
  await deleteEdgeJSON("github-publication-v1", key);
}

function cacheRows() {
  return env.DB.prepare(
    "SELECT cache_key, identity_id, body_json FROM github_cache_entries ORDER BY cache_key",
  )
    .all<{ cache_key: string; identity_id: string | null; body_json: string }>()
    .then((rows) => rows.results);
}

function apiHeaders(etag: string) {
  return { ...rateHeaders({ remaining: 59 }), etag };
}
