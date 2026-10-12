import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { RELAY_PHASES } from "../../src/relay-timing";
import { withTimingBindings } from "../../src/relay-timing-bindings";
import { storePublicAPIRate } from "../../src/github-public-api";
import { queries } from "../../src/generated/sql";
import { observePublicationD1 } from "./publication-d1-observer";
import { bearer, CALLER_TOKEN, callWarmWorker, jsonResponse, relay, seedPool } from "./harness";

type Timing = {
  version: number;
  response_ready_ms: number;
  phases_ms: Record<string, number>;
  phase_calls: Record<string, number>;
  d1_ops: number;
  do_calls: number;
  github_fetches: number;
  config_cache_hits: Record<string, number>;
  cache_hits: Record<string, number>;
};

async function inspect(response: Response, cacheStatus: string): Promise<Timing> {
  expect(response.status).toBe(200);
  const header = response.headers.get("Server-Timing");
  expect(header).toMatch(/^response_ready;dur=\d+(?:, [a-z_]+;dur=\d+)+$/);
  const body = await response.json<{
    headers: Record<string, string>;
    relay: { request_id: string; cache: string };
  }>();
  expect(body.relay.cache).toBe(cacheStatus);
  expect(Object.keys(body.headers).map((key) => key.toLowerCase())).not.toContain("server-timing");
  expect(body).not.toHaveProperty("timings_json");
  const row = await env.DB.prepare("SELECT timings_json FROM audit_events WHERE request_id = ?")
    .bind(body.relay.request_id)
    .first<{ timings_json: string }>();
  expect(row).not.toBeNull();
  const timing = JSON.parse(row!.timings_json) as Timing;
  expect(timing.version).toBe(1);
  expect(Object.keys(timing.phases_ms)).toEqual([...RELAY_PHASES]);
  const fields = Object.fromEntries(
    header!.split(", ").map((item) => {
      const [name, duration] = item.split(";dur=");
      return [name, Number(duration)];
    }),
  );
  expect(fields).toEqual({ response_ready: timing.response_ready_ms, ...timing.phases_ms });
  for (const duration of Object.values(timing.phases_ms)) {
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(duration).toBeLessThanOrEqual(timing.response_ready_ms);
  }
  expect(timing.phase_calls.response_encode).toBe(1);
  return timing;
}

describe("relay timing on the outer HTTP response and audit", () => {
  it("retains advisory rate-write throttling across original and instrumented bindings", async () => {
    let writes = 0;
    const original = {
      ...env,
      DB: observePublicationD1(env.DB, {
        before: async (sql) => {
          if (sql === queries.upsertPublicApiRate) writes++;
        },
      }),
    };
    const headers = new Headers({
      "x-ratelimit-limit": "60",
      "x-ratelimit-remaining": "59",
      "x-ratelimit-reset": "4102444800",
    });
    await storePublicAPIRate(original, "core", headers);
    headers.set("x-ratelimit-remaining", "58");
    await storePublicAPIRate(withTimingBindings(original), "core", headers);
    await storePublicAPIRate(withTimingBindings(original), "core", headers);
    expect(writes).toBe(1);
  });

  it("measures an anonymous miss, cold-config hit, and warm-config hit without extra upstream requests", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>(async () =>
      jsonResponse({ id: 7, full_name: "openclaw/octopool", private: false }),
    );
    vi.stubGlobal("fetch", upstream);
    const miss = await inspect(await relay("/repos/openclaw/octopool"), "miss");
    expect(miss).toMatchObject({ github_fetches: 1, do_calls: 8 });
    for (const phase of [
      "auth",
      "rewrite_policy",
      "membership",
      "pool_policy",
      "cache_lookup",
      "identity_eligibility",
      "admission",
      "body_acquire",
      "validator_lookup",
      "anonymous_fetch",
      "proof_publish",
      "body_publish",
      "github_headers",
      "github_body",
    ])
      expect(miss.phase_calls[phase], phase).toBeGreaterThan(0);
    const hit = await inspect(await relay("/repos/openclaw/octopool"), "hit");
    expect(hit).toMatchObject({
      github_fetches: 0,
      do_calls: 1,
      d1_ops: 2,
      cache_hits: { edge: 1 },
    });
    expect(hit.phase_calls.pooled_fetch).toBe(0);
    expect(hit.phase_calls.public_guard).toBeGreaterThan(0);
    const warm = await inspect(
      await callWarmWorker("/v1/github/request", {
        method: "POST",
        headers: { authorization: `Bearer ${CALLER_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          pool: "maintainers",
          method: "GET",
          path: "/repos/openclaw/octopool",
        }),
      }),
      "hit",
    );
    expect(warm).toMatchObject({
      d1_ops: 0,
      do_calls: 1,
      github_fetches: 0,
      config_cache_hits: { caller: 1, membership: 1, policy: 1 },
    });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("measures pooled fallback attempts and preserves the identity-backed hit recheck", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const token = bearer(input, init);
      if (token === undefined) return jsonResponse({ message: "unavailable" }, 503);
      if (token === "test-org-token") return jsonResponse({ private: false });
      return jsonResponse({ id: 7, full_name: "openclaw/octopool", private: false });
    });
    vi.stubGlobal("fetch", upstream);
    const miss = await inspect(await relay("/repos/openclaw/octopool"), "miss");
    expect(miss.github_fetches).toBe(3);
    for (const phase of [
      "public_guard",
      "identity_select",
      "token",
      "pooled_fetch",
      "proof_publish",
      "body_publish",
    ])
      expect(miss.phase_calls[phase], phase).toBeGreaterThan(0);
    const hit = await inspect(await relay("/repos/openclaw/octopool"), "hit");
    expect(hit.github_fetches).toBe(0);
    expect(hit.phase_calls.identity_eligibility).toBeGreaterThan(0);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("includes timing on errors without introducing audit rows before authentication", async () => {
    await seedPool();
    const response = await relay("/repos/openclaw/octopool", "invalid");
    expect(response.status).toBe(401);
    expect(response.headers.get("Server-Timing")).toMatch(/^response_ready;dur=\d+, auth;dur=\d+/);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM audit_events").first()).toEqual({
      count: 0,
    });
  });
});
