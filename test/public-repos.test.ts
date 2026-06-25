import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anonymousGitHubResponseProvesPublicRepo,
  ensurePublicGitHubRepo,
  recordPublicGitHubRepo,
} from "../src/public-repos";
import type { RouteInfo } from "../src/types";

describe("public repo guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses the org verifier token for public checks when configured", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        private: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await ensurePublicGitHubRepo(env(), route());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({
      authorization: "Bearer verifier-token",
      "user-agent": "octopool",
    });
  });

  it("keeps public proofs short by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ private: false })),
    );
    const run = vi.fn(async () => ({}));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));

    await ensurePublicGitHubRepo({ ...env(), DB: { prepare } } as unknown as Env, route());

    expect(bind).toHaveBeenCalledWith("openclaw", "octopool", "+30 seconds");
  });

  it("retries public checks without the verifier token when the verifier is depleted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "rate limited" }), {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
      )
      .mockResolvedValueOnce(Response.json({ private: false }));
    vi.stubGlobal("fetch", fetchMock);

    await ensurePublicGitHubRepo(env(), route());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, firstInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [, secondInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(firstInit.headers).toMatchObject({ authorization: "Bearer verifier-token" });
    expect(secondInit.headers).not.toHaveProperty("authorization");
  });

  it("retries public checks without the verifier token after 429 rate limits", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "rate limited" }), { status: 429 }),
      )
      .mockResolvedValueOnce(Response.json({ private: false }));
    vi.stubGlobal("fetch", fetchMock);

    await ensurePublicGitHubRepo(env(), route());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(secondInit.headers).not.toHaveProperty("authorization");
  });

  it("does not cache token-visible private repositories", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          private: true,
        }),
      ),
    );

    await expect(ensurePublicGitHubRepo(env(), route())).rejects.toMatchObject({
      status: 403,
      code: "repo_not_public",
    });
  });

  it("does not reuse fresh public proof for new upstream fetches", async () => {
    const fetchMock = vi.fn(async () => Response.json({ private: false }));
    vi.stubGlobal("fetch", fetchMock);
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => ({ "1": 1 })),
          run: vi.fn(async () => ({})),
        })),
      })),
    };

    await ensurePublicGitHubRepo({ ...env(), DB: database } as unknown as Env, route());

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses fresh covering proof for existing cache entries", async () => {
    const fetchMock = vi.fn(async () => Response.json({ private: false }));
    vi.stubGlobal("fetch", fetchMock);
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => proof()),
          run: vi.fn(async () => ({})),
        })),
      })),
    };

    await ensurePublicGitHubRepo(
      { ...env(), DB: database } as unknown as Env,
      route(),
      "2026-05-28 00:00:00",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps historical proof fallback when unauthenticated retry also fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "rate limited" }), {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "abuse limited" }), { status: 429 }),
      )
      .mockResolvedValueOnce(new Response("temporary web failure", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const first = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(proof());
    const run = vi.fn(async () => ({}));
    const bind = vi.fn(() => ({ first, run }));
    const prepare = vi.fn(() => ({ bind }));

    await ensurePublicGitHubRepo(
      { ...env(), DB: { prepare } } as unknown as Env,
      route(),
      "2026-05-28 00:00:00",
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("proves public visibility from the repository page when API quotas are exhausted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "rate limited" }), {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "rate limited" }), {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response('<meta name="octolytics-dimension-repository_public" content="true" />'),
      );
    vi.stubGlobal("fetch", fetchMock);

    await ensurePublicGitHubRepo(env(), route());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://github.com/openclaw/octopool",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
  });

  it("recognizes a streamed public marker split across response chunks", async () => {
    const page = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            '<meta name="octolytics-dimension-repository_public" content="tr',
          ),
        );
        controller.enqueue(new TextEncoder().encode('ue" />'));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
        .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
        .mockResolvedValueOnce(new Response(page)),
    );

    await expect(ensurePublicGitHubRepo(env(), route())).resolves.toBeUndefined();
  });

  it("does not accept repository HTML without an explicit public marker", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
        .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
        .mockResolvedValueOnce(new Response("<html>repository</html>")),
    );

    await expect(ensurePublicGitHubRepo(env(), route())).rejects.toMatchObject({
      status: 502,
      code: "repo_public_check_failed",
    });
  });

  it("coalesces a concurrent public proof refresh through the pool coordinator", async () => {
    const fetchMock = vi.fn(async () => Response.json({ private: false }));
    vi.stubGlobal("fetch", fetchMock);
    const coordinator = {
      claimCacheFill: vi.fn(async () => null),
      finishCacheFill: vi.fn(async () => undefined),
    };
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => proof()),
          run: vi.fn(async () => ({})),
        })),
      })),
    };

    await ensurePublicGitHubRepo(
      { ...env(), DB: database } as unknown as Env,
      route(),
      undefined,
      coordinator as never,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(coordinator.claimCacheFill).toHaveBeenCalledWith("public-repo:openclaw/octopool");
    expect(coordinator.finishCacheFill).not.toHaveBeenCalled();
  });

  it("releases a public proof fill after the leader refreshes it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ private: false })),
    );
    const coordinator = {
      claimCacheFill: vi.fn(async () => "proof-lease"),
      finishCacheFill: vi.fn(async () => undefined),
    };

    await ensurePublicGitHubRepo(env(), route(), undefined, coordinator as never);

    expect(coordinator.finishCacheFill).toHaveBeenCalledWith(
      "public-repo:openclaw/octopool",
      "proof-lease",
    );
  });

  it("reclaims an expired public proof lease before refreshing", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => Response.json({ private: false }));
    vi.stubGlobal("fetch", fetchMock);
    const coordinator = {
      claimCacheFill: vi
        .fn<() => Promise<string | null>>()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("replacement-lease"),
      finishCacheFill: vi.fn(async () => undefined),
    };
    const database = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => null),
          run: vi.fn(async () => ({})),
        })),
        query,
      })),
    };

    const pending = ensurePublicGitHubRepo(
      { ...env(), DB: database } as unknown as Env,
      route(),
      undefined,
      coordinator as never,
    );
    await vi.advanceTimersByTimeAsync(4_100);
    await pending;

    expect(coordinator.claimCacheFill).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(coordinator.finishCacheFill).toHaveBeenCalledWith(
      "public-repo:openclaw/octopool",
      "replacement-lease",
    );
  });

  it("serves a covering public proof from the edge without reading D1", async () => {
    const fetchMock = vi.fn(async () => Response.json({ private: false }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async () => Response.json(proof())),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => true),
      },
    });
    const prepare = vi.fn(() => {
      throw new Error("D1 should not be read");
    });

    await ensurePublicGitHubRepo(
      { ...env(), DB: { prepare } } as unknown as Env,
      route(),
      sqliteUTC(Date.now() - 1_000),
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fail a live anonymous response when proof persistence fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          run: vi.fn(async () => {
            throw new Error("D1 unavailable");
          }),
        })),
      })),
    };

    await expect(
      recordPublicGitHubRepo({ ...env(), DB: database } as unknown as Env, route()),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "public repo proof persistence failed",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("does not treat ambiguous search responses as public repo proof", () => {
    expect(anonymousGitHubResponseProvesPublicRepo(route())).toBe(true);
    for (const kind of ["search_issues", "search_code", "search_commits"] as const) {
      expect(anonymousGitHubResponseProvesPublicRepo({ ...route(), kind })).toBe(false);
    }
    const { owner: _owner, repo: _repo, ...ownerlessRoute } = route();
    expect(
      anonymousGitHubResponseProvesPublicRepo({
        ...ownerlessRoute,
        kind: "search_repositories",
      }),
    ).toBe(false);
  });
});

function env(): Env {
  const first = vi.fn(async () => null);
  const run = vi.fn(async () => ({}));
  const bind = vi.fn(() => ({ first, run }));
  const prepare = vi.fn(() => ({ bind }));
  return {
    REQUEST_TIMEOUT_MS: "15000",
    OCTOPOOL_GITHUB_ORG_TOKEN: "verifier-token",
    DB: { prepare },
  } as unknown as Env;
}

function route(): RouteInfo {
  return {
    kind: "repo_view",
    routeKey: "repo:openclaw/octopool",
    resource: "repo:openclaw/octopool",
    owner: "openclaw",
    repo: "octopool",
    publicOnly: false,
    cacheable: true,
    logs: false,
    largePayload: false,
    fullResponseCap: false,
  };
}

function proof(): { checked_at: string; expires_at: string } {
  return {
    checked_at: sqliteUTC(Date.now()),
    expires_at: sqliteUTC(Date.now() + 30_000),
  };
}

function sqliteUTC(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}
