import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { CALLER_TOKEN, callWorker, POOL, seedPool } from "./harness";

describe("Worker error boundary", () => {
  it("logs one correlated safe diagnostic and keeps unexpected errors redacted", async () => {
    await seedPool();
    const querySecret = "query-secret-marker";
    const headerSecret = "header-secret-marker";
    const bodySecret = "body-secret-marker";
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error(`synthetic failure\n${querySecret}\n${headerSecret}\n${bodySecret}`);
    failure.name = `CustomError-${querySecret}`;
    failure.stack = `${failure.stack ?? ""}\n    at ${headerSecret} (/tmp/${bodySecret}.ts:999:7)\n${querySecret}`;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(failure));

    const response = await callWorker(`/v1/github/request?debug=${querySecret}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CALLER_TOKEN}`,
        "content-type": "application/json",
        "x-secret-like": headerSecret,
      },
      body: JSON.stringify({
        pool: POOL,
        method: "GET",
        path: "/repos/openclaw/octopool",
        ignored_secret_marker: bodySecret,
      }),
    });

    expect(logged).toHaveBeenCalledTimes(1);
    const event = logged.mock.calls[0]?.[0] as {
      event: string;
      code: string;
      request_id: string;
      method: string;
      pathname: string;
      error: { name: string; frames?: { extension: string; line: number; column: number }[] };
    };
    expect(event).toMatchObject({
      event: "octopool.worker.unexpected_exception",
      code: "internal_error",
      method: "POST",
      pathname: "/v1/github/request",
      error: { name: "Error" },
    });
    expect(event.request_id).toBeTruthy();
    expect(event.error.frames?.length).toBeGreaterThan(0);
    expect(event.error.frames?.[0]).toEqual({
      extension: "ts",
      line: expect.any(Number),
      column: expect.any(Number),
    });
    const serializedEvent = JSON.stringify(event);
    expect(serializedEvent).not.toContain(querySecret);
    expect(serializedEvent).not.toContain(headerSecret);
    expect(serializedEvent).not.toContain(bodySecret);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal error",
        request_id: event.request_id,
      },
    });
    expect(
      await env.DB.prepare("SELECT status, error_code FROM audit_events WHERE request_id = ?")
        .bind(event.request_id)
        .first(),
    ).toEqual({ status: 500, error_code: "internal_error" });
  });

  it("does not log expected HttpError responses", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await callWorker("/v1/github/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pool: POOL, method: "POST", path: "/user" }),
    });

    expect(logged).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "method_denied" } });
  });
});
