import { afterEach, describe, expect, it, vi } from "vitest";
import { githubUserByLogin, githubUserFromToken, verifyGitHubOrgMember } from "../src/auth";
import { githubToken } from "../src/github-auth";
import type { Identity } from "../src/types";

describe("GitHub identity credentials", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves PAT identities from their configured secret", async () => {
    await expect(
      githubToken({ TEST_PAT: "secret-token" } as unknown as Env, identity("pat")),
    ).resolves.toBe("secret-token");
  });

  it("rejects missing identity secrets", async () => {
    await expect(githubToken({} as Env, identity("pat"))).rejects.toMatchObject({
      status: 503,
      code: "identity_secret_missing",
    });
  });

  it("validates GitHub App configuration before token exchange", async () => {
    await expect(githubToken({} as Env, identity("github_app", null))).rejects.toMatchObject({
      code: "github_app_installation_missing",
    });
    await expect(
      githubToken({ TEST_PAT: "key" } as unknown as Env, identity("github_app", 42)),
    ).rejects.toMatchObject({ code: "github_app_id_missing" });
    await expect(
      githubToken(
        {
          TEST_PAT: "-----BEGIN RSA PRIVATE KEY-----\nbad\n-----END RSA PRIVATE KEY-----",
          OCTOPOOL_GITHUB_APP_ID: "7",
        } as unknown as Env,
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
      return new Response(null, { status: 204 });
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
});

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
