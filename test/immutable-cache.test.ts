import { describe, expect, it } from "vitest";
import { cachedResponseImmutable, cacheTTLSeconds } from "../src/cache";
import { classifyRoute, defaultPolicy } from "../src/policy";
import type { RelayRequest } from "../src/types";

const repo = "/repos/openclaw/fixture";
const sha = "a".repeat(40);
const request = (path: string, query?: RelayRequest["query"]): RelayRequest => ({
  pool: "maintainers",
  method: "GET",
  path: `${repo}/${path}`,
  ...(query ? { query } : {}),
});
const policy = defaultPolicy("openclaw");
const cached = (body: unknown, ttl = 21_600) => ({
  status: 200,
  headers: {},
  body,
  created_at: "2026-10-14 00:00:00",
  expires_at: new Date(Date.parse("2026-10-14T00:00:00Z") + ttl * 1000).toISOString(),
});

describe("immutable cached response classification", () => {
  it("uses only the exact stored completed-attempt class and completed jobs", () => {
    const req = request("actions/runs/42/attempts/2/jobs");
    const route = classifyRoute(req, policy);
    const response = cached({ jobs: [{ status: "completed" }] });
    expect(cacheTTLSeconds({ ...route, run_attempt_completed: true }, response)).toBe(21_600);
    expect(cacheTTLSeconds(route, response)).toBe(60);
    expect(cachedResponseImmutable(req, route, response)).toBe(true);
    for (const ttl of [60, 1_800, 21_599, 21_601, 86_400]) {
      expect(cachedResponseImmutable(req, route, cached(response.body, ttl))).toBe(false);
    }
    for (const body of [{ jobs: [] }, { jobs: [{ status: "in_progress" }] }, {}]) {
      expect(cachedResponseImmutable(req, route, cached(body))).toBe(false);
    }
  });

  it.each([
    request(`git/tags/${sha}`),
    request(`git/commits/${sha.slice(0, 7)}`),
    request(`git/trees/${sha.slice(0, 7)}`),
    request(`git/blobs/${sha.slice(0, 7)}`),
    request("contents/file", { ref: [sha] }),
    request("contents/file", { ref: "main" }),
    request("contents/file"),
    request(`compare/${sha}...main`),
    request(`commits/${sha}/check-runs`),
    request(`commits/${sha}/check-suites`),
    request(`commits/${sha}/status`),
    request(`commits/${sha}/statuses`),
    request("actions/runs/42"),
    request("actions/runs"),
    request("pulls/1"),
    request("issues/1"),
    request("branches/main"),
    request("git/ref/heads/main"),
  ])("rejects mutable or unsupported $path", (req) => {
    expect(
      cachedResponseImmutable(req, classifyRoute(req, policy), cached({ status: "completed" })),
    ).toBe(false);
  });

  it.each(["if-none-match", "if-modified-since"])(
    "rejects caller %s even on full SHA content",
    (header) => {
      const req = { ...request(`commits/${sha}`), headers: { [header]: "validator" } };
      expect(cachedResponseImmutable(req, classifyRoute(req, policy), cached({}))).toBe(false);
    },
  );
});
