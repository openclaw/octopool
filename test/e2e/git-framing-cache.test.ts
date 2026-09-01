import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubCacheKey } from "../../src/cache";
import { acquireOwnedCacheFill } from "../../src/cache-fill";
import { bodyPublicationResource } from "../../src/cache-publication";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../../src/policy";
import type { Identity } from "../../src/types";
import { gitCacheKeys } from "../fixtures/git-cache-keys";
import {
  completeGitAdvertisement,
  exactGitRefs,
  gitAdvertisementURL,
  gitMIME,
  gitNodeHTML,
  gitNodeURL,
  malformedGitAdvertisements,
} from "../fixtures/git-advertisement";
import { seedPublicRepoProof, writeOwnedGitHubCache } from "./cache-publication-fixture";
import { bearer, jsonResponse, rateHeaders, relay, seedPool } from "./harness";
import { requestWithEnv } from "./identity-routing-support";

const frozen = gitCacheKeys[0];
const blankFixtures = gitCacheKeys.filter(
  (fixture) =>
    fixture.name === "blank matching heads" || fixture.name === "whitespace matching heads",
);
const request = validateRelayRequest(frozen.request);
const route = classifyRoute(request, defaultPolicy("openclaw"));
const apiURL = `https://api.github.com${request.path}`;
const repoURL = "https://api.github.com/repos/openclaw/octopool";
const oldBody = exactGitRefs.slice(0, 1);
const identity: Identity = {
  id: "primary",
  kind: "pat",
  login: "primary",
  secret_ref: "TEST_PAT_PRIMARY",
  installation_id: null,
  weight: 200,
};

