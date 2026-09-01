import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubCacheKey } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../../src/policy";
import type { Identity } from "../../src/types";
import { opaqueCacheKeys, unchangedJSONKeys } from "../fixtures/opaque-cache-keys";
import { envelopeBytes } from "../fixtures/opaque-bytes";
import { seedPublicRepoProof, writeOwnedGitHubCache } from "./cache-publication-fixture";
import { bearer, jsonResponse, rateHeaders, relay, seedPool } from "./harness";

const fixture = opaqueCacheKeys[0];
const identity: Identity = {
  id: "primary",
  kind: "pat",
  login: "primary",
  secret_ref: "TEST_PAT_PRIMARY",
  installation_id: null,
  weight: 200,
};
type Envelope = { body: unknown; body_encoding: string; relay: { cache: string } };

describe("opaque cache retirement at the Worker", () => {
  beforeEach(seedPool);

  it.each(["edge", "shared", "identity"])(
    "ignores fresh old %s bytes and a late old writer",
    async (layer) => {
      const { request, route } = await seedOld(layer !== "identity");
      if (layer !== "edge") await deleteEdgeJSON("github-publication-v1", fixture.shared);
      const upstream = upstreamBytes();
      const first = await (await relay(request.path, undefined, request)).json<Envelope>();
      expect.soft(envelopeBytes(first)).toEqual([0xff, 0x41]);
      expect.soft(first.relay.cache).toBe("miss");
      await seedOld();
      const calls = upstream.mock.calls.length;
      const second = await (await relay(request.path, undefined, request)).json<Envelope>();
      expect.soft(envelopeBytes(second)).toEqual([0xff, 0x41]);
      expect.soft(second.relay.cache).toBe("hit");
      // Identity hits still run the existing fresh public-repository guard.
      expect(
        upstream.mock.calls.slice(calls).map(([input, init]) => new Request(input, init).url),
      ).toEqual(["https://api.github.com/repos/openclaw/octopool"]);
      expect(
        upstream.mock.calls.filter(
          ([input, init]) => new URL(new Request(input, init).url).pathname === request.path,
        ),
      ).toHaveLength(1);
      expect(
        await env.DB.prepare(
          "SELECT count(*) AS n FROM github_cache_entries WHERE cache_key IN (?, ?) AND body_json = ?",
        )
          .bind(fixture.shared, fixture.identity, JSON.stringify("�A"))
          .first(),
      ).toEqual({ n: 2 });
      expect
        .soft(await githubCacheKey(request.pool, request, route, identity))
        .not.toBe(fixture.identity);
    },
  );

  it("retires old shared and identity validators while retaining new 304 and stale behavior", async () => {
    const { request, route } = await seedOld();
    await expire(fixture.shared);
    await expire(fixture.identity);
    let outage = false;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const fetchRequest = new Request(input, init);
      if (new URL(fetchRequest.url).pathname === "/repos/openclaw/octopool")
        return jsonResponse({ private: false });
      const validator = fetchRequest.headers.get("if-none-match");
      if (outage)
        return jsonResponse(
          { message: "rate limited" },
          429,
          rateHeaders({ remaining: 0, retryAfter: 60 }),
        );
      if (validator !== null)
        return new Response(null, {
          status: 304,
          headers: { etag: validator, ...rateHeaders({ remaining: 4998 }) },
        });
      expect(bearer(fetchRequest)).toBe("test-primary-token");
      return new Response(new Uint8Array([0xff, 0x41]), {
        headers: {
          "content-type": "text/plain",
          etag: '"lossless"',
          ...rateHeaders({ remaining: 4998 }),
        },
      });
    });
    vi.stubGlobal("fetch", upstream);
    const filled = await (await relay(request.path, undefined, request)).json<Envelope>();
    expect.soft(envelopeBytes(filled)).toEqual([0xff, 0x41]);
    expect.soft(filled.relay.cache).toBe("miss");
    expect
      .soft(
        upstream.mock.calls.map(([input, init]) =>
          new Request(input, init).headers.get("if-none-match"),
        ),
      )
      .not.toContain('"old-lossy"');
    const newKey = await githubCacheKey(request.pool, request, route, identity);
    await expire(newKey);
    const revalidated = await (await relay(request.path, undefined, request)).json<Envelope>();
    expect.soft(envelopeBytes(revalidated)).toEqual([0xff, 0x41]);
    expect.soft(revalidated.relay.cache).toBe("hit");
    expect
      .soft(
        upstream.mock.calls.map(([input, init]) =>
          new Request(input, init).headers.get("if-none-match"),
        ),
      )
      .toContain('"lossless"');
    await expire(newKey);
    outage = true;
    const stale = await (await relay(request.path, undefined, request)).json<Envelope>();
    expect.soft(envelopeBytes(stale)).toEqual([0xff, 0x41]);
    expect.soft(stale.relay.cache).toBe("stale");
  });

  it("never serves old shared or identity stale bodies during an outage", async () => {
    const { request } = await seedOld();
    await expire(fixture.shared);
    await expire(fixture.identity);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) =>
        new URL(new Request(input, init).url).pathname === "/repos/openclaw/octopool"
          ? jsonResponse({ private: false })
          : jsonResponse(
              { message: "rate limited" },
              429,
              rateHeaders({ remaining: 0, retryAfter: 60 }),
            ),
      ),
    );
    const response = await relay(request.path, undefined, request);
    const text = await response.text();
    expect.soft(text).not.toContain("�A");
    expect.soft(text).not.toContain('"cache":"stale"');
  });

  it("keeps a frozen default JSON body warm", async () => {
    const frozen = unchangedJSONKeys[0];
    const request = validateRelayRequest(frozen.request);
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    await seedPublicRepoProof(env, route);
    expect(
      await writeOwnedGitHubCache(env, frozen.shared, request, route, {
        status: 200,
        headers: {},
        body: { content: "QQ==", encoding: "base64" },
        body_encoding: "json",
      }),
    ).toBe("shared");
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    expect(await (await relay(request.path, undefined, request)).json()).toMatchObject({
      body: { content: "QQ==" },
      relay: { cache: "hit" },
    });
    expect(upstream).not.toHaveBeenCalled();
  });
});

