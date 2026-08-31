import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubCacheKey, writeGitHubCache } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../../src/policy";
import { recordPublicGitHubRepo } from "../../src/public-repos";
import { legacyReleaseKey, releaseMarkdown } from "../fixtures/release-summary";
import { jsonResponse, rateHeaders, relay, seedPool } from "./harness";

const headers = { "x-octopool-public-shape": "release-summary-v1" };
const body = { tag_name: "v0.8.0", draft: false, body: releaseMarkdown };
const lossyBody = "Release notes\n\nFixes\n\n- Keep `inline code`.\n\n- Read the docs.";
type Envelope = { body: typeof body; relay: { cache: string; coalesced?: boolean } };

describe.each(["tags/v0.8.0", "latest"])("release %s body cache", (suffix) => {
  const path = `/repos/openclaw/octopool/releases/${suffix}`;
  beforeEach(seedPool);

  it.each(["edge", "shared"])(
    "retires legacy HTML from %s and preserves new cached source",
    async (layer) => {
      const { request, route, oldKey } = await seedLegacy(path);
      if (layer === "shared") await deleteEdgeJSON("github-v1", oldKey);
      const upstream = mockAPI(path);

      const first = await (await relay(path, undefined, request)).json<Envelope>();
      expect(first.body).toEqual(body);
      expect(first.relay.cache).toBe("miss");
      const key = await githubCacheKey(request.pool, request, route);
      for (const cachedLayer of ["edge", "shared"]) {
        if (cachedLayer === "shared") await deleteEdgeJSON("github-v1", key);
        const cached = await (await relay(path, undefined, request)).json<Envelope>();
        expect(cached.body).toEqual(body);
        expect(cached.relay.cache).toBe("hit");
      }
      expect(upstream).toHaveBeenCalledOnce();
      expect(
        await env.DB.prepare("SELECT body_json FROM github_cache_entries WHERE cache_key = ?")
          .bind(oldKey)
          .first(),
      ).toEqual({ body_json: JSON.stringify({ ...body, body: lossyBody }) });
    },
  );

  it("never serves legacy stale HTML when the anonymous API is unavailable", async () => {
    const { request, oldKey } = await seedLegacy(path);
    await expire(oldKey);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => outageResponse(new Request(input, init))),
    );
    const response = await relay(path, undefined, request);
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({ error: { code: "fallback_local" } });
  });

  it("coalesces exact fills, revalidates only new source, and preserves it during outages", async () => {
    // Even legacy entries carrying an API validator must be ineligible for a 304 revival.
    const { request, route, oldKey } = await seedLegacy(path, true);
    await expire(oldKey);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const conditionals: (string | null)[] = [];
    let phase: "fill" | "revalidate" | "outage" = "fill";
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const upstream = new Request(input, init);
        if (phase === "outage") return outageResponse(upstream);
        expect(upstream.url).toBe(`https://api.github.com${path}`);
        expect(upstream.headers.has("authorization")).toBe(false);
        conditionals.push(upstream.headers.get("if-none-match"));
        if (phase === "fill") {
          started();
          await gate;
          return jsonResponse(body, 200, { ...rateHeaders({ remaining: 59 }), etag: '"raw"' });
        }
        return new Response(null, {
          status: 304,
          headers: { ...rateHeaders({ remaining: 59 }), etag: '"raw"' },
        });
      }),
    );
    const leader = relay(path, undefined, request);
    await entered;
    const follower = relay(path, undefined, request);
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const filled = await Promise.all(
      [leader, follower].map(async (response) => (await response).json<Envelope>()),
    );
    expect(filled.map((item) => item.body)).toEqual([body, body]);
    expect(filled[1]?.relay.coalesced).toBe(true);
    expect(conditionals).toEqual([null]);

    const key = await githubCacheKey(request.pool, request, route);
    await expire(key);
    phase = "revalidate";
    const revalidated = await (await relay(path, undefined, request)).json<Envelope>();
    expect(revalidated.body).toEqual(body);
    expect(revalidated.relay.cache).toBe("hit");
    expect(conditionals).toEqual([null, '"raw"']);
    await expire(key);
    phase = "outage";
    const stale = await (await relay(path, undefined, request)).json<Envelope>();
    expect(stale.body).toEqual(body);
    expect(stale.relay.cache).toBe("stale");
  });
});

async function seedLegacy(path: string, apiValidator = false) {
  const request = validateRelayRequest({ pool: "maintainers", method: "GET", path, headers });
  const route = classifyRoute(request, defaultPolicy("openclaw"));
  const oldKey = await legacyReleaseKey(request, route);
  await recordPublicGitHubRepo(env, route);
  await writeGitHubCache(env, oldKey, request, route, {
    status: 200,
    headers: { ...(apiValidator ? rateHeaders({ remaining: 59 }) : {}), etag: '"legacy"' },
    body: { ...body, body: lossyBody },
    body_encoding: "json",
  });
  return { request, route, oldKey };
}

async function expire(key: string) {
  await env.DB.prepare(
    "UPDATE github_cache_entries SET expires_at = datetime('now', '-1 second'), stale_expires_at = datetime('now', '+1 hour') WHERE cache_key = ?",
  )
    .bind(key)
    .run();
  await deleteEdgeJSON("github-v1", key);
}

function mockAPI(path: string) {
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe(`https://api.github.com${path}`);
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.headers.get("if-none-match")).toBeNull();
    return jsonResponse(body, 200, rateHeaders({ remaining: 59 }));
  });
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

function outageResponse(request: Request) {
  if (request.url === "https://api.github.com/repos/openclaw/octopool") {
    return jsonResponse({ private: false });
  }
  expect(request.url).toMatch(/^https:\/\/api\.github\.com\/repos\/openclaw\/octopool\/releases\//);
  expect(request.headers.has("authorization")).toBe(false);
  return jsonResponse(
    { message: "rate limited" },
    429,
    rateHeaders({ remaining: 0, retryAfter: 60 }),
  );
}
