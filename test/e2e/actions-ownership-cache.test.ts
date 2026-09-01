import { writeOwnedGitHubCache as writeGitHubCache } from "./cache-publication-fixture";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubCacheKey } from "../../src/cache";
import { acquireOwnedCacheFill } from "../../src/cache-fill";
import { bodyPublicationResource } from "../../src/cache-publication";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../../src/policy";
import { seedPublicRepoProof as recordPublicGitHubRepo } from "./cache-publication-fixture";
import { runListSupersetView } from "../../src/run-list-superset";
import { legacyActionsKey } from "../fixtures/actions-legacy-cache";
import { currentV2ActionsKeys } from "../fixtures/actions-current-v2-cache";
import type { Identity } from "../../src/types";
import { exactRun, historicalHead, runIDs, wrongPatchHead } from "../fixtures/actions-ownership";
import { bearer, jsonResponse, rateHeaders, relay, seedPool } from "./harness";
import { ownedWork } from "./owned-work";

const headers = { "x-octopool-public-shape": "actions-summary-v1" };
const path = `/repos/openclaw/Peekaboo/actions/runs/${runIDs[0]}`;
type Envelope = { body: unknown; relay: { cache: string; coalesced?: boolean } };

describe("Actions ownership cache migration", () => {
  beforeEach(seedPool);

  it.each(currentV2ActionsKeys)(
    "ignores current-v2 $name in edge, shared, and identity storage",
    async (fixture) => {
      const seeded = await seedCurrentV2(fixture);
      const upstream = mockUpstream(seeded.body);
      const first = await relay(fixture.path, undefined, seeded.request);
      expect(await first.json<Envelope>()).toMatchObject({
        body: seeded.body,
        relay: { cache: "miss" },
      });
      // A late old writer can republish both old keys, but cannot replace the new representation.
      await seedCurrentV2(fixture);
      const calls = upstream.mock.calls.length;
      expect(
        await (await relay(fixture.path, undefined, seeded.request)).json<Envelope>(),
      ).toMatchObject({ body: seeded.body, relay: { cache: "hit" } });
      expect(upstream).toHaveBeenCalledTimes(calls);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM github_cache_entries WHERE cache_key IN (?, ?) AND body_json LIKE '%contaminated-v2%'",
        )
          .bind(fixture.shared, fixture.identity)
          .first(),
      ).toEqual({ count: 2 });
    },
  );

  it("never revives current-v2 validators or stale bodies, including identity entries", async () => {
    const fixture = currentV2ActionsKeys[0];
    const { request, body } = await seedCurrentV2(fixture);
    await expire(fixture.shared);
    await expire(fixture.identity);
    const upstream = mockUpstream(body);
    expect(await (await relay(fixture.path, undefined, request)).json<Envelope>()).toMatchObject({
      body,
      relay: { cache: "miss" },
    });
    expect(upstream.mock.calls.length).toBeGreaterThan(0);
    expect(
      upstream.mock.calls.map(([input, init]) =>
        new Request(input, init).headers.get("if-none-match"),
      ),
    ).not.toContain('"contaminated-v2"');
  });

  it("refuses current-v2 outage stale data", async () => {
    const fixture = currentV2ActionsKeys[0];
    const { request } = await seedCurrentV2(fixture);
    await expire(fixture.shared);
    await expire(fixture.identity);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => outageResponse(new Request(input, init))),
    );
    const response = await relay(fixture.path, undefined, request);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain("contaminated-v2");
  });

  it.each(["fresh", "expired"])(
    "bypasses %s current-v2 identity data and validators on pooled reads",
    async (age) => {
      const fixture = currentV2ActionsKeys[0];
      const { request, body } = await seedCurrentV2(fixture);
      await expire(fixture.shared);
      if (age === "expired") await expire(fixture.identity);
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const fetchRequest = new Request(input, init);
        if (bearer(fetchRequest) === "test-primary-token")
          return jsonResponse(body, 200, rateHeaders({ remaining: 4998 }));
        if (new URL(fetchRequest.url).pathname.toLowerCase() === "/repos/openclaw/peekaboo")
          return jsonResponse({ private: false });
        return jsonResponse({ message: "unavailable" }, 503);
      });
      vi.stubGlobal("fetch", upstream);
      expect(await (await relay(fixture.path, undefined, request)).json<Envelope>()).toMatchObject({
        body,
        relay: { cache: "miss" },
      });
      expect(await (await relay(fixture.path, undefined, request)).json<Envelope>()).toMatchObject({
        body,
        relay: { cache: "hit" },
      });
      const requests = upstream.mock.calls.map(([input, init]) => new Request(input, init));
      expect(requests.filter((item) => bearer(item) === "test-primary-token")).toHaveLength(1);
      expect(requests.map((item) => item.headers.get("if-none-match"))).not.toContain(
        '"contaminated-v2"',
      );
    },
  );

  it("does not join an outstanding current-v2 fill", async () => {
    const fixture = currentV2ActionsKeys[0];
    const { request, body } = await seedCurrentV2(fixture);
    await expire(fixture.shared);
    await expire(fixture.identity);
    const oldFill = await acquireOwnedCacheFill(
      poolCoordinatorStub(env, request.pool),
      bodyPublicationResource(fixture.shared),
    );
    if (oldFill.kind !== "owner") throw new Error("Old fixture fill was not acquired");
    const unregister = ownedWork.registerRelease(() => oldFill.owner.fail());
    try {
      mockUpstream(body);
      expect(await (await relay(fixture.path, undefined, request)).json<Envelope>()).toMatchObject({
        body,
        relay: { cache: "miss" },
      });
    } finally {
      await oldFill.owner.fail();
      unregister();
    }
  });

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

  it.each(["legacy", "current-v2"])(
    "coalesces a clean fill past %s, revalidates only its new key, and serves only clean stale data",
    async (generation) => {
      const { request, oldKey, body, route } =
        generation === "legacy"
          ? await seedLegacy(path)
          : await seedCurrentV2(currentV2ActionsKeys[0]);
      await expire(oldKey);
      if (generation === "current-v2") await expire(currentV2ActionsKeys[0].identity);
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
        // Elapsed time is not proof that the native follower has registered.
        await vi.waitFor(
          async () => {
            const waiting = await runInDurableObject(
              poolCoordinatorStub(env, request.pool),
              (instance) =>
                (instance as unknown as { publicationWaiters: Map<string, unknown> })
                  .publicationWaiters.size,
            );
            expect(waiting).toBe(1);
          },
          { timeout: 5_000 },
        );
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
    },
  );
});