async function seedOld(shared = true) {
  const request = validateRelayRequest(fixture.request);
  const route = classifyRoute(request, defaultPolicy("openclaw"));
  await seedPublicRepoProof(env, route);
  for (const owner of [undefined, identity]) {
    if (!shared && owner === undefined) continue;
    expect(
      await writeOwnedGitHubCache(
        env,
        owner === undefined ? fixture.shared : fixture.identity,
        request,
        route,
        {
          status: 200,
          headers: {
            "content-type": "text/plain",
            etag: '"old-lossy"',
            ...rateHeaders({ remaining: 4998 }),
          },
          body: "�A",
          body_encoding: "text",
        },
        owner,
      ),
    ).toBe("shared");
  }
  return { request, route };
}

async function expire(key: string) {
  await env.DB.prepare(
    "UPDATE github_cache_entries SET expires_at = datetime('now', '-1 second'), stale_expires_at = datetime('now', '+1 hour') WHERE cache_key = ?",
  )
    .bind(key)
    .run();
  await deleteEdgeJSON("github-publication-v1", key);
}

function upstreamBytes() {
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    if (new URL(new Request(input, init).url).pathname === "/repos/openclaw/octopool")
      return jsonResponse({ private: false });
    expect(bearer(input, init)).toBe("test-primary-token");
    return new Response(new Uint8Array([0xff, 0x41]), {
      headers: { "content-type": "text/plain", ...rateHeaders({ remaining: 4998 }) },
    });
  });
  vi.stubGlobal("fetch", upstream);
  return upstream;
}
