import { describe, expect, it, vi } from "vitest";
import { coalesceGitHubCacheMiss, finishGitHubCacheFill } from "../src/cache-coalesce";

describe("cache miss coalescing", () => {
  it("lets the first request lead the fill", async () => {
    const coordinator = {
      claimCacheFill: vi.fn(async () => "lease-token"),
      finishCacheFill: vi.fn(async () => undefined),
    };
    const result = await coalesceGitHubCacheMiss(env([]), coordinator as never, "cache-key");

    expect(result).toEqual({ leaseToken: "lease-token" });
    expect(coordinator.claimCacheFill).toHaveBeenCalledWith("cache-key");
  });

  it("waits for a concurrent leader to publish", async () => {
    const coordinator = {
      claimCacheFill: vi.fn(async () => null),
      finishCacheFill: vi.fn(async () => undefined),
    };
    const cached = {
      status: 200,
      response_headers_json: "{}",
      body_json: '{"status":"completed"}',
      body_encoding: "json",
      identity_id: null,
      identity_kind: null,
      created_at: "2026-06-14 00:00:00",
      expires_at: "2026-06-14 01:00:00",
    };
    const result = await coalesceGitHubCacheMiss(
      env([null, cached]),
      coordinator as never,
      "cache-key",
      {
        waitMs: 10,
        pollMs: 1,
        sleep: async () => undefined,
      },
    );

    expect(result).toMatchObject({
      cached: { status: 200, body: { status: "completed" } },
    });
  });

  it("only releases fills owned by the current request", async () => {
    const coordinator = {
      claimCacheFill: vi.fn(async () => "leader-token"),
      finishCacheFill: vi.fn(async () => undefined),
    };

    await finishGitHubCacheFill(coordinator as never, "leader", "leader-token");
    await finishGitHubCacheFill(coordinator as never, "follower", undefined);

    expect(coordinator.finishCacheFill).toHaveBeenCalledTimes(1);
    expect(coordinator.finishCacheFill).toHaveBeenCalledWith("leader", "leader-token");
  });

  it("does not replace relay failures when cleanup fails", async () => {
    const coordinator = {
      claimCacheFill: vi.fn(async () => "lease-token"),
      finishCacheFill: vi.fn(async () => {
        throw new Error("coordinator unavailable");
      }),
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      finishGitHubCacheFill(coordinator as never, "cache-key", "lease-token"),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "github cache fill cleanup failed",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});

function env(rows: unknown[]): Env {
  let index = 0;
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => rows[index++] ?? null,
        }),
      }),
    },
  } as unknown as Env;
}
