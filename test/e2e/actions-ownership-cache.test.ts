import { writeOwnedGitHubCache as writeGitHubCache } from "./cache-publication-fixture";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubCacheKey } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../../src/policy";
import { seedPublicRepoProof as recordPublicGitHubRepo } from "./cache-publication-fixture";
import { runListSupersetView } from "../../src/run-list-superset";
import { legacyActionsKey } from "../fixtures/actions-legacy-cache";
import { exactRun, historicalHead, runIDs, wrongPatchHead } from "../fixtures/actions-ownership";
import { jsonResponse, rateHeaders, relay, seedPool } from "./harness";
import { ownedWork } from "./owned-work";

const headers = { "x-octopool-public-shape": "actions-summary-v1" };
const path = `/repos/openclaw/Peekaboo/actions/runs/${runIDs[0]}`;
type Envelope = { body: unknown; relay: { cache: string; coalesced?: boolean } };

describe("Actions ownership cache migration", () => {
  beforeEach(seedPool);

  it.each([
    [path, "edge"],
    [path, "shared"],
    [`${path}/attempts/1`, "edge"],
    ["/repos/openclaw/Peekaboo/actions/runs", "shared"],
    ["/repos/openclaw/Peekaboo/actions/workflows/ci.yml/runs", "edge"],
  ])("ignores contaminated fresh %s in %s", async (routePath, layer) => {
    const { request, oldKey, body } = await seedLegacy(routePath);
    if (layer === "shared") await deleteEdgeJSON("github-publication-v1", oldKey);
    const upstream = mockUpstream(body);
    const first = await relay(routePath, undefined, request);
    expect(first.status).toBe(200);
    expect(await first.json<Envelope>()).toMatchObject({ body, relay: { cache: "miss" } });
    const second = await relay(routePath, undefined, request);
    expect(await second.json<Envelope>()).toMatchObject({ body, relay: { cache: "hit" } });
    expect(
      upstream.mock.calls.some(([input]) => String(input).startsWith("https://api.github.com/")),
    ).toBe(true);
    expect(
      await env.DB.prepare("SELECT body_json FROM github_cache_entries WHERE cache_key = ?")
        .bind(oldKey)
        .first(),
    ).toMatchObject({ body_json: expect.stringContaining(wrongPatchHead) });
  });

  it("never serves a contaminated legacy stale entry during an outage", async () => {
    const { request, oldKey } = await seedLegacy(path);
    await expire(oldKey);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => outageResponse(new Request(input, init))),
    );
    const response = await relay(path, undefined, request);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain(wrongPatchHead);
  });

  it("coalesces a clean fill, revalidates only its new key, and serves only clean stale data", async () => {
    const { request, oldKey, body, route } = await seedLegacy(path);
    await expire(oldKey);
    let started!: () => void;
    const { promise: gate, release } = ownedWork.gate();
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const conditionals: (string | null)[] = [];
    let phase: "fill" | "revalidate" | "outage" = "fill";
    let apiCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const upstream = new Request(input, init);
        if (phase === "outage") return outageResponse(upstream);
        if (new URL(upstream.url).hostname === "github.com")
          return new Response("no page", { status: 404 });
        apiCalls++;
        conditionals.push(upstream.headers.get("if-none-match"));
        if (phase === "fill") {
          started();
          await gate;
        }
        if (upstream.headers.has("if-none-match"))
          return new Response(null, {
            status: 304,
            headers: { ...rateHeaders({ remaining: 59 }), etag: '"clean"' },
          });
        return jsonResponse(body, 200, { ...rateHeaders({ remaining: 59 }), etag: '"clean"' });
      }),
    );
    const leader = relay(path, undefined, request);
    const requests = [leader];
    try {
      await entered;
      const follower = relay(path, undefined, request);
      requests.push(follower);
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      const filled = await Promise.all(
        [leader, follower].map(async (response) => (await response).json<Envelope>()),
      );
      expect(filled.map((item) => item.body)).toEqual([body, body]);
      expect(filled[1]?.relay.coalesced).toBe(true);
      expect(apiCalls).toBe(1);
      expect(conditionals).toEqual([null]);
    } finally {
      release();
      await Promise.allSettled(requests);
    }

    const newKey = await githubCacheKey(request.pool, request, route);
    expect(newKey).not.toBe(oldKey);
    await expire(newKey);
    phase = "revalidate";
    expect(await (await relay(path, undefined, request)).json<Envelope>()).toMatchObject({
      body,
      relay: { cache: "hit" },
    });
    expect(conditionals).toEqual([null, '"clean"']);
    await expire(newKey);
    phase = "outage";
    expect(await (await relay(path, undefined, request)).json<Envelope>()).toMatchObject({
      body,
      relay: { cache: "stale" },
    });
  });
});

async function seedLegacy(routePath: string) {
  const list = routePath.endsWith("/runs");
  const request = validateRelayRequest({
    pool: "maintainers",
    method: "GET",
    path: routePath,
    headers,
    ...(list ? { query: { limit: "1" } } : {}),
  });
  const route = classifyRoute(request, defaultPolicy("openclaw"));
  const cacheRequest = runListSupersetView(request, route)?.cacheRequest ?? request;
  const oldKey = await legacyActionsKey(cacheRequest, route);
  const run = exactRun(runIDs[0]!);
  const badRun = { ...run, head_sha: wrongPatchHead };
  const body = list ? { total_count: 1, workflow_runs: [run] } : run;
  await recordPublicGitHubRepo(env, route);
  await writeGitHubCache(env, oldKey, cacheRequest, route, {
    status: 200,
    headers: { ...rateHeaders({ remaining: 59 }), etag: '"contaminated"' },
    body: list ? { total_count: 1, workflow_runs: [badRun] } : badRun,
    body_encoding: "json",
  });
  expect(JSON.stringify(body)).toContain(historicalHead);
  return { request, oldKey, body, route };
}

async function expire(key: string) {
  await env.DB.prepare(
    "UPDATE github_cache_entries SET expires_at = datetime('now', '-1 second'), stale_expires_at = datetime('now', '+1 hour') WHERE cache_key = ?",
  )
    .bind(key)
    .run();
  await deleteEdgeJSON("github-publication-v1", key);
}

function mockUpstream(body: unknown) {
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    expect(request.headers.get("if-none-match")).toBeNull();
    return new URL(request.url).hostname === "github.com"
      ? new Response("no page", { status: 404 })
      : jsonResponse(body);
  });
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

function outageResponse(request: Request): Response {
  if (new URL(request.url).pathname.toLowerCase() === "/repos/openclaw/peekaboo") {
    return jsonResponse({ private: false });
  }
  return jsonResponse(
    { message: "rate limited" },
    429,
    rateHeaders({ remaining: 0, retryAfter: 60 }),
  );
}
