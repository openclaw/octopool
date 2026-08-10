import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anonymousGitHubResponseProvesPublicRepo,
  ensurePublicGitHubRepo,
  recordPublicGitHubRepo,
} from "../src/public-repos";
import { queries } from "../src/generated/sql";
import type { RouteInfo } from "../src/types";
import { fakeCacheFillCoordinator } from "./cache-fill-test-support";

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
    const first = vi.fn(async () => null);
    const run = vi.fn(async () => ({}));
    const bind = vi.fn(() => ({ first, run }));
    const prepare = vi.fn(() => ({ bind }));

    await ensurePublicGitHubRepo({ ...env(), DB: { prepare } } as unknown as Env, route());

    expect(bind).toHaveBeenCalledWith("openclaw", "octopool", 1, "+30 seconds");
  });

  it.each([
    ["without a coordinator", undefined],
    ["with a coordinator", fakeCacheFillCoordinator([{ kind: "owner", token: "unused" }])],
  ])(
    "short-circuits a fresh cached negative %s without fetching GitHub",
    async (_label, coordinator) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const database = {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ first: vi.fn(async () => negativeProof()) })),
        })),
      };

      await expect(
        ensurePublicGitHubRepo(
          { ...env(), DB: database } as unknown as Env,
          route(),
          undefined,
          coordinator,
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: "repo_not_public",
        message: "Octopool only relays public repositories",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "token-free repository page 404",
      responses: [new Response("not found", { status: 404 })],
      targetRoute: { ...route(), tokenFreeOnly: true },
    },
    {
      label: "fallback repository page 404",
      responses: [
        new Response("rate limited", { status: 429 }),
        new Response("rate limited", { status: 429 }),
        new Response("not found", { status: 404 }),
      ],
      targetRoute: route(),
    },
    {
      label: "API 404",
      responses: [new Response("not found", { status: 404 })],
      targetRoute: route(),
    },
    {
      label: "API private response",
      responses: [Response.json({ private: true })],
      targetRoute: route(),
    },
  ])("writes a negative proof for a definitive $label", async ({ responses, targetRoute }) => {
    const fetchMock = vi.fn();
    for (const response of responses) {
      fetchMock.mockResolvedValueOnce(response);
    }
    vi.stubGlobal("fetch", fetchMock);
    const edgePut = vi.fn(async (_request: Request, _response: Response) => undefined);
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async () => undefined),
        put: edgePut,
        delete: vi.fn(async () => true),
      },
    });
    const run = vi.fn(async () => ({}));
    const bind = vi.fn(() => ({ first: vi.fn(async () => null), run }));
    const targetEnv = {
      ...env(),
      PUBLIC_REPO_NEGATIVE_TTL_SECONDS: undefined,
      DB: { prepare: vi.fn(() => ({ bind })) },
    } as unknown as Env;

    await expect(ensurePublicGitHubRepo(targetEnv, targetRoute)).rejects.toMatchObject({
      status: 403,
      code: "repo_not_public",
    });
    expect(bind).toHaveBeenCalledWith("openclaw", "octopool", 0, "+3600 seconds");
    expect(run).toHaveBeenCalledOnce();
    const edgeResponse = edgePut.mock.calls[0]?.[1] as Response | undefined;
    expect(await edgeResponse?.json()).toMatchObject({ is_public: false });
  });

  it.each([
    ["5xx", new Response("unavailable", { status: 503 }), 503],
    ["429", new Response("rate limited", { status: 429 }), 429],
    [
      "rate-limited 403",
      new Response("rate limited", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
      403,
    ],
  ])("does not cache an inconclusive %s result", async (_label, apiResponse, status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse)
      .mockResolvedValueOnce(apiResponse.clone())
      .mockResolvedValueOnce(new Response("<html>no visibility marker</html>"));
    vi.stubGlobal("fetch", fetchMock);
    const run = vi.fn(async () => ({}));
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ first: vi.fn(async () => null), run })),
      })),
    };

    await expect(
      ensurePublicGitHubRepo({ ...env(), DB: database } as unknown as Env, route()),
    ).rejects.toMatchObject({
      status: 502,
      code: "repo_public_check_failed",
      message: `GitHub public repository check failed with ${status}`,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("does not cache an inconclusive token-free page result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>no marker</html>")),
    );
    const run = vi.fn(async () => ({}));
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ first: vi.fn(async () => null), run })),
      })),
    };

    await expect(
      ensurePublicGitHubRepo({ ...env(), DB: database } as unknown as Env, {
        ...route(),
        tokenFreeOnly: true,
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: "repo_public_check_failed",
      message: "GitHub public repository page check failed",
    });
    expect(run).not.toHaveBeenCalled();
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

  it("rejects token-visible private repositories", async () => {
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

  it("does not let a negative edge proof satisfy the covering-proof path", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async () => Response.json(negativeProof())),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => true),
      },
    });
    const prepare = vi.fn(() => {
      throw new Error("D1 should not be read after a fresh negative edge proof");
    });

    await expect(
      ensurePublicGitHubRepo(
        { ...env(), DB: { prepare } } as unknown as Env,
        route(),
        sqliteUTC(Date.now() - 1_000),
      ),
    ).rejects.toMatchObject({ status: 403, code: "repo_not_public" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves a cache hit from a fresh positive edge proof without D1 or GitHub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const edgeMatch = vi.fn(async () => Response.json(positiveProof()));
    vi.stubGlobal("caches", {
      default: {
        match: edgeMatch,
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => true),
      },
    });
    const prepare = vi.fn();

    await ensurePublicGitHubRepo(
      { ...env(), DB: { prepare } } as unknown as Env,
      route(),
      sqliteUTC(Date.now() - 1_000),
    );

    expect(prepare).not.toHaveBeenCalledWith(queries.freshNegativePublicRepoProof);
    expect(prepare).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(edgeMatch).toHaveBeenCalledOnce();
  });

  it("filters negative rows out of both shared covering-proof queries", () => {
    expect(queries.coveringPublicRepoProof).toContain("AND is_public = 1");
    expect(queries.freshCoveringPublicRepoProof).toContain("AND is_public = 1");
  });

  it("re-checks GitHub after a negative proof expires", async () => {
    const fetchMock = vi.fn(async () => Response.json({ private: false }));
    vi.stubGlobal("fetch", fetchMock);
    const edgeDelete = vi.fn(async () => true);
    vi.stubGlobal("caches", {
      default: {
        match: vi
          .fn()
          .mockResolvedValueOnce(Response.json(negativeProof(Date.now() - 1_000)))
          .mockResolvedValue(undefined),
        put: vi.fn(async () => undefined),
        delete: edgeDelete,
      },
    });
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => null),
          run: vi.fn(async () => ({})),
        })),
      })),
    };

    await ensurePublicGitHubRepo({ ...env(), DB: database } as unknown as Env, route());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(edgeDelete).toHaveBeenCalledOnce();
  });

  it("uses an unexpired historical proof when unauthenticated retry also fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-27T16:00:00.000Z");
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
    const checkedAt = Date.now() - 30_000;
    const unexpiredProof = {
      checked_at: sqliteUTC(checkedAt),
      expires_at: sqliteUTC(Date.now() + 1_000),
    };
    const run = vi.fn(async () => ({}));
    let coveringReads = 0;
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => {
          if (query === queries.freshNegativePublicRepoProof) {
            return null;
          }
          return coveringReads++ === 0 ? null : unexpiredProof;
        }),
        run,
      })),
    }));

    await ensurePublicGitHubRepo(
      { ...env(), DB: { prepare } } as unknown as Env,
      route(),
      sqliteUTC(checkedAt),
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(prepare).toHaveBeenCalledWith(queries.freshNegativePublicRepoProof);
    expect(prepare).toHaveBeenCalledWith(queries.freshCoveringPublicRepoProof);
    expect(prepare).toHaveBeenCalledWith(queries.coveringPublicRepoProof);
  });

  it.each([
    ["at the expiry boundary", 0],
    ["after the expiry boundary", -1_000],
  ])("rejects a historical proof %s even if D1 returns it", async (_label, expiryOffsetMs) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-27T16:00:00.000Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary API failure", { status: 503 }))
      .mockResolvedValueOnce(new Response("temporary API failure", { status: 503 }))
      .mockResolvedValueOnce(new Response("temporary web failure", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const checkedAt = Date.now() - 30_000;
    const expiredProof = {
      checked_at: sqliteUTC(checkedAt),
      expires_at: sqliteUTC(Date.now() + expiryOffsetMs),
    };
    const run = vi.fn(async () => ({}));
    let coveringReads = 0;
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => {
          if (query === queries.freshNegativePublicRepoProof) {
            return null;
          }
          return coveringReads++ === 0 ? null : expiredProof;
        }),
        run,
      })),
    }));

    await expect(
      ensurePublicGitHubRepo(
        { ...env(), DB: { prepare } } as unknown as Env,
        route(),
        sqliteUTC(checkedAt),
      ),
    ).rejects.toMatchObject({
      status: 502,
      code: "repo_public_check_failed",
      message: "GitHub public repository check failed with 503",
    });
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
    const coordinator = fakeCacheFillCoordinator([{ kind: "completed", outcome: "shared" }]);
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
      coordinator,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(coordinator.acquireCacheFill).toHaveBeenCalledWith("public-repo:openclaw/octopool");
    expect(coordinator.completeCacheFill).not.toHaveBeenCalled();
  });

  it("releases a public proof fill after the leader refreshes it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ private: false })),
    );
    const coordinator = fakeCacheFillCoordinator([{ kind: "owner", token: "proof-lease" }]);

    await ensurePublicGitHubRepo(env(), route(), undefined, coordinator);

    expect(coordinator.completeCacheFill).toHaveBeenCalledWith(
      "public-repo:openclaw/octopool",
      "proof-lease",
      "shared",
    );
  });

  it("fails an acquired owner when its D1 recheck throws", async () => {
    const coordinator = fakeCacheFillCoordinator([{ kind: "owner", token: "proof-lease" }]);
    const first = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("D1 recheck failed"));
    const database = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })),
    };

    await expect(
      ensurePublicGitHubRepo(
        { ...env(), DB: database } as unknown as Env,
        route(),
        sqliteUTC(Date.now() - 1_000),
        coordinator,
      ),
    ).rejects.toThrow("D1 recheck failed");
    expect(coordinator.completeCacheFill).toHaveBeenCalledWith(
      "public-repo:openclaw/octopool",
      "proof-lease",
      "failed",
    );
  });

  it("completes a public proof fill as failed when D1 persistence fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ private: false })),
    );
    const coordinator = fakeCacheFillCoordinator([{ kind: "owner", token: "proof-lease" }]);
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => null),
          run: vi.fn(async () => {
            throw new Error("D1 unavailable");
          }),
        })),
      })),
    };

    await expect(
      ensurePublicGitHubRepo(
        { ...env(), DB: database } as unknown as Env,
        route(),
        undefined,
        coordinator,
      ),
    ).resolves.toBeUndefined();
    expect(coordinator.completeCacheFill).toHaveBeenCalledWith(
      "public-repo:openclaw/octopool",
      "proof-lease",
      "failed",
    );
    expect(consoleError).toHaveBeenCalledWith(
      "public repo shared proof write failed",
      expect.any(Error),
    );
  });

  it("publishes edge-only when D1 persistence fails after the local edge write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ private: false })),
    );
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => true),
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const coordinator = fakeCacheFillCoordinator([{ kind: "owner", token: "proof-lease" }]);
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => null),
          run: vi.fn(async () => {
            throw new Error("D1 unavailable");
          }),
        })),
      })),
    };

    await ensurePublicGitHubRepo(
      { ...env(), DB: database } as unknown as Env,
      route(),
      undefined,
      coordinator,
    );

    expect(coordinator.completeCacheFill).toHaveBeenCalledWith(
      "public-repo:openclaw/octopool",
      "proof-lease",
      "edge_only",
    );
  });

  it("retries coordinator ownership before refreshing an expired public proof", async () => {
    const fetchMock = vi.fn(async () => Response.json({ private: false }));
    vi.stubGlobal("fetch", fetchMock);
    const coordinator = fakeCacheFillCoordinator([
      { kind: "retry" },
      { kind: "owner", token: "replacement-lease" },
    ]);
    const database = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => null),
          run: vi.fn(async () => ({})),
        })),
        query,
      })),
    };

    await ensurePublicGitHubRepo(
      { ...env(), DB: database } as unknown as Env,
      route(),
      undefined,
      coordinator,
    );

    expect(coordinator.acquireCacheFill).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(coordinator.completeCacheFill).toHaveBeenCalledWith(
      "public-repo:openclaw/octopool",
      "replacement-lease",
      "shared",
    );
  });

  it("reacquires when final renewal loses ownership before proof publication", async () => {
    const fetchMock = vi.fn(async () => Response.json({ private: false }));
    vi.stubGlobal("fetch", fetchMock);
    const coordinator = fakeCacheFillCoordinator([
      { kind: "owner", token: "lost-owner" },
      { kind: "owner", token: "replacement-owner" },
    ]);
    coordinator.renewCacheFill.mockResolvedValueOnce(false).mockResolvedValue(true);

    await ensurePublicGitHubRepo(env(), route(), undefined, coordinator);

    expect(coordinator.acquireCacheFill).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(coordinator.completeCacheFill).toHaveBeenCalledTimes(1);
    expect(coordinator.completeCacheFill).toHaveBeenCalledWith(
      "public-repo:openclaw/octopool",
      "replacement-owner",
      "shared",
    );
  });

  it("serves an edge-only completion in the same colo", async () => {
    const edgeMatch = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(Response.json(proof()));
    vi.stubGlobal("caches", {
      default: {
        match: edgeMatch,
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => true),
      },
    });
    const first = vi.fn(async () => null);
    const coordinator = fakeCacheFillCoordinator([{ kind: "completed", outcome: "edge_only" }]);

    await ensurePublicGitHubRepo(
      {
        ...env(),
        DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })) },
      } as unknown as Env,
      route(),
      sqliteUTC(Date.now() - 1_000),
      coordinator,
    );

    expect(first).toHaveBeenCalledTimes(2);
    expect(edgeMatch).toHaveBeenCalledTimes(3);
    expect(coordinator.acquireCacheFill).toHaveBeenCalledOnce();
  });

  it("reacquires after an edge-only completion misses in the local colo", async () => {
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => true),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ private: false })),
    );
    const coordinator = fakeCacheFillCoordinator([
      { kind: "completed", outcome: "edge_only" },
      { kind: "owner", token: "takeover" },
    ]);
    const first = vi.fn(async () => null);
    const run = vi.fn(async () => ({}));

    await ensurePublicGitHubRepo(
      {
        ...env(),
        DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first, run })) })) },
      } as unknown as Env,
      route(),
      sqliteUTC(Date.now() - 1_000),
      coordinator,
    );

    expect(coordinator.acquireCacheFill).toHaveBeenCalledTimes(2);
    expect(coordinator.completeCacheFill).toHaveBeenCalledWith(
      "public-repo:openclaw/octopool",
      "takeover",
      "shared",
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it("treats a legacy edge entry without is_public as a positive covering proof", async () => {
    const fetchMock = vi.fn(async () => Response.json({ private: false }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async () => Response.json(proof())),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => true),
      },
    });
    const prepare = vi.fn();

    await ensurePublicGitHubRepo(
      { ...env(), DB: { prepare } } as unknown as Env,
      route(),
      sqliteUTC(Date.now() - 1_000),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
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
      "public repo shared proof write failed",
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
  };
}

function proof(): { checked_at: string; expires_at: string } {
  return {
    checked_at: sqliteUTC(Date.now()),
    expires_at: sqliteUTC(Date.now() + 30_000),
  };
}

function positiveProof(): { checked_at: string; expires_at: string; is_public: true } {
  return { ...proof(), is_public: true };
}

function negativeProof(expiresAt = Date.now() + 3_600_000): {
  checked_at: string;
  expires_at: string;
  is_public: false;
} {
  return {
    checked_at: sqliteUTC(Date.now()),
    expires_at: sqliteUTC(expiresAt),
    is_public: false,
  };
}

function sqliteUTC(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}
