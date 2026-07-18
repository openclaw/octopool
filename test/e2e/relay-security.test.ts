import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { bearer, jsonResponse, rateHeaders, relay, seedPool } from "./harness";

type RelayEnvelope = {
  status: number;
  body: unknown;
  body_encoding: string;
  identity?: { id: string; kind: string };
  relay: { cache: string; cacheable: boolean; route_kind: string };
};

const LOG_PATH = "/repos/openclaw/octopool/actions/jobs/42/logs";

describe("Worker end-to-end relay security boundaries", () => {
  it("denies private repositories before a pooled credential is used", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (bearer(request) === "test-org-token") {
        return jsonResponse({ private: true });
      }
      expect(bearer(request)).toBeUndefined();
      return jsonResponse({ message: "anonymous backend unavailable" }, 503);
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay("/repos/openclaw/private-project");
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "repo_not_public" } },
    });
    expect(
      upstream.mock.calls.filter(
        ([input, init]) => bearer(new Request(input, init)) === "test-primary-token",
      ),
    ).toHaveLength(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM github_cache_entries").first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT route_kind, status, error_code, fallback_reason FROM audit_events",
      ).first(),
    ).toEqual({
      route_kind: "repo_view",
      status: 424,
      error_code: "fallback_local",
      fallback_reason: "repo_not_public",
    });
  });

  it("rejects oversized pooled responses without caching them", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (bearer(request) === "test-org-token") {
        return jsonResponse({ private: false });
      }
      if (bearer(request) === "test-primary-token") {
        return jsonResponse({ payload: "x".repeat(1_048_576) });
      }
      expect(bearer(request)).toBeUndefined();
      return jsonResponse({ message: "anonymous backend unavailable" }, 503);
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay("/repos/openclaw/oversized");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: "github_response_too_large",
        message: "GitHub response exceeded relay cap",
        request_id: expect.any(String),
      },
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM github_cache_entries").first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT identity_id, status, error_code, cache_status, cacheable FROM audit_events",
      ).first(),
    ).toEqual({
      identity_id: "primary",
      status: 502,
      error_code: "github_response_too_large",
      cache_status: "miss",
      cacheable: 1,
    });
  });

  it("follows an allowed Actions log redirect without forwarding authorization", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (bearer(request) === "test-org-token") {
        return jsonResponse({ private: false });
      }
      if (bearer(request) === "test-primary-token") {
        expect(url.pathname).toBe(LOG_PATH);
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://results-receiver.actions.githubusercontent.com/logs/fixture",
            ...rateHeaders({ remaining: 4_998 }),
          },
        });
      }
      if (url.pathname === "/repos/openclaw/octopool/actions/jobs/42") {
        return jsonResponse({ id: 42, run_id: 99, status: "completed" });
      }
      if (url.pathname === "/repos/openclaw/octopool/actions/runs/99") {
        return jsonResponse({ id: 99, status: "completed" });
      }
      expect(url.hostname).toBe("results-receiver.actions.githubusercontent.com");
      expect(request.headers.get("authorization")).toBeNull();
      return new Response("build log\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(LOG_PATH);
    expect(response.status).toBe(200);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      status: 200,
      body: "build log\n",
      body_encoding: "text",
      identity: { id: "primary", kind: "pat" },
      relay: { cache: "miss", cacheable: true, route_kind: "job_logs" },
    });
    expect(upstream).toHaveBeenCalledTimes(4);
    expect(
      await env.DB.prepare("SELECT cache_status, cacheable, status FROM audit_events").first(),
    ).toEqual({ cache_status: "miss", cacheable: 1, status: 200 });
  });

  it("rejects an Actions log redirect to an untrusted host", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (bearer(request) === "test-org-token") {
        return jsonResponse({ private: false });
      }
      if (url.pathname === "/repos/openclaw/octopool/actions/jobs/42") {
        return jsonResponse({ id: 42, run_id: 99, status: "completed" });
      }
      if (url.pathname === "/repos/openclaw/octopool/actions/runs/99") {
        return jsonResponse({ id: 99, status: "completed" });
      }
      expect(bearer(request)).toBe("test-primary-token");
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/logs/fixture" },
      });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(LOG_PATH);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "github_log_redirect_denied" },
    });
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(
      await env.DB.prepare("SELECT identity_id, status, error_code FROM audit_events").first(),
    ).toEqual({
      identity_id: "primary",
      status: 502,
      error_code: "github_log_redirect_denied",
    });
  });
});
