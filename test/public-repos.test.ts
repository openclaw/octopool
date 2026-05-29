import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePublicGitHubRepo } from "../src/public-repos";
import type { RouteInfo } from "../src/types";

describe("public repo guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
          first: vi.fn(async () => ({ "1": 1 })),
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
      );
    vi.stubGlobal("fetch", fetchMock);
    const first = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ "1": 1 });
    const run = vi.fn(async () => ({}));
    const bind = vi.fn(() => ({ first, run }));
    const prepare = vi.fn(() => ({ bind }));

    await ensurePublicGitHubRepo(
      { ...env(), DB: { prepare } } as unknown as Env,
      route(),
      "2026-05-28 00:00:00",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    cacheable: true,
    logs: false,
    largePayload: false,
  };
}
