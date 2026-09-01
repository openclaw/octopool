import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubCacheKey } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../../src/policy";
import type { Identity } from "../../src/types";
import { contentsCacheKeys } from "../fixtures/contents-cache-keys";
import { contentsLinks } from "../fixtures/contents-links";
import { seedPublicRepoProof, writeOwnedGitHubCache } from "./cache-publication-fixture";
import { bearer, jsonResponse, rateHeaders, relay, seedPool } from "./harness";

const frozen = contentsCacheKeys[0];
const expected = contentsLinks[5].body;
const oldURL =
  "https://api.github.com/repos/openclaw/octopool/contents/docs/a#b?c% name🦞.txt?ref=feature%2Ftopic%26mode%3Dfast%23part";
const oldBody = { ...expected, url: oldURL, _links: { ...expected._links, self: oldURL } };
const identity: Identity = {
  id: "primary",
  kind: "pat",
  login: "primary",
  secret_ref: "TEST_PAT_PRIMARY",
  installation_id: null,
  weight: 200,
};
const request = validateRelayRequest(frozen.request);
const route = classifyRoute(request, defaultPolicy("openclaw"));
type Envelope = { body: unknown; relay: { cache: string } };

describe("contents cache retirement at the Worker", () => {
  beforeEach(seedPool);

  it.each(["edge", "shared", "identity"])(
    "ignores fresh old %s objects and late old writers",
    async (layer) => {
      await seedOld(layer !== "identity");
      if (layer !== "edge") await deleteEdgeJSON("github-publication-v1", frozen.shared);
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const fetched = new Request(input, init);
        if (fetched.url === "https://api.github.com/repos/openclaw/octopool")
          return jsonResponse({ private: false });
        expect(fetched.headers.has("if-none-match")).toBe(false);
        if (fetched.url === expected.download_url) {
          expect(bearer(fetched)).toBeUndefined();
          return layer === "identity"
            ? new Response(null, { status: 404 })
            : new Response(new Uint8Array([0, 255, 65]));
        }
        expect(fetched.url).toBe(expected.url);
        if (bearer(fetched) === undefined) return jsonResponse({ message: "unavailable" }, 503);
        expect(bearer(fetched)).toBe("test-primary-token");
        return jsonResponse(expected, 200, rateHeaders({ remaining: 4998 }));
      });
      vi.stubGlobal("fetch", upstream);
      const response = await relay(request.path, undefined, request);
      expect(response.status).toBe(200);
      expect
        .soft(await response.json())
        .toMatchObject({ body: expected, relay: { cache: "miss" } });
      await seedOld();
      const calls = upstream.mock.calls.length;
      expect
        .soft(await (await relay(request.path, undefined, request)).json())
        .toMatchObject({ body: expected, relay: { cache: "hit" } });
      expect(
        upstream.mock.calls.slice(calls).map(([input, init]) => new Request(input, init).url),
      ).toEqual(
        layer === "identity"
          ? [expected.download_url, expected.url, "https://api.github.com/repos/openclaw/octopool"]
          : [],
      );
      expect(
        upstream.mock.calls.filter(
          ([input, init]) => new Request(input, init).url === expected.download_url,
        ),
      ).toHaveLength(layer === "identity" ? 2 : 1);
      expect(
        upstream.mock.calls.filter(([input, init]) => bearer(input, init) === "test-primary-token"),
      ).toHaveLength(layer === "identity" ? 1 : 0);
      expect(
        await env.DB.prepare(
          "SELECT count(*) AS n FROM github_cache_entries WHERE cache_key IN (?, ?) AND body_json = ?",
        )
          .bind(frozen.shared, frozen.identity, JSON.stringify(oldBody))
          .first(),
      ).toEqual({ n: 2 });
      expect.soft(await githubCacheKey(request.pool, request, route)).not.toBe(frozen.shared);
      expect
        .soft(await githubCacheKey(request.pool, request, route, identity))
        .not.toBe(frozen.identity);
    },
  );

  it("retires old validators and preserves new API 304 and stale semantics", async () => {
    await seedOld();
    await expire(frozen.shared);
    await expire(frozen.identity);
    let outage = false;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const fetched = new Request(input, init);
      if (fetched.url === "https://api.github.com/repos/openclaw/octopool")
        return jsonResponse({ private: false });
      if (fetched.url === expected.download_url) return new Response(null, { status: 404 });
      expect(fetched.url).toBe(expected.url);
      if (outage)
        return jsonResponse(
          { message: "rate limited" },
          429,
          rateHeaders({ remaining: 0, retryAfter: 60 }),
        );
      const validator = fetched.headers.get("if-none-match");
      if (validator !== null)
        return new Response(null, {
          status: 304,
          headers: { etag: validator, ...rateHeaders({ remaining: 4998 }) },
        });
      return jsonResponse(expected, 200, {
        etag: '"new-links"',
        ...rateHeaders({ remaining: 4998 }),
      });
    });
    vi.stubGlobal("fetch", upstream);
    const filled = await (await relay(request.path, undefined, request)).json<Envelope>();
    expect.soft(filled).toMatchObject({ body: expected, relay: { cache: "miss" } });
    expect
      .soft(
        upstream.mock.calls.map(([input, init]) =>
          new Request(input, init).headers.get("if-none-match"),
        ),
      )
      .not.toContain('"old-links"');
    const key = await githubCacheKey(request.pool, request, route);
    await expire(key);
    expect
      .soft(await (await relay(request.path, undefined, request)).json())
      .toMatchObject({ body: expected, relay: { cache: "hit" } });
    expect
      .soft(
        upstream.mock.calls.map(([input, init]) =>
          new Request(input, init).headers.get("if-none-match"),
        ),
      )
      .toContain('"new-links"');
    await expire(key);
    outage = true;
    expect
      .soft(await (await relay(request.path, undefined, request)).json())
      .toMatchObject({ body: expected, relay: { cache: "stale" } });
  });

  it("never serves old shared or identity stale links during an outage", async () => {
    await seedOld();
    await expire(frozen.shared);
    await expire(frozen.identity);
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const fetched = new Request(input, init);
      if (fetched.url === "https://api.github.com/repos/openclaw/octopool")
        return jsonResponse({ private: false });
      expect([expected.url, expected.download_url]).toContain(fetched.url);
      return jsonResponse(
        { message: "rate limited" },
        429,
        rateHeaders({ remaining: 0, retryAfter: 60 }),
      );
    });
    vi.stubGlobal("fetch", upstream);
    const response = await relay(request.path, undefined, request);
    expect.soft(response.status).toBe(424);
    const wire = await response.json();
    expect.soft(wire).toMatchObject({ error: { code: "fallback_local" } });
    expect.soft(JSON.stringify(wire)).not.toContain(oldURL);
    expect.soft(JSON.stringify(wire)).not.toContain('"cache":"stale"');
  });

  it("keeps a frozen no-ref JSON contents body warm", async () => {
    const fixture = contentsCacheKeys[4];
    const noRef = validateRelayRequest(fixture.request);
    const noRefRoute = classifyRoute(noRef, defaultPolicy("openclaw"));
    await seedPublicRepoProof(env, noRefRoute);
    const body = { name: "README.md", content: "QQ==", encoding: "base64" };
    expect(
      await writeOwnedGitHubCache(env, fixture.shared, noRef, noRefRoute, {
        status: 200,
        headers: {},
        body,
        body_encoding: "json",
      }),
    ).toBe("shared");
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    expect(await (await relay(noRef.path)).json()).toMatchObject({ body, relay: { cache: "hit" } });
    expect(upstream).not.toHaveBeenCalled();
  });
});

async function seedOld(shared = true) {
  await seedPublicRepoProof(env, route);
  for (const owner of [undefined, identity]) {
    if (!shared && owner === undefined) continue;
    expect(
      await writeOwnedGitHubCache(
        env,
        owner === undefined ? frozen.shared : frozen.identity,
        request,
        route,
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            etag: '"old-links"',
            ...rateHeaders({ remaining: 4998 }),
          },
          body: oldBody,
          body_encoding: "json",
        },
        owner,
      ),
    ).toBe("shared");
  }
}

async function expire(key: string) {
  await env.DB.prepare(
    "UPDATE github_cache_entries SET expires_at = datetime('now', '-1 second'), stale_expires_at = datetime('now', '+1 hour') WHERE cache_key = ?",
  )
    .bind(key)
    .run();
  await deleteEdgeJSON("github-publication-v1", key);
}