async function seedCurrentV2(fixture: (typeof currentV2ActionsKeys)[number]) {
  const request = validateRelayRequest({
    pool: "maintainers",
    method: "GET",
    path: fixture.path,
    query: fixture.query,
    headers,
  });
  const route = classifyRoute(request, defaultPolicy("openclaw"));
  const run = exactRun(runIDs[0]!);
  const list = fixture.path.endsWith("/runs");
  const body = list ? { total_count: 1, workflow_runs: [run] } : run;
  const contaminated = {
    ...run,
    display_title: "contaminated-v2",
    status: "completed",
    conclusion: "success",
    event: "push",
  };
  await recordPublicGitHubRepo(env, route);
  const identity: Identity = {
    id: "primary",
    kind: "pat",
    login: "primary",
    secret_ref: "TEST_PAT_PRIMARY",
    installation_id: null,
    weight: 200,
  };
  for (const owner of [undefined, identity]) {
    const key = owner === undefined ? fixture.shared : fixture.identity;
    expect(
      await writeGitHubCache(
        env,
        key,
        request,
        route,
        {
          status: 200,
          headers: { ...rateHeaders({ remaining: 59 }), etag: '"contaminated-v2"' },
          body: list ? { total_count: 1, workflow_runs: [contaminated] } : contaminated,
          body_encoding: "json",
        },
        owner,
      ),
    ).toBe("shared");
  }
  // Alternate cases exercise D1-only old storage as well as real Cache API entries.
  if (fixture.name !== "run view" && fixture.name !== "workflow canonical") {
    await deleteEdgeJSON("github-publication-v1", fixture.shared);
    await deleteEdgeJSON("github-publication-v1", fixture.identity);
  }
  return { request, body, route, oldKey: fixture.shared };
}

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
