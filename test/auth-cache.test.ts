import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateCaller } from "../src/auth";
import { clearConfigCache } from "../src/config-cache";
import { withGitHubEgress } from "../src/github-egress";
import { HttpError } from "../src/http";

describe("caller authentication cache", () => {
  beforeEach(clearConfigCache);
  afterEach(() => {
    clearConfigCache();
    vi.unstubAllGlobals();
  });

  it("shares a burst's D1 lookup and membership refresh after each request's guard", async () => {
    const fixture = authFixture();
    const gate = Promise.withResolvers<void>();
    const guards = Array.from({ length: 32 }, () =>
      vi.fn(async () => withGitHubEgress(fixture.env, []).githubEgress),
    );
    const upstream = vi.fn(async () => {
      await gate.promise;
      return membershipResponse();
    });
    vi.stubGlobal("fetch", upstream);
    const requests = guards.map((guard) =>
      authenticateCaller(request(), fixture.env, "pool", guard),
    );
    await vi.waitFor(() => {
      expect(upstream).toHaveBeenCalledTimes(1);
      for (const guard of guards) expect(guard).toHaveBeenCalledTimes(1);
    });
    gate.resolve();
    expect(await Promise.all(requests)).toEqual(Array(32).fill(fixture.caller));
    expect(fixture.first).toHaveBeenCalledTimes(1);
    expect(fixture.run).toHaveBeenCalledTimes(1);
    await authenticateCaller(request(), fixture.env, "pool", guards[0]);
    expect(guards[0]).toHaveBeenCalledTimes(2);
    expect(fixture.first).toHaveBeenCalledTimes(1);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("does not share a request-specific protection denial with an allowed caller", async () => {
    const fixture = authFixture();
    const upstream = vi.fn(async () => membershipResponse());
    vi.stubGlobal("fetch", upstream);
    const denial = new HttpError(403, "string_rewrite_denied", "Request blocked");
    const denied = vi.fn(async () => {
      throw denial;
    });
    const allowed = vi.fn(async () => withGitHubEgress(fixture.env, []).githubEgress);
    const outcomes = await Promise.allSettled([
      authenticateCaller(request(), fixture.env, "pool", denied),
      authenticateCaller(request(), fixture.env, "pool", allowed),
    ]);
    expect(outcomes).toEqual([
      { status: "rejected", reason: denial },
      { status: "fulfilled", value: fixture.caller },
    ]);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(allowed).toHaveBeenCalledTimes(1);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("rereads the caller after a rejected membership refresh", async () => {
    const fixture = authFixture();
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementation(async () => membershipResponse());
    vi.stubGlobal("fetch", upstream);
    await expect(authenticateCaller(request(), fixture.env, "pool")).rejects.toMatchObject({
      code: "org_verification_failed",
    });
    await expect(authenticateCaller(request(), fixture.env, "pool")).resolves.toEqual(
      fixture.caller,
    );
    expect(fixture.first).toHaveBeenCalledTimes(2);
    expect(fixture.run).toHaveBeenCalledTimes(1);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("never reads protected policy for invalid local authentication", async () => {
    const fixture = authFixture();
    fixture.first.mockResolvedValue(null);
    const guard = vi.fn(async () => withGitHubEgress(fixture.env, []).githubEgress);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(authenticateCaller(request(), fixture.env, "pool", guard)).rejects.toMatchObject(
        {
          code: "invalid_auth",
        },
      );
    }
    expect(fixture.first).toHaveBeenCalledTimes(2);
    expect(guard).not.toHaveBeenCalled();
  });
});

function authFixture() {
  const caller = {
    id: "caller",
    name: "Caller",
    github_login: "caller",
    github_user_id: 42,
    org_login: "openclaw",
    org_verified_at: null,
    caller_token_id: "client",
    client_name: "test-client",
  };
  const first = vi.fn<() => Promise<typeof caller | null>>(async () => ({ ...caller }));
  const run = vi.fn(async () => ({}));
  return {
    caller,
    first,
    run,
    env: {
      ALLOWED_GITHUB_ORG: "openclaw",
      ORG_VERIFY_TTL_SECONDS: "86400",
      OCTOPOOL_GITHUB_ORG_TOKEN: "test-org-token",
      REQUEST_TIMEOUT_MS: "10000",
      DB: { prepare: () => ({ bind: () => ({ first, run }) }) },
    } as unknown as Env,
  };
}

function request(): Request {
  return new Request("https://octopool.test/", {
    headers: { authorization: "Bearer test-caller-token" },
  });
}

function membershipResponse(): Response {
  return Response.json({
    data: {
      user: {
        databaseId: 42,
        organizations: {
          nodes: [{ login: "openclaw" }],
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      },
    },
  });
}
