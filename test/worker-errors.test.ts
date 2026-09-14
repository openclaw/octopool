import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, logExpectedWorkerError } from "../src/http";

afterEach(() => vi.restoreAllMocks());

describe("expected Worker error diagnostics", () => {
  it.each([
    ["POST", "/v1/github/request", "relay"],
    ["GET", "/v1/pools/private-pool-marker/string-rewrites", "caller_policy"],
    ["GET", "/v1/admin/string-rewrites", "admin_policy"],
    ["PUT", "/v1/admin/string-rewrites", "admin_policy"],
  ])("logs only bounded metadata for %s %s", (method, path, routeFamily) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(Date, "now").mockReturnValue(150);
    logExpectedWorkerError(
      new Request(`https://octopool.dev${path}?private-query-marker`, {
        method,
        headers: { authorization: "Bearer private-token-marker" },
        ...(method === "GET" ? {} : { body: "private-body-marker" }),
      }),
      "request-id",
      new HttpError(403, "string_rewrite_denied", "private-message-marker", {
        policy: "private-policy-marker",
      }),
      100,
    );
    expect(logged).toHaveBeenCalledExactlyOnceWith({
      event: "octopool.worker.request_error",
      request_id: "request-id",
      route_family: routeFamily,
      method,
      status: 403,
      code: "string_rewrite_denied",
      duration_ms: 50,
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("private-");
  });

  it("replaces unknown codes without logging their content", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(Date, "now").mockReturnValue(90);
    logExpectedWorkerError(
      new Request("https://octopool.dev/v1/github/request", { method: "POST" }),
      "request-id",
      new HttpError(403, "private-code-marker".repeat(1_000), "private-message-marker"),
      100,
    );
    expect(logged).toHaveBeenCalledExactlyOnceWith({
      event: "octopool.worker.request_error",
      request_id: "request-id",
      route_family: "relay",
      method: "POST",
      status: 403,
      code: "http_error",
      duration_ms: 0,
    });
  });

  it.each([
    ["GET", "/v1/github/request"],
    ["POST", "/v1/pools/private-pool-marker/string-rewrites"],
    ["DELETE", "/v1/admin/string-rewrites"],
    ["GET", "/v1/pools/private-pool-marker/health"],
    ["GET", "/private-path-marker"],
  ])("does not log unrelated route/method %s %s", (method, path) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logExpectedWorkerError(
      new Request(`https://octopool.dev${path}`, { method }),
      "request-id",
      new HttpError(404, "not_found", "private-message-marker"),
      Date.now(),
    );
    expect(logged).not.toHaveBeenCalled();
  });

  it("leaves unexpected exceptions to their separate diagnostic", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logExpectedWorkerError(
      new Request("https://octopool.dev/v1/github/request", { method: "POST" }),
      "request-id",
      new Error("private-message-marker"),
      Date.now(),
    );
    expect(logged).not.toHaveBeenCalled();
  });

  it("records normalized backend overload without exposing its message", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logExpectedWorkerError(
      new Request("https://octopool.dev/v1/pools/private-pool-marker/string-rewrites"),
      "request-id",
      new Error("D1 DB is overloaded. private-message-marker"),
      Date.now(),
    );
    expect(logged).toHaveBeenCalledExactlyOnceWith({
      event: "octopool.worker.request_error",
      request_id: "request-id",
      route_family: "caller_policy",
      method: "GET",
      status: 503,
      code: "relay_overloaded",
      duration_ms: expect.any(Number),
    });
  });
});
