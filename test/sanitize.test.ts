import { describe, expect, it } from "vitest";
import { sanitizeGitHubResponse } from "../src/github-sanitize";
import type { RouteInfo } from "../src/types";
import type { RouteKind } from "../src/route-manifest";

describe("GitHub response sanitizer", () => {
  it("preserves public app permissions while stripping repo-token fields", () => {
    const sanitized = sanitizeGitHubResponse(route("commit_check_runs"), {
      status: 200,
      headers: {},
      body: {
        check_runs: [
          {
            app: {
              slug: "github-actions",
              permissions: { checks: "write" },
            },
            repository: {
              full_name: "openclaw/openclaw",
              html_url: "https://github.com/openclaw/openclaw",
              private: false,
              permissions: { admin: true },
              role_name: "admin",
              temp_clone_token: "secret",
            },
          },
        ],
      },
    });

    expect(sanitized.body).toMatchObject({
      check_runs: [
        {
          app: {
            permissions: { checks: "write" },
          },
          repository: {
            full_name: "openclaw/openclaw",
            private: false,
          },
        },
      ],
    });
    const repository = (
      sanitized.body as {
        check_runs: { repository: Record<string, unknown> }[];
      }
    ).check_runs[0]!.repository;
    expect(repository).not.toHaveProperty("permissions");
    expect(repository).not.toHaveProperty("role_name");
    expect(repository).not.toHaveProperty("temp_clone_token");
  });

  it("keeps only public user profile fields", () => {
    const sanitized = sanitizeGitHubResponse(route("user_view"), {
      status: 200,
      headers: {},
      body: {
        login: "openperf",
        id: 123,
        html_url: "https://github.com/openperf",
        public_repos: 42,
        plan: { name: "pro" },
        private_gists: 7,
        total_private_repos: 3,
      },
    });

    expect(sanitized.body).toEqual({
      login: "openperf",
      id: 123,
      html_url: "https://github.com/openperf",
      public_repos: 42,
    });
  });
});

function route(kind: RouteKind): RouteInfo {
  return {
    kind,
    owner: "openclaw",
    repo: "openclaw",
    publicOnly: false,
    resource: "core",
    routeKey: "GET /repos/openclaw/openclaw/check-runs",
    cacheable: true,
    largePayload: false,
    fullResponseCap: false,
    logs: false,
  };
}
