import { afterEach, describe, expect, it, vi } from "vitest";
import { withGitHubEgress, type GitHubEgressEnv } from "../src/github-egress";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import { verifyPRStateHint } from "../src/pr-state";

describe("PR state hint verification", () => {
  const policy = defaultPolicy("openclaw");

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a matching PR head discriminator", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          state: "open",
          merged_at: null,
          head: { sha: "0123456789abcdef0123456789abcdef01234567" },
        }),
      ),
    );
    const request = requestWithHint({ pr_head_sha: "0123456789abcdef0123456789abcdef01234567" });
    const database = databaseWithFreshProof(null);
    const route = await verifyPRStateHint(env(database), request, classifyRoute(request, policy));

    expect(route.state_hint).toBe("pr-head:0123456789abcdef0123456789abcdef01234567");
    expect(route.state_hint_source).toBe("live");
    expect(database.run).toHaveBeenCalledOnce();
  });

  it("reuses a fresh proof without touching GitHub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = requestWithHint({ pr_head_sha: "0123456789abcdef0123456789abcdef01234567" });
    const route = await verifyPRStateHint(
      env(databaseWithFreshProof({ "1": 1 })),
      request,
      classifyRoute(request, policy),
    );

    expect(route.state_hint).toBe("pr-head:0123456789abcdef0123456789abcdef01234567");
    expect(route.state_hint_source).toBe("cached");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops a stale or forged PR head discriminator", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          state: "open",
          merged_at: null,
          head: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        }),
      ),
    );
    const request = requestWithHint({ pr_head_sha: "0123456789abcdef0123456789abcdef01234567" });
    const route = await verifyPRStateHint(
      env(databaseWithFreshProof(null)),
      request,
      classifyRoute(request, policy),
    );

    expect(route.state_hint).toBeUndefined();
  });

  it("drops the discriminator when verification fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const request = requestWithHint({ pr_head_sha: "0123456789abcdef0123456789abcdef01234567" });
    const route = await verifyPRStateHint(
      env(databaseWithFreshProof(null)),
      request,
      classifyRoute(request, policy),
    );

    expect(route.state_hint).toBeUndefined();
  });

  it("drops the discriminator when proof storage fails", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const first = vi.fn(async () => {
      throw new Error("table missing");
    });
    const bind = vi.fn(() => ({ first, run: vi.fn() }));
    const database = { prepare: vi.fn(() => ({ bind })) };
    const request = requestWithHint({ pr_head_sha: "0123456789abcdef0123456789abcdef01234567" });
    const route = await verifyPRStateHint(
      env(database as unknown as TestDB),
      request,
      classifyRoute(request, policy),
    );

    expect(route.state_hint).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a matching merged discriminator", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          state: "closed",
          merged_at: "2026-05-29T00:00:00Z",
          head: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        }),
      ),
    );
    const request = requestWithHint({ pr_state: "merged" });
    const route = await verifyPRStateHint(
      env(databaseWithFreshProof(null)),
      request,
      classifyRoute(request, policy),
    );

    expect(route.state_hint).toBe("pr-state:merged");
    expect(route.state_hint_source).toBe("live");
  });
});

function requestWithHint(route_hint: Record<string, string>) {
  return validateRelayRequest({
    pool: "maintainers",
    method: "GET",
    path: "/repos/openclaw/openclaw/pulls/42/files",
    route_hint,
  });
}

type TestDB = {
  run: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
};

function env(database: TestDB): GitHubEgressEnv {
  return withGitHubEgress(
    {
      REQUEST_TIMEOUT_MS: "15000",
      DB: database,
    } as unknown as Env,
    [],
  );
}

function databaseWithFreshProof(row: { "1": number } | null): TestDB {
  const first = vi.fn(async () => row);
  const run = vi.fn(async () => ({}));
  const bind = vi.fn(() => ({ first, run }));
  const prepare = vi.fn(() => ({ bind }));
  return { prepare, run };
}
