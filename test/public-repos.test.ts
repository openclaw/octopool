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
