import { afterEach, describe, expect, it, vi } from "vitest";
import {
  githubUserByLogin,
  githubUserFromToken,
  verifyGitHubOrgMember,
  verifyGitHubOrgMemberWithToken,
} from "../src/auth";
import { githubToken } from "../src/github-auth";
import { withGitHubEgress } from "../src/github-egress";
import type { Identity } from "../src/types";

describe("GitHub identity credentials", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves PAT identities from their configured secret", async () => {
    await expect(
      githubToken(
        withGitHubEgress({ TEST_PAT: "secret-token" } as unknown as Env, []),
        identity("pat"),
      ),
    ).resolves.toBe("secret-token");
  });

  it("rejects missing identity secrets", async () => {
    await expect(
      githubToken(withGitHubEgress({} as Env, []), identity("pat")),
    ).rejects.toMatchObject({
      status: 503,
      code: "identity_secret_missing",
    });
  });

  it("validates GitHub App configuration before token exchange", async () => {
    await expect(
      githubToken(withGitHubEgress({} as Env, []), identity("github_app", null)),
    ).rejects.toMatchObject({
      code: "github_app_installation_missing",
    });
    await expect(
      githubToken(
        withGitHubEgress({ TEST_PAT: "key" } as unknown as Env, []),
        identity("github_app", 42),
      ),
    ).rejects.toMatchObject({ code: "github_app_id_missing" });
    await expect(
      githubToken(
        withGitHubEgress(
          {
            TEST_PAT: "-----BEGIN RSA PRIVATE KEY-----\nbad\n-----END RSA PRIVATE KEY-----",
            OCTOPOOL_GITHUB_APP_ID: "7",
          } as unknown as Env,
          [],
        ),
        identity("github_app", 42),
      ),
    ).rejects.toMatchObject({ code: "github_app_key_format" });
  });

  it("applies the configured request timeout to GitHub auth reads", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/user") {
        return Response.json({ id: 42, login: "octo", name: "Octo" });
      }
      if (url.pathname === "/users/octo") {
        return Response.json({ id: 42, login: "octo" });
      }
      return orgMembershipResponse(["openclaw"]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = { ALLOWED_GITHUB_ORG: "openclaw", REQUEST_TIMEOUT_MS: "1234" } as unknown as Env;

    await expect(githubUserFromToken(env, "user-token")).resolves.toMatchObject({ login: "octo" });
    await expect(githubUserByLogin(env, "octo")).resolves.toMatchObject({ id: 42 });
    await expect(
      verifyGitHubOrgMember(
        { ...env, OCTOPOOL_GITHUB_ORG_TOKEN: "org-token" } as unknown as Env,
        "octo",
      ),
    ).resolves.toEqual(expect.any(String));

    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ signal: expect.any(AbortSignal) });
    }
  });

  it("verifies org membership without spending the REST core quota", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init).toMatchObject({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer org-token" }),
      });
      return orgMembershipResponse(["OpenClaw"]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyGitHubOrgMemberWithToken(env(), "org-token", "octo")).resolves.toEqual(
      expect.any(String),
    );
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/graphql", expect.any(Object));
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      variables: { login: string; after: string | null };
    };
    expect(request.variables).toEqual({ login: "octo", after: null });
  });

  it("paginates visible organizations before denying membership", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(orgMembershipResponse(["other"], true, "cursor-1"))
      .mockResolvedValueOnce(orgMembershipResponse(["openclaw"]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyGitHubOrgMemberWithToken(env(), "org-token", "octo")).resolves.toEqual(
      expect.any(String),
    );
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      variables: { after: string };
    };
    expect(secondRequest.variables.after).toBe("cursor-1");
  });

  it("denies users outside the allowed org", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => orgMembershipResponse(["other"])),
    );

    await expect(verifyGitHubOrgMemberWithToken(env(), "org-token", "octo")).rejects.toMatchObject({
      status: 403,
      code: "org_member_denied",
    });
  });

  it("reports invalid verifier credentials without leaking GitHub errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    await expect(
      verifyGitHubOrgMemberWithToken(env(), "invalid-token", "octo"),
    ).rejects.toMatchObject({ status: 502, code: "org_verification_failed" });
  });
});

function env(): Env {
  return { ALLOWED_GITHUB_ORG: "openclaw", REQUEST_TIMEOUT_MS: "1234" } as unknown as Env;
}

function orgMembershipResponse(
  organizations: string[],
  hasNextPage = false,
  endCursor: string | null = null,
): Response {
  return Response.json({
    data: {
      user: {
        organizations: {
          nodes: organizations.map((login) => ({ login })),
          pageInfo: { endCursor, hasNextPage },
        },
      },
    },
  });
}

function identity(kind: Identity["kind"], installationId: number | null = null): Identity {
  return {
    id: "primary",
    kind,
    login: "primary",
    secret_ref: "TEST_PAT",
    installation_id: installationId,
    weight: 100,
  };
}
