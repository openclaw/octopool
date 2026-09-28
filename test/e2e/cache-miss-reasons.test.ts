import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { GITHUB_EDGE_CACHE_NAMESPACE } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { jsonResponse, relay, seedPool } from "./harness";

const repo = "/repos/openclaw/miss-reasons-fixture";
const path = `${repo}/actions/runs/42`;

async function setup() {
  await seedPool();
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === repo) return jsonResponse({ private: false });
    return jsonResponse({ id: 42, status: "in_progress" });
  });
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

async function lastAudit() {
  return env.DB.prepare(
    "SELECT cache_status, cache_miss_reason FROM audit_events ORDER BY rowid DESC LIMIT 1",
  ).first();
}

describe("relay cache miss reason audit", () => {
  it("records absent once, then NULL for edge and D1 hits and live reads", async () => {
    await setup();
    await relay(path);
    expect(await lastAudit()).toEqual({ cache_status: "miss", cache_miss_reason: "absent" });
    await relay(path);
    expect(await lastAudit()).toEqual({ cache_status: "hit", cache_miss_reason: null });
    const row = await env.DB.prepare("SELECT cache_key FROM github_cache_entries").first<{
      cache_key: string;
    }>();
    await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, row!.cache_key);
    await relay(path);
    expect(await lastAudit()).toEqual({ cache_status: "hit", cache_miss_reason: null });
    await relay(path, undefined, { headers: { "cache-control": "max-age=0" } });
    expect(await lastAudit()).toEqual({ cache_status: "miss", cache_miss_reason: null });
  });

  it.each([
    [
      "expired",
      "expires_at = datetime('now', '-10 minutes'), stale_expires_at = datetime('now', '-5 minutes')",
      undefined,
    ],
    ["expired", "expires_at = datetime('now', '-1 second')", undefined],
    ["caller_max_age", "created_at = datetime('now', '-30 seconds')", "max-age=10"],
    ["unusable", "publication_epoch = 'retired'", undefined],
    ["unusable", "body_json = '{'", undefined],
    ["unusable", "identity_id = 'primary', identity_kind = 'pat'", undefined],
  ] as const)("records %s for an existing rejected row (%s)", async (reason, mutation, age) => {
    await setup();
    await relay(path);
    const row = await env.DB.prepare("SELECT cache_key FROM github_cache_entries").first<{
      cache_key: string;
    }>();
    await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, row!.cache_key);
    await env.DB.prepare(`UPDATE github_cache_entries SET ${mutation}`).run();
    const response = await relay(
      path,
      undefined,
      age === undefined ? {} : { headers: { "cache-control": age } },
    );
    expect(response.status).toBe(200);
    expect(await lastAudit()).toEqual({ cache_status: "miss", cache_miss_reason: reason });
  });

  it("records uncacheable for conditional reads on a cache route, but NULL for live reads", async () => {
    await setup();
    for (const live of [false, true]) {
      await relay(path, undefined, {
        headers: { "if-none-match": '"caller"', ...(live ? { "cache-control": "max-age=0" } : {}) },
      });
      expect(await lastAudit()).toEqual({
        cache_status: "bypass",
        cache_miss_reason: live ? null : "uncacheable",
      });
    }
  });

  it("records uncacheable for a response ineligible for caching", async () => {
    await seedPool();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const pathname = new URL(new Request(input, init).url).pathname;
        return pathname === repo ? jsonResponse({ private: false }) : jsonResponse({}, 202);
      }),
    );
    await relay(`${repo}/stats/contributors`);
    expect(await lastAudit()).toEqual({ cache_status: "miss", cache_miss_reason: "uncacheable" });
  });

  it("keeps non-cache routes and denied requests NULL", async () => {
    await setup();
    for (const route of ["/rate_limit", `${repo}/unsupported`]) {
      await relay(route);
      expect(await lastAudit()).toMatchObject({ cache_miss_reason: null });
    }
  });

  it("clears the expired observation when bounded stale fallback serves the request", async () => {
    const upstream = await setup();
    await relay(path);
    const row = await env.DB.prepare("SELECT cache_key FROM github_cache_entries").first<{
      cache_key: string;
    }>();
    await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, row!.cache_key);
    await env.DB.prepare(
      "UPDATE github_cache_entries SET expires_at = datetime('now', '-1 second')",
    ).run();
    await env.DB.prepare("UPDATE identities SET status = 'disabled'").run();
    upstream.mockImplementation(async (input, init) =>
      new URL(new Request(input, init).url).pathname === repo
        ? jsonResponse({ private: false })
        : jsonResponse({}, 503),
    );
    await relay(path);
    expect(await lastAudit()).toEqual({ cache_status: "stale", cache_miss_reason: null });
  });
});
