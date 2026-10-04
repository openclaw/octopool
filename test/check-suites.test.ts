import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheTTLSeconds, githubCacheKey, staleCacheSeconds } from "../src/cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import type { RelayRequest } from "../src/types";

const base = "/repos/openclaw/octopool/check-suites/42";
const policy = defaultPolicy("openclaw");
const request = (path: string, query?: RelayRequest["query"]): RelayRequest => ({
  pool: "maintainers",
  method: "GET",
  path,
  ...(query ? { query } : {}),
});
afterEach(() => vi.restoreAllMocks());

describe.each([
  [base, "check_suite_view", "/check-suites/:id"],
  [`${base}/check-runs`, "check_suite_check_runs", "/check-suites/:id/check-runs"],
])("check suite route %s", (path, kind, tail) => {
  it("uses normal owner, repository, cache and audit boundaries", () => {
    expect(classifyRoute(request(path!), policy)).toMatchObject({
      kind,
      owner: "openclaw",
      repo: "octopool",
      resource: "core",
      cacheable: true,
      publicOnly: false,
      routeKey: `GET /repos/openclaw/octopool${tail}`,
    });
    const other = request(path!.replace("/openclaw/", "/other/"));
    expect(classifyRoute(other, policy).publicOnly).toBe(true);
    expect(() => classifyRoute(other, { ...policy, allow_public_repos: false })).toThrow(
      expect.objectContaining({ code: "owner_denied" }),
    );
  });

  it.each(["POST", "PATCH", "PUT", "DELETE", "HEAD"])("denies %s", (method) => {
    expect(() => validateRelayRequest({ ...request(path!), method })).toThrow(
      expect.objectContaining({ code: "method_denied" }),
    );
    expect(() => classifyRoute({ ...request(path!), method }, policy)).toThrow(
      expect.objectContaining({ code: "method_denied" }),
    );
  });

  it.each(["unknown", "app_id", "ref", "token"])("denies query %s", (key) => {
    expect(() => classifyRoute(request(path!, { [key]: "1" }), policy)).toThrow(
      expect.objectContaining({ code: "route_denied" }),
    );
  });
});

it("accepts only documented scalar list queries, and no suite detail queries", () => {
  const query = {
    check_name: "CI",
    status: "completed",
    filter: "latest",
    per_page: "100",
    page: "2",
  };
  expect(classifyRoute(request(`${base}/check-runs`, query), policy).kind).toBe(
    "check_suite_check_runs",
  );
  for (const key of Object.keys(query)) {
    expect(() => classifyRoute(request(base, { [key]: "1" }), policy)).toThrow();
  }
  expect(() =>
    classifyRoute(request(`${base}/check-runs`, { filter: ["all", "latest"] }), policy),
  ).toThrow();
  for (const path of [base.replace("42", "abc"), `${base}/rerequest`, `${base}/check-runs/1`]) {
    expect(() => classifyRoute(request(path), policy)).toThrow();
  }
});

it("shares omitted and latest filters without sharing all checks", async () => {
  const read = request(`${base}/check-runs`);
  const route = classifyRoute(read, policy);
  const key = (query: NonNullable<RelayRequest["query"]> = {}) =>
    githubCacheKey("maintainers", { ...read, query }, route);
  expect(await key()).toBe(await key({ filter: "latest", page: "1", per_page: "30" }));
  expect(await key()).not.toBe(await key({ filter: "all" }));
});

it("keeps suite detail mutable, scaling only completed suites with valid timestamps", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  vi.spyOn(Date, "now").mockReturnValue(now);
  const route = classifyRoute(request(base), policy);
  const ttl = (body: unknown) => cacheTTLSeconds(route, { status: 200, headers: {}, body });
  for (const [age, expected] of [
    [0, 60],
    [900, 90],
    [3600, 300],
    [86400, 300],
    [-100, 60],
  ]) {
    expect(
      ttl({ status: "completed", updated_at: new Date(now - age! * 1000).toISOString() }),
    ).toBe(expected);
  }
  for (const status of ["queued", "in_progress", "waiting", undefined]) {
    expect(ttl({ status, updated_at: "2020-01-01T00:00:00Z" })).toBe(60);
  }
  for (const updated_at of [undefined, null, "invalid", 123]) {
    expect(ttl({ status: "completed", updated_at })).toBe(60);
  }
  expect(ttl(null)).toBe(60);
  expect(staleCacheSeconds(route, 300)).toBe(300);
});
