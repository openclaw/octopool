import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { bearer, jsonResponse, relay, seedPool, POOL } from "./harness";
import { githubCacheKey, GITHUB_EDGE_CACHE_NAMESPACE } from "../../src/cache";
import { loadIdentities } from "../../src/db";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { seedPublicRepoProof, writeOwnedGitHubCache } from "./cache-publication-fixture";
import { queries } from "../../src/generated/sql";
import { observePublicationD1 } from "./publication-d1-observer";
import { requestWithEnv } from "./identity-routing-support";
import type { RelayRequest } from "../../src/types";

async function seedFourIdentities() {
  await seedPool({ secondary: true });
  for (const id of ["third", "fourth"]) {
    await env.DB.prepare(
      `INSERT INTO identities (id, pool_id, kind, login, secret_ref, weight, status)
       SELECT ?, pool_id, kind, ?, secret_ref, 50, status FROM identities WHERE id = 'secondary'`,
    )
      .bind(id, id)
      .run();
    await env.DB.prepare(
      `INSERT INTO identity_scopes (identity_id, owner, repo, permission, allow_private) SELECT ?, owner, repo, permission, allow_private FROM identity_scopes WHERE identity_id = 'secondary'`,
    )
      .bind(id)
      .run();
  }
}

describe("cache candidate round trips", () => {
  it.each([undefined, 0])("measures a four-identity pooled miss (max-age=%s)", async (maxAge) => {
    await seedFourIdentities();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const token = bearer(input, init);
        if (token === undefined) return jsonResponse({ message: "unavailable" }, 503);
        if (token === "test-org-token") return jsonResponse({ private: false });
        return jsonResponse({ id: 7, full_name: "openclaw/octopool", private: false });
      }),
    );
    const response = await relay("/repos/openclaw/octopool", undefined, {
      headers: maxAge === undefined ? {} : { "cache-control": `max-age=${maxAge}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ relay: { request_id: string; cache: string } }>();
    expect(body.relay.cache).toBe("miss");
    const audit = await env.DB.prepare(
      "SELECT timings_json, cache_miss_reason FROM audit_events WHERE request_id = ?",
    )
      .bind(body.relay.request_id)
      .first<{ timings_json: string; cache_miss_reason: string | null }>();
    const timing = JSON.parse(audit!.timings_json);
    expect({ d1_ops: timing.d1_ops, cache_lookup: timing.phase_calls.cache_lookup }).toEqual({
      d1_ops: maxAge === 0 ? 8 : 14,
      cache_lookup: maxAge === 0 ? 3 : 19,
    });
    expect(audit!.cache_miss_reason).toBe(maxAge === 0 ? null : "absent");
  });
});

const request: RelayRequest = { pool: POOL, method: "GET", path: "/repos/openclaw/octopool" };
const route = classifyRoute(request, defaultPolicy("openclaw"));

async function seedCandidates(shared = false) {
  await seedPool({ secondary: true });
  const identities = await loadIdentities(env, POOL, route);
  const keys = new Map<string, string>();
  for (const identity of [...identities, ...(shared ? [undefined] : [])]) {
    const id = identity?.id ?? "shared";
    const key = await githubCacheKey(POOL, request, route, identity);
    keys.set(id, key);
    expect(
      await writeOwnedGitHubCache(
        env,
        key,
        request,
        route,
        {
          status: 200,
          headers: { etag: `"${id}"`, "x-ratelimit-resource": "core" },
          body: { id, private: false },
        },
        identity,
      ),
    ).toBe("shared");
  }
  await seedPublicRepoProof(env, route);
  return keys;
}

describe("multi-identity candidate semantics", () => {
  it("sees an identity publication between the initial miss and the pool pass", async () => {
    await seedPool({ secondary: true });
    const identity = (await loadIdentities(env, POOL, route)).find(
      (item) => item.id === "secondary",
    )!;
    const key = await githubCacheKey(POOL, request, route, identity);
    let published = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const token = bearer(input, init);
        if (token === "test-org-token") return jsonResponse({ private: false });
        expect(token).toBeUndefined();
        expect(published).toBe(false);
        published = true;
        expect(
          await writeOwnedGitHubCache(
            env,
            key,
            request,
            route,
            {
              status: 200,
              headers: {},
              body: { id: "concurrent" },
            },
            identity,
          ),
        ).toBe("shared");
        return jsonResponse({ message: "unavailable" }, 503);
      }),
    );
    expect(await (await relay(request.path)).json()).toMatchObject({
      body: { id: "concurrent" },
      identity: { id: "secondary" },
      relay: { cache: "hit" },
    });
    expect(published).toBe(true);
  });

  it("prefers the earlier D1 candidate over the later edge hit", async () => {
    const keys = await seedCandidates();
    await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, keys.get("primary")!);
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    expect(await (await relay(request.path)).json()).toMatchObject({
      body: { id: "primary" },
      identity: { id: "primary" },
      relay: { cache: "hit" },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a prefetched candidate when its identity is revoked after loading", async () => {
    const keys = await seedCandidates();
    await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, keys.get("primary")!);
    let revoked = false;
    const db = observePublicationD1(env.DB, {
      after: async (sql) => {
        if (sql === queries.readGitHubCache && !revoked) {
          revoked = true;
          await env.DB.prepare(
            "UPDATE identities SET status = 'disabled' WHERE id = 'primary'",
          ).run();
        }
      },
    });
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const response = await requestWithEnv({ DB: db }, request.path, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      body: { id: "secondary" },
      identity: { id: "secondary" },
      relay: { cache: "hit" },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([true, false])("keeps anonymous-first validator ordering (shared=%s)", async (shared) => {
    const keys = await seedCandidates(shared);
    await env.DB.prepare(
      "UPDATE github_cache_entries SET created_at = datetime('now', '-20 minutes'), expires_at = datetime('now', '-10 minutes')",
    ).run();
    for (const key of keys.values()) await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, key);
    const expected = shared ? "shared" : "primary";
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const outgoing = new Request(input, init);
      expect(outgoing.headers.get("if-none-match")).toBe(`"${expected}"`);
      return new Response(null, {
        status: 304,
        headers: { etag: `"${expected}"`, "x-ratelimit-resource": "core" },
      });
    });
    vi.stubGlobal("fetch", upstream);
    const response = await relay(request.path, undefined, {
      headers: { "cache-control": "max-age=0" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      body: { id: expected },
      relay: { cache: "hit" },
    });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("retains stale candidate choice and clears the miss reason on upstream failure", async () => {
    const keys = await seedCandidates();
    await env.DB.prepare(`UPDATE github_cache_entries SET response_headers_json = '{}',
      created_at = datetime('now', '-20 minutes'), expires_at = datetime('now', '-10 minutes')`).run();
    for (const key of keys.values()) await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, key);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) =>
        bearer(input, init) === "test-org-token"
          ? jsonResponse({ private: false })
          : jsonResponse({ message: "unavailable" }, 503),
      ),
    );
    const response = await relay(request.path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      body: { id: "primary" },
      identity: { id: "primary" },
      relay: { cache: "stale" },
    });
    expect(
      await env.DB.prepare("SELECT cache_status, cache_miss_reason FROM audit_events").first(),
    ).toEqual({ cache_status: "stale", cache_miss_reason: null });
  });
});