describe("Git framing and cache retirement at the Worker", () => {
  beforeEach(seedPool);

  it.each([
    malformedGitAdvertisements[0],
    malformedGitAdvertisements[8],
    malformedGitAdvertisements[15],
  ])("fills and hits complete anonymous JSON for %s", async (_name, wire) => {
    await seedPublicRepoProof(env, route);
    const upstream = stubAdvertisement(wire);
    const response = await relay(request.path);
    expect(response.status).toBe(200);
    expect
      .soft(await response.json())
      .toMatchObject({ body: exactGitRefs, relay: { cache: "miss", backend: "web" } });
    expect.soft(urls(upstream)).toEqual([gitAdvertisementURL, apiURL]);
    expect(
      await env.DB.prepare(
        "SELECT backend FROM audit_events WHERE route_kind = 'git_matching_refs'",
      ).all(),
    ).toMatchObject({ results: [{ backend: "github_api" }] });
    const calls = upstream.mock.calls.length;
    expect
      .soft(await (await relay(request.path)).json())
      .toMatchObject({ body: exactGitRefs, relay: { cache: "hit" } });
    expect(upstream.mock.calls).toHaveLength(calls);
    expect(upstream.mock.calls.every(([input, init]) => bearer(input, init) === undefined)).toBe(
      true,
    );
  });

  it("keeps complete Git advertisements cacheable", async () => {
    await seedPublicRepoProof(env, route);
    const upstream = stubAdvertisement(completeGitAdvertisement);
    const response = await relay(request.path);
    const wire = await response.json<{
      body: unknown;
      relay: { cache: string; backend: string };
    }>();
    expect(wire).toMatchObject({
      body: [{ ref: "refs/heads/main" }, { ref: "refs/heads/maint" }],
      relay: { cache: "miss", backend: "web" },
    });
    expect(urls(upstream)).toEqual([gitAdvertisementURL, gitNodeURL]);
    expect(await (await relay(request.path)).json()).toMatchObject({
      body: wire.body,
      relay: { cache: "hit" },
    });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("rejects the wrong advertisement MIME before node lookup and caches the exact API fill", async () => {
    await seedPublicRepoProof(env, route);
    const upstream = vi.fn<typeof fetch>(async (input, init) =>
      new Request(input, init).url === gitAdvertisementURL
        ? new Response(completeGitAdvertisement, { headers: { "content-type": "text/plain" } })
        : jsonResponse(exactGitRefs),
    );
    vi.stubGlobal("fetch", upstream);
    expect(await (await relay(request.path)).json()).toMatchObject({
      body: exactGitRefs,
      relay: { cache: "miss" },
    });
    expect(await (await relay(request.path)).json()).toMatchObject({
      body: exactGitRefs,
      relay: { cache: "hit" },
    });
    expect(urls(upstream)).toEqual([gitAdvertisementURL, apiURL]);
  });

  it("cancels an oversized advertisement before filling and hitting exact API JSON", async () => {
    await seedPublicRepoProof(env, route);
    const cancel = vi.fn();
    let pulls = 0;
    const upstream = vi.fn<typeof fetch>(async (input, init) =>
      new Request(input, init).url === gitAdvertisementURL
        ? new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  pulls++;
                  controller.enqueue(new Uint8Array(1025));
                },
                cancel,
              },
              { highWaterMark: 0 },
            ),
            { headers: { "content-type": gitMIME, "content-length": "1" } },
          )
        : jsonResponse(exactGitRefs),
    );
    vi.stubGlobal("fetch", upstream);
    expect(
      await (await requestWithEnv({ MAX_RESPONSE_BYTES: "1024" }, request.path, {})).json(),
    ).toMatchObject({ body: exactGitRefs, relay: { cache: "miss" } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBe(1);
    expect(await (await relay(request.path)).json()).toMatchObject({
      body: exactGitRefs,
      relay: { cache: "hit" },
    });
    expect(urls(upstream)).toEqual([gitAdvertisementURL, apiURL]);
  });

  it.each([
    ...["edge", "shared", "identity"].map((layer) => ({ layer, fixture: frozen })),
    ...blankFixtures.map((fixture, index) => ({
      layer: index === 0 ? "shared" : "identity",
      fixture,
    })),
  ])(
    "retires fresh old $layer partial refs and late old writers ($fixture.name)",
    async ({ layer, fixture }) => {
      const request = validateRelayRequest(fixture.request);
      await seedOld(layer !== "identity", fixture);
      if (layer !== "edge") await deleteEdgeJSON("github-publication-v1", fixture.shared);
      const upstream = stubAdvertisement(malformedGitAdvertisements[0][1], layer === "identity");
      const response = await relay(request.path, undefined, request);
      expect
        .soft(await response.json())
        .toMatchObject({ body: exactGitRefs, relay: { cache: "miss" } });
      expect
        .soft(urls(upstream))
        .toEqual(
          layer === "identity"
            ? [gitAdvertisementURL, apiURL, repoURL, apiURL]
            : [gitAdvertisementURL, apiURL],
        );
      expect
        .soft(
          upstream.mock.calls.map(([input, init]) =>
            new Request(input, init).headers.get("if-none-match"),
          ),
        )
        .not.toContain('"old-partial"');
      await seedOld(true, fixture);
      const calls = upstream.mock.calls.length;
      expect
        .soft(await (await relay(request.path, undefined, request)).json())
        .toMatchObject({ body: exactGitRefs, relay: { cache: "hit" } });
      expect(urls(upstream).slice(calls)).toEqual(
        layer === "identity" ? [gitAdvertisementURL, apiURL, repoURL] : [],
      );
      expect(
        await env.DB.prepare(
          "SELECT count(*) AS n FROM github_cache_entries WHERE cache_key IN (?, ?) AND body_json = ?",
        )
          .bind(fixture.shared, fixture.identity, JSON.stringify(oldBody))
          .first(),
      ).toEqual({ n: 2 });
    },
  );

  it.each([frozen, ...blankFixtures])(
    "retires old validators and retains new API 304 and stale behavior ($name)",
    async (fixture) => {
      const request = validateRelayRequest(fixture.request);
      const route = classifyRoute(request, defaultPolicy("openclaw"));
      await seedOld(true, fixture);
      await expire(fixture.shared);
      await expire(fixture.identity);
      let outage = false;
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const fetched = new Request(input, init);
        if (fetched.url === repoURL) return jsonResponse({ private: false });
        if (fetched.url === gitAdvertisementURL) return new Response(null, { status: 404 });
        if (outage)
          return jsonResponse(
            { message: "rate limited" },
            429,
            rateHeaders({ remaining: 0, retryAfter: 60 }),
          );
        const validator = fetched.headers.get("if-none-match");
        return validator === null
          ? jsonResponse(exactGitRefs, 200, {
              etag: '"complete"',
              ...rateHeaders({ remaining: 4998 }),
            })
          : new Response(null, {
              status: 304,
              headers: { etag: validator, ...rateHeaders({ remaining: 4998 }) },
            });
      });
      vi.stubGlobal("fetch", upstream);
      expect
        .soft(await (await relay(request.path, undefined, request)).json())
        .toMatchObject({ body: exactGitRefs, relay: { cache: "miss" } });
      expect
        .soft(
          upstream.mock.calls.map(([input, init]) =>
            new Request(input, init).headers.get("if-none-match"),
          ),
        )
        .not.toContain('"old-partial"');
      const key = await githubCacheKey(request.pool, request, route);
      await expire(key);
      expect
        .soft(await (await relay(request.path, undefined, request)).json())
        .toMatchObject({ body: exactGitRefs, relay: { cache: "hit" } });
      expect
        .soft(
          upstream.mock.calls.map(([input, init]) =>
            new Request(input, init).headers.get("if-none-match"),
          ),
        )
        .toContain('"complete"');
      await expire(key);
      outage = true;
      expect
        .soft(await (await relay(request.path, undefined, request)).json())
        .toMatchObject({ body: exactGitRefs, relay: { cache: "stale" } });
      expect(
        urls(upstream).every((url) => [repoURL, gitAdvertisementURL, apiURL].includes(url)),
      ).toBe(true);
    },
  );

  it.each([frozen, ...blankFixtures])(
    "never serves old shared or identity stale partial refs during an outage ($name)",
    async (fixture) => {
      const request = validateRelayRequest(fixture.request);
      await seedOld(true, fixture);
      await expire(fixture.shared);
      await expire(fixture.identity);
      const upstream = vi.fn<typeof fetch>(async (input, init) =>
        new Request(input, init).url === repoURL
          ? jsonResponse({ private: false })
          : jsonResponse(
              { message: "rate limited" },
              429,
              rateHeaders({ remaining: 0, retryAfter: 60 }),
            ),
      );
      vi.stubGlobal("fetch", upstream);
      const response = await relay(request.path, undefined, request);
      expect.soft(response.status).toBe(424);
      const wire = await response.json();
      expect.soft(wire).toMatchObject({ error: { code: "fallback_local" } });
      expect.soft(JSON.stringify(wire)).not.toContain("REF_exact_main");
      expect.soft(JSON.stringify(wire)).not.toContain('"cache":"stale"');
      expect(
        urls(upstream).every((url) => [repoURL, gitAdvertisementURL, apiURL].includes(url)),
      ).toBe(true);
    },
  );

  it.each([false, true])(
    "gives the new generation independent fill authority (identity=%s)",
    async (useIdentity) => {
      const oldKey = useIdentity ? frozen.identity : frozen.shared;
      const key = await githubCacheKey(
        request.pool,
        request,
        route,
        useIdentity ? identity : undefined,
      );
      expect(key).not.toBe(oldKey);
      const coordinator = poolCoordinatorStub(env, request.pool);
      const old = await acquireOwnedCacheFill(coordinator, bodyPublicationResource(oldKey));
      expect(old.kind).toBe("owner");
      if (old.kind !== "owner") throw new Error("Fixture old fill busy");
      try {
        const current = await acquireOwnedCacheFill(coordinator, bodyPublicationResource(key));
        expect(current.kind).toBe("owner");
        if (current.kind !== "owner") throw new Error("New generation joined old fill");
        try {
          expect(
            await env.DB.prepare(
              "SELECT count(*) AS n FROM cache_publication_owners WHERE resource_key IN (?, ?)",
            )
              .bind(bodyPublicationResource(oldKey), bodyPublicationResource(key))
              .first(),
          ).toEqual({ n: 2 });
        } finally {
          await current.owner.fail();
        }
      } finally {
        await old.owner.fail();
      }
    },
  );

  it("keeps frozen branch-list data warm", async () => {
    const fixture = gitCacheKeys[4];
    const sibling = validateRelayRequest(fixture.request);
    const siblingRoute = classifyRoute(sibling, defaultPolicy("openclaw"));
    await seedPublicRepoProof(env, siblingRoute);
    const body = [{ name: "main", protected: false }];
    expect(
      await writeOwnedGitHubCache(env, fixture.shared, sibling, siblingRoute, {
        status: 200,
        headers: {},
        body,
        body_encoding: "json",
      }),
    ).toBe("shared");
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    expect(await (await relay(sibling.path)).json()).toMatchObject({
      body,
      relay: { cache: "hit" },
    });
    expect(upstream).not.toHaveBeenCalled();
  });
});

function stubAdvertisement(wire: string, pooled = false) {
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    const fetched = new Request(input, init);
    if (fetched.url === repoURL) return jsonResponse({ private: false });
    if (fetched.url === gitAdvertisementURL)
      return new Response(new TextEncoder().encode(wire), { headers: { "content-type": gitMIME } });
    if (fetched.url === gitNodeURL) return new Response(gitNodeHTML);
    if (pooled && bearer(fetched) === undefined)
      return jsonResponse({ message: "unavailable" }, 503);
    return jsonResponse(exactGitRefs, 200, rateHeaders({ remaining: 4998 }));
  });
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

function urls(upstream: ReturnType<typeof stubAdvertisement>) {
  return upstream.mock.calls.map(([input, init]) => new Request(input, init).url);
}

async function seedOld(
  shared = true,
  fixture: { request: unknown; shared: string; identity: string } = frozen,
) {
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
            "content-type": "application/json",
            etag: '"old-partial"',
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
