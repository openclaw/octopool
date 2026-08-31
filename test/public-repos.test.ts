import { describe, expect, it, vi } from "vitest";
import { anonymousGitHubResponseProvesPublicRepo } from "../src/public-repos";
import type { RouteInfo } from "../src/types";

vi.mock("../src/pool-coordinator", () => ({ publicProofCoordinatorStub: vi.fn() }));

// Persistence and guard protocols run against native D1/DO in public-proof-publication.test.ts.
describe("anonymous proof eligibility", () => {
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
