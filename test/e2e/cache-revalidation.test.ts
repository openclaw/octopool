import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { bearer, jsonResponse, rateHeaders, relay, seedPool } from "./harness";
import { ownedWork } from "./owned-work";

const RUN_PATH = "/repos/openclaw/octopool/actions/runs/123";

type RelayEnvelope = {
  status: number;
  body: { id?: number; status?: string; content?: string } | null;
  relay: { cache: string; coalesced?: boolean; route_kind: string };
};

describe("Worker end-to-end cache revalidation", () => {
  it.each(["network", "timeout"])(
    "recovers an asynchronous %s failure in explicit public API revalidation",
    async (failure) => {
      await seedPool();
      const path = "/users/octocat";
      let fullCalls = 0;
      let conditionalCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          expect(request.url).toBe(`https://api.github.com${path}`);
          expect(bearer(request)).toBeUndefined();
          if (request.headers.get("if-none-match") === '"user-v1"') {
            conditionalCalls++;
            await Promise.resolve();
            if (failure === "timeout") throw new DOMException("Synthetic timeout", "TimeoutError");
            throw new TypeError("Synthetic network failure");
          }
          fullCalls++;
          return jsonResponse(
            { id: 8, login: "octocat", name: fullCalls === 1 ? "Before" : "After" },
            200,
            apiHeaders('"user-v1"'),
          );
        }),
      );
      expect((await relay(path)).status).toBe(200);
      await expireCacheEntry("user_view");
      const refreshed = await relay(path);
      expect(refreshed.status).toBe(200);
      expect(await refreshed.json<RelayEnvelope>()).toMatchObject({
        body: { id: 8, name: "After" },
        relay: { backend: "github_public", cache: "miss", route_kind: "user_view" },
      });
      expect(await (await relay(path)).json<RelayEnvelope>()).toMatchObject({
        body: { id: 8, name: "After" },
        relay: { cache: "hit" },
      });
      expect({ fullCalls, conditionalCalls }).toEqual({ fullCalls: 2, conditionalCalls: 1 });
    },
  );

  it.each([undefined, 0, 20])(
    "refreshes an anonymous API entry on 304 with max-age=%s",
    async (maxAge) => {
      await seedPool();
      let apiCalls = 0;
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(bearer(request)).toBeUndefined();
        expect(request.url).toBe(`https://api.github.com${RUN_PATH}`);
        apiCalls++;
        if (request.headers.get("if-none-match") === '"run-v1"') {
          return new Response(null, { status: 304, headers: apiHeaders('"run-v1"') });
        }
        return jsonResponse(
          { id: 123, status: "in_progress", conclusion: null },
          200,
          apiHeaders('"run-v1"'),
        );
      });
      vi.stubGlobal("fetch", upstream);

      await relay(RUN_PATH);
      await expireCacheEntry("run_view");
      const response = await relay(RUN_PATH, undefined, {
        headers: maxAge === undefined ? {} : { "cache-control": `max-age=${maxAge}` },
      });

      expect(await response.json<RelayEnvelope>()).toMatchObject({
        body: { id: 123, status: "in_progress" },
        relay: { cache: "hit", route_kind: "run_view" },
      });
      expect(apiCalls).toBe(2);
      expect(
        await env.DB.prepare(
          `SELECT unixepoch(expires_at) - unixepoch(created_at) AS ttl
         FROM github_cache_entries WHERE route_kind = 'run_view'`,
        ).first(),
      ).toEqual({ ttl: 60 });
      expect(
        await env.DB.prepare(
          "SELECT cache_status, fallback_reason FROM audit_events ORDER BY rowid DESC LIMIT 1",
        ).first(),
      ).toEqual({ cache_status: "hit", fallback_reason: "cache_revalidated" });
      const shared = await relay(RUN_PATH);
      expect(await shared.json<RelayEnvelope>()).toMatchObject({
        body: { id: 123, status: "in_progress" },
        relay: { cache: "hit" },
      });
      expect(apiCalls).toBe(2);
    },
  );

  it.each([undefined, 0, 20])(
    "stores a conditional 200 replacement with max-age=%s",
    async (maxAge) => {
      await seedPool();
      let apiCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          expect(request.url).toBe(`https://api.github.com${RUN_PATH}`);
          apiCalls++;
          if (request.headers.get("if-none-match") === '"run-v1"') {
            return jsonResponse(
              { id: 123, status: "completed", conclusion: "success" },
              200,
              apiHeaders('"run-v2"'),
            );
          }
          return jsonResponse(
            { id: 123, status: "in_progress", conclusion: null },
            200,
            apiHeaders('"run-v1"'),
          );
        }),
      );

      await relay(RUN_PATH);
      await expireCacheEntry("run_view");
      const response = await relay(RUN_PATH, undefined, {
        headers: maxAge === undefined ? {} : { "cache-control": `max-age=${maxAge}` },
      });

      expect(await response.json<RelayEnvelope>()).toMatchObject({
        body: { id: 123, status: "completed" },
        relay: { cache: "miss", route_kind: "run_view" },
      });
      expect(apiCalls).toBe(2);
      expect(
        await env.DB.prepare(
          `SELECT json_extract(body_json, '$.status') AS status,
                unixepoch(expires_at) - unixepoch(created_at) AS ttl
         FROM github_cache_entries WHERE route_kind = 'run_view'`,
        ).first(),
      ).toEqual({ status: "completed", ttl: 60 });
      const shared = await relay(RUN_PATH);
      expect(await shared.json<RelayEnvelope>()).toMatchObject({
        body: { id: 123, status: "completed" },
        relay: { cache: "hit" },
      });
      expect(apiCalls).toBe(2);
    },
  );

  it.each([202, 204])(
    "publishes a %i replacement response without a second fill",
    async (replacementStatus) => {
      await seedPool();
      let apiCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          if (request.url !== `https://api.github.com${RUN_PATH}`) {
            return new Response("unavailable", { status: 503 });
          }
          apiCalls++;
          if (request.headers.get("if-none-match") === '"run-v1"') {
            return replacementStatus === 204
              ? new Response(null, { status: 204, headers: apiHeaders('"run-v2"') })
              : jsonResponse(
                  { id: 123, status: "queued" },
                  replacementStatus,
                  apiHeaders('"run-v2"'),
                );
          }
          return jsonResponse({ id: 123, status: "in_progress" }, 200, apiHeaders('"run-v1"'));
        }),
      );

      await relay(RUN_PATH);
      await expireCacheEntry("run_view");
      const replacement = await relay(RUN_PATH);

      expect(await replacement.json<RelayEnvelope>()).toMatchObject({
        status: replacementStatus,
        body: replacementStatus === 204 ? null : { id: 123, status: "queued" },
        relay: { cache: "miss", route_kind: "run_view" },
      });
      const cached = await relay(RUN_PATH);
      expect(await cached.json<RelayEnvelope>()).toMatchObject({
        status: replacementStatus,
        body: replacementStatus === 204 ? null : { id: 123, status: "queued" },
        relay: { cache: "hit", route_kind: "run_view" },
      });
      expect(apiCalls).toBe(2);
      expect(
        await env.DB.prepare(
          "SELECT status, body_json FROM github_cache_entries WHERE route_kind = 'run_view'",
        ).first(),
      ).toEqual({
        status: replacementStatus,
        body_json: replacementStatus === 204 ? "null" : '{"id":123,"status":"queued"}',
      });
    },
  );

  it("falls through to the normal anonymous fill when identity loading fails", async () => {
    await seedPool();
    let apiCalls = 0;
    let conditionalCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (request.url !== `https://api.github.com${RUN_PATH}`) {
          return new Response("unavailable", { status: 503 });
        }
        apiCalls++;
        if (request.headers.has("if-none-match") || request.headers.has("if-modified-since")) {
          conditionalCalls++;
        }
        return jsonResponse(
          { id: 123, status: apiCalls === 1 ? "in_progress" : "completed" },
          200,
          apiHeaders('"run-v1"'),
        );
      }),
    );

    await relay(RUN_PATH);
    await expireCacheEntry("run_view");
    await env.DB.prepare("ALTER TABLE identities RENAME TO unavailable_identities").run();
    const response = await relay(RUN_PATH);

    expect(await response.json<RelayEnvelope>()).toMatchObject({
      body: { id: 123, status: "completed" },
      relay: { cache: "miss", route_kind: "run_view" },
    });
    expect(apiCalls).toBe(2);
    expect(conditionalCalls).toBe(0);
  });

  it("uses the normal fill chain when an API entry has no validator", async () => {
    await seedPool();
    let apiCalls = 0;
    let conditionalCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        apiCalls++;
        if (request.headers.has("if-none-match") || request.headers.has("if-modified-since")) {
          conditionalCalls++;
        }
        return jsonResponse(
          { id: 123, status: apiCalls === 1 ? "in_progress" : "completed" },
          200,
          rateHeaders({ remaining: 59 }),
        );
      }),
    );

    await relay(RUN_PATH);
    await expireCacheEntry("run_view");
    const response = await relay(RUN_PATH);

    expect(await response.json<RelayEnvelope>()).toMatchObject({
      body: { status: "completed" },
      relay: { cache: "miss" },
    });
    expect(apiCalls).toBe(2);
    expect(conditionalCalls).toBe(0);
  });

  it("does not send web-origin validators to the GitHub API", async () => {
    await seedPool();
    let rawCalls = 0;
    let conditionalCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe(
          "https://raw.githubusercontent.com/openclaw/octopool/main/README.md",
        );
        if (request.headers.has("if-none-match") || request.headers.has("if-modified-since")) {
          conditionalCalls++;
        }
        rawCalls++;
        return new Response(rawCalls === 1 ? "old" : "new", {
          headers: { etag: '"raw-etag"', "content-type": "text/plain" },
        });
      }),
    );
    const options = { query: { ref: "main" } };

    await relay("/repos/openclaw/octopool/contents/README.md", undefined, options);
    await expireCacheEntry("contents");
    const response = await relay("/repos/openclaw/octopool/contents/README.md", undefined, options);

    expect(await response.json<RelayEnvelope>()).toMatchObject({
      body: { content: "bmV3" },
      relay: { cache: "miss", route_kind: "contents" },
    });
    expect(rawCalls).toBe(2);
    expect(conditionalCalls).toBe(0);
  });

  it("falls through to a fresh fill when a 304 source identity is revoked", async () => {
    await seedPool();
    let phase: "prime" | "revalidate" = "prime";
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const token = bearer(request);
      if (token === "test-org-token") {
        return jsonResponse({ private: false });
      }
      if (token === "test-primary-token") {
        return jsonResponse({ id: 123, status: "in_progress" }, 200, apiHeaders('"identity-run"'));
      }
      if (phase === "prime") {
        return jsonResponse({ message: "anonymous unavailable" }, 503);
      }
      if (request.headers.get("if-none-match") === '"identity-run"') {
        await env.DB.prepare(
          "UPDATE identities SET status = 'disabled' WHERE id = 'primary'",
        ).run();
        return new Response(null, { status: 304, headers: apiHeaders('"identity-run"') });
      }
      return jsonResponse({ id: 123, status: "completed" }, 200, apiHeaders('"anonymous-run"'));
    });
    vi.stubGlobal("fetch", upstream);

    await relay(RUN_PATH);
    await expireCacheEntry("run_view");
    phase = "revalidate";
    const response = await relay(RUN_PATH);

    expect(await response.json<RelayEnvelope>()).toMatchObject({
      body: { id: 123, status: "completed" },
      relay: { cache: "miss", route_kind: "run_view" },
    });
    expect(
      upstream.mock.calls.filter(([input, init]) => {
        const request = new Request(input, init);
        return request.headers.get("if-none-match") === '"identity-run"';
      }),
    ).toHaveLength(1);
  });

  it("fails closed before authenticated revalidation when a repository becomes private", async () => {
    await seedPool();
    const path = "/repos/openclaw/octopool/pulls/42";
    const options = { headers: { accept: "application/vnd.github.diff" } };
    let privateRepo = false;
    let authenticatedCallsAfterPrivate = 0;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const token = bearer(request);
      if (request.url === "https://github.com/openclaw/octopool/pull/42.diff") {
        return new Response("unavailable", { status: 503 });
      }
      if (token === "test-org-token") {
        return jsonResponse({ private: privateRepo });
      }
      if (token === "test-primary-token") {
        if (privateRepo) {
          authenticatedCallsAfterPrivate++;
        }
        return new Response("diff --git a/a b/a\n", {
          headers: {
            "content-type": "text/plain",
            etag: '"private-boundary"',
            ...rateHeaders({ remaining: 4_999 }),
          },
        });
      }
      throw new Error(`unexpected upstream ${request.url}`);
    });
    vi.stubGlobal("fetch", upstream);

    const primed = await relay(path, undefined, options);
    expect(primed.status).toBe(200);
    await expireCacheEntry("pr_view");
    privateRepo = true;

    const response = await relay(path, undefined, options);

    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "repo_not_public" } },
    });
    expect(authenticatedCallsAfterPrivate).toBe(0);
    expect(
      upstream.mock.calls.filter(([input, init]) => {
        const request = new Request(input, init);
        return (
          bearer(request) === "test-primary-token" &&
          request.headers.get("if-none-match") === '"private-boundary"'
        );
      }),
    ).toHaveLength(0);
  });

  it("publishes a 304 refresh to coalesced waiters", async () => {
    await seedPool();
    let revalidationStarted!: () => void;
    const { promise: gate, release: releaseRevalidation } = ownedWork.gate();
    const started = new Promise<void>((resolve) => {
      revalidationStarted = resolve;
    });
    let conditionalCalls = 0;
    let publicRepoChecks = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (request.url === "https://api.github.com/repos/openclaw/octopool") {
          publicRepoChecks++;
          return jsonResponse({ private: false });
        }
        expect(request.url).toBe(`https://api.github.com${RUN_PATH}`);
        if (request.headers.get("if-none-match") === '"run-v1"') {
          conditionalCalls++;
          revalidationStarted();
          await gate;
          return new Response(null, { status: 304, headers: apiHeaders('"run-v1"') });
        }
        return jsonResponse({ id: 123, status: "in_progress" }, 200, apiHeaders('"run-v1"'));
      }),
    );

    await relay(RUN_PATH);
    await expireCacheEntry("run_view");
    // Cover the original entry, but require the follower to refresh proof for the new timestamp.
    await env.DB.prepare(
      `UPDATE github_public_repo_proofs
       SET checked_at = datetime(
         (SELECT created_at FROM github_cache_entries WHERE route_kind = 'run_view' LIMIT 1),
         '-5 seconds'
       )
       WHERE owner = 'openclaw' AND repo = 'octopool'`,
    ).run();
    await deleteEdgeJSON("public-repo-publication-v1", "openclaw/octopool");
    const leader = relay(RUN_PATH);
    const requests = [leader];
    try {
      await started;
      const follower = relay(RUN_PATH);
      requests.push(follower);
      // Outlast the first 4s coalescing wait while the leader still owns its 8s fill lease.
      // A follower must wait/claim again instead of starting another conditional request.
      await new Promise((resolve) => setTimeout(resolve, 4_250));
      const conditionalCallsBeforePublish = conditionalCalls;
      releaseRevalidation();
      const envelopes = await Promise.all(
        [leader, follower].map(async (responsePromise) =>
          (await responsePromise).json<RelayEnvelope>(),
        ),
      );

      expect(envelopes).toEqual([
        expect.objectContaining({
          body: expect.objectContaining({ id: 123, status: "in_progress" }),
          relay: expect.objectContaining({ cache: "hit" }),
        }),
        expect.objectContaining({
          body: expect.objectContaining({ id: 123, status: "in_progress" }),
          relay: expect.objectContaining({ cache: "hit", coalesced: true }),
        }),
      ]);
      expect(conditionalCallsBeforePublish).toBe(1);
      expect(conditionalCalls).toBe(1);
      expect(publicRepoChecks).toBe(1);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE fallback_reason = 'cache_revalidated'",
        ).first(),
      ).toEqual({ count: 1 });
    } finally {
      releaseRevalidation();
      await Promise.allSettled(requests);
    }
  });
});

async function expireCacheEntry(routeKind: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT cache_key FROM github_cache_entries WHERE route_kind = ? LIMIT 1",
  )
    .bind(routeKind)
    .first<{ cache_key: string }>();
  expect(row).not.toBeNull();
  await env.DB.prepare(
    `UPDATE github_cache_entries
     SET created_at = datetime('now', '-180 seconds'),
         expires_at = datetime('now', '-1 second'),
         stale_expires_at = datetime('now', '+1 hour')
     WHERE cache_key = ?`,
  )
    .bind(row!.cache_key)
    .run();
  await deleteEdgeJSON("github-publication-v1", row!.cache_key);
}

function apiHeaders(etag: string): HeadersInit {
  return { ...rateHeaders({ remaining: 59 }), etag };
}
