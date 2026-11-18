import { describe, expect, it } from "vitest";
import { HttpError, routeParam } from "../src/http";

const pattern = /^\/v1\/pools\/(?<pool>[^/]+)\/health$/;

describe("routeParam", () => {
  it.each([
    ["maintainers", "maintainers"],
    ["team%2Fci", "team/ci"],
    ["team%3Fci%23logs%25", "team?ci#logs%"],
    ["%252F", "%2F"],
    ["%E7%8C%AB", "猫"],
    ["team+ci", "team+ci"],
  ])("decodes %s exactly once", (encoded, decoded) => {
    expect(routeParam(`/v1/pools/${encoded}/health`, pattern, "pool")).toBe(decoded);
  });

  it.each(["%", "%GG", "%FF", "%E7%8C"])("rejects malformed encoding %s", (encoded) => {
    expect(() => routeParam(`/v1/pools/${encoded}/health`, pattern, "pool")).toThrow(
      new HttpError(400, "invalid_path", "Invalid path encoding"),
    );
  });

  it.each([
    ["/v1/pools//health", "pool"],
    ["/v1/pools/team/ci/health", "pool"],
    ["/v1/pools/maintainers/health", "missing"],
  ])("keeps unmatched routes as not found: %s (%s)", (pathname, field) => {
    expect(() => routeParam(pathname, pattern, field)).toThrow(
      new HttpError(404, "not_found", "Route not found"),
    );
  });
});
