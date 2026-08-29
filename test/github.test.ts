import { afterEach, describe, expect, it, vi } from "vitest";
import { callPublicGitHub } from "../src/github";
import { withGitHubEgress, type GitHubEgressEnv } from "../src/github-egress";
import { responseCapBytes } from "../src/github-limits";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";

describe("github api provider", () => {
  const policy = defaultPolicy("openclaw");

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches user profiles without pooled authorization", async () => {
    const fetchMock = vi.fn(async () => Response.json({ login: "dependabot[bot]" }));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/users/dependabot%5Bbot%5D",
    });

    await callPublicGitHub(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/users/dependabot%5Bbot%5D",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
  });

  it("uses the configured cap for every route", () => {
    const runList = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
    });
    const repo = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool",
    });

    expect(classifyRoute(runList, policy).kind).toBe("run_list");
    expect(classifyRoute(repo, policy).kind).toBe("repo_view");
    expect(responseCapBytes(env())).toBe(2_097_152);
  });

  it("accepts Actions run lists below the configured cap", async () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
    });
    const body = {
      total_count: 1,
      workflow_runs: [{ id: 1, display_title: "x".repeat(1_100_000) }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );

    await expect(
      callPublicGitHub(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({
      status: 200,
      body,
    });
  });
});

function env(overrides: Partial<Env> = {}): GitHubEgressEnv {
  return withGitHubEgress(
    {
      REQUEST_TIMEOUT_MS: "15000",
      MAX_RESPONSE_BYTES: "2097152",
      ...overrides,
    } as Env,
    [],
  );
}
