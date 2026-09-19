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
        42,
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

    await expect(verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", 42)).resolves.toEqual(
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

    await expect(verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", 42)).resolves.toEqual(
      expect.any(String),
    );
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      variables: { after: string };
    };
    expect(secondRequest.variables.after).toBe("cursor-1");
  });

  it.each([
    [200, "RATE_LIMIT"],
    [200, "RATE_LIMITED"],
    [403, "RATE_LIMIT"],
  ] as const)(
    "verifies membership through REST after GraphQL exhausts quota (%s, %s)",
    async (status, errorType) => {
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        if (String(input) === "https://api.github.com/graphql") {
          return graphqlRateLimitResponse(status, errorType);
        }
        expect(String(input)).toBe("https://api.github.com/orgs/openclaw/memberships/octo");
        expect(init).toMatchObject({
          redirect: "manual",
          headers: expect.objectContaining({ authorization: "Bearer org-token" }),
          signal: expect.any(AbortSignal),
        });
        return Response.json({
          state: "active",
          user: { id: 42 },
          organization: { login: "OpenClaw" },
        });
      });
      vi.stubGlobal("fetch", upstream);
      await expect(verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", 42)).resolves.toEqual(
        expect.any(String),
      );
      expect(upstream).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["missing quota headers", {}],
    ["missing resource", { "x-ratelimit-remaining": "0" }],
    ["missing remaining quota", { "x-ratelimit-resource": "graphql" }],
    [
      "nonzero remaining quota",
      { "x-ratelimit-resource": "graphql", "x-ratelimit-remaining": "5000" },
    ],
    ["different quota resource", { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "0" }],
    [
      "nonzero remaining quota for RATE_LIMITED",
      { "x-ratelimit-resource": "graphql", "x-ratelimit-remaining": "4" },
      "RATE_LIMITED",
    ],
  ])(
    "does not retry HTTP 200 rate-limit errors with %s",
    async (_label, headers, errorType = "RATE_LIMIT") => {
      const upstream = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json(
            { errors: [{ type: errorType, message: "Please wait before trying again." }] },
            { headers },
          ),
        )
        .mockResolvedValueOnce(
          Response.json({ state: "active", user: { id: 42 }, organization: { login: "openclaw" } }),
        );
      vi.stubGlobal("fetch", upstream);
      await expect(
        verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", 42),
      ).rejects.toMatchObject({ status: 502, code: "org_verification_failed" });
      expect(upstream).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      "replacement account",
      { state: "active", user: { id: 99 }, organization: { login: "openclaw" } },
      403,
      "github_identity_mismatch",
    ],
    [
      "pending invitation",
      { state: "pending", user: { id: 42 }, organization: { login: "openclaw" } },
      403,
      "org_member_denied",
    ],
    [
      "other organization",
      { state: "active", user: { id: 42 }, organization: { login: "other" } },
      502,
      "org_verification_failed",
    ],
    [
      "missing user ID",
      { state: "active", user: {}, organization: { login: "openclaw" } },
      502,
      "org_verification_failed",
    ],
    [
      "malformed user ID",
      { state: "active", user: { id: "42" }, organization: { login: "openclaw" } },
      502,
      "org_verification_failed",
    ],
    [
      "unknown membership state",
      { state: "unknown", user: { id: 42 }, organization: { login: "openclaw" } },
      502,
      "org_verification_failed",
    ],
  ])(
    "rejects REST %s without accepting weaker membership evidence",
    async (_label, body, status, code) => {
      const upstream = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(graphqlRateLimitResponse())
        .mockResolvedValueOnce(Response.json(body));
      vi.stubGlobal("fetch", upstream);
      await expect(
        verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", 42),
      ).rejects.toMatchObject({ status, code });
      expect(upstream).toHaveBeenCalledTimes(2);
    },
  );

  it.each([401, 403, 404, 429, 500, 302])(
    "preserves REST error %s without authorizing membership",
    async (upstreamStatus) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(graphqlRateLimitResponse())
          .mockResolvedValueOnce(
            new Response(null, {
              status: upstreamStatus,
              headers: { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "0" },
            }),
          ),
      );
      await expect(
        verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", 42),
      ).rejects.toMatchObject({
        status: 502,
        code: "org_verification_failed",
        details: { github_rate_limit_resource: "core", github_rate_limit_remaining: "0" },
      });
    },
  );

  it.each([
    ["permission", () => Response.json({ errors: [{ type: "FORBIDDEN" }] })],
    [
      "permission with exhausted headers",
      () =>
        Response.json(
          { message: "Resource not accessible" },
          {
            status: 403,
            headers: { "x-ratelimit-resource": "graphql", "x-ratelimit-remaining": "0" },
          },
        ),
    ],
    [
      "mixed errors",
      () =>
        Response.json(
          { errors: [{ type: "RATE_LIMIT" }, { type: "FORBIDDEN" }] },
          { headers: { "x-ratelimit-resource": "graphql", "x-ratelimit-remaining": "0" } },
        ),
    ],
    ["nonmembership", () => orgMembershipResponse(["other"])],
    [
      "secondary limit",
      () => new Response(null, { status: 429, headers: { "retry-after": "60" } }),
    ],
    [
      "secondary limit with exhausted headers",
      () =>
        Response.json(
          { message: "You have exceeded a secondary rate limit." },
          {
            status: 403,
            headers: { "x-ratelimit-resource": "graphql", "x-ratelimit-remaining": "0" },
          },
        ),
    ],
    [
      "GraphQL secondary limit",
      () =>
        Response.json(
          {
            errors: [{ type: "RATE_LIMIT", message: "You have exceeded a secondary rate limit." }],
          },
          { headers: { "x-ratelimit-resource": "graphql", "x-ratelimit-remaining": "0" } },
        ),
    ],
    [
      "explicit backoff",
      () =>
        Response.json(
          { errors: [{ type: "RATE_LIMIT" }] },
          {
            headers: {
              "retry-after": "60",
              "x-ratelimit-resource": "graphql",
              "x-ratelimit-remaining": "0",
            },
          },
        ),
    ],
  ])("does not bypass GraphQL %s with another membership transport", async (_label, response) => {
    const upstream = vi.fn<typeof fetch>(async () => response());
    vi.stubGlobal("fetch", upstream);
    await expect(
      verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", 42),
    ).rejects.toBeDefined();
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("applies egress protection to the REST membership fallback", async () => {
    const upstream = vi.fn<typeof fetch>(async () => graphqlRateLimitResponse());
    vi.stubGlobal("fetch", upstream);
    const guarded = withGitHubEgress(env(), [{ pattern: "memberships", replacement: "public" }]);
    await expect(
      verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", 42, guarded.githubEgress),
    ).rejects.toMatchObject({ status: 403, code: "string_rewrite_denied" });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each(["oversized", "body failure", "transport failure"])(
    "bounds REST %s without leaking upstream content",
    async (failure) => {
      const upstream = vi.fn<typeof fetch>().mockResolvedValueOnce(graphqlRateLimitResponse());
      let cancelled = false;
      if (failure === "transport failure") {
        upstream.mockRejectedValueOnce(new Error("synthetic-private-upstream"));
      } else {
        upstream.mockResolvedValueOnce(
          new Response(
            new ReadableStream({
              start(controller) {
                if (failure === "oversized") controller.enqueue(new Uint8Array(513));
                else controller.error(new Error("synthetic-private-upstream"));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
        );
      }
      vi.stubGlobal("fetch", upstream);
      await expect(
        verifyGitHubOrgMemberWithToken(
          { ...env(), MAX_RESPONSE_BYTES: "512" } as unknown as Env,
          "org-token",
          "octo",
          42,
        ),
      ).rejects.toMatchObject({
        status: 502,
        code: "org_verification_failed",
        message:
          failure === "transport failure"
            ? "GitHub membership request failed"
            : "GitHub membership response was invalid",
      });
      if (failure === "oversized") expect(cancelled).toBe(true);
    },
  );

  it("denies users outside the allowed org", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => orgMembershipResponse(["other"])),
    );

    await expect(
      verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", 42),
    ).rejects.toMatchObject({
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
      verifyGitHubOrgMemberWithToken(env(), "invalid-token", "octo", 42),
    ).rejects.toMatchObject({ status: 502, code: "org_verification_failed" });
  });

  it("requires an enrolled ID even when a runtime caller omits it", async () => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    await expect(
      verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", undefined as unknown as number),
    ).rejects.toMatchObject({ status: 403, code: "github_identity_required" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("preserves missing-verifier and egress-policy errors", async () => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    await expect(verifyGitHubOrgMember(env(), "octo", 42)).rejects.toMatchObject({
      status: 503,
      code: "org_verification_unavailable",
    });
    const guarded = withGitHubEgress(env(), [{ pattern: "octo", replacement: "public" }]);
    await expect(
      verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", 42, guarded.githubEgress),
    ).rejects.toMatchObject({ status: 403, code: "string_rewrite_denied" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "42", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a malformed GraphQL account ID %s",
    async (databaseId) => {
      const body = await orgMembershipResponse(["openclaw"]).json<MembershipPayload>();
      body.data.user.databaseId = databaseId;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body)),
      );
      await expect(
        verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", 42),
      ).rejects.toMatchObject({ status: 502, code: "org_verification_failed" });
    },
  );

  it.each([null, [], "org", {}, { login: null }, { login: 1 }, { login: "" }, { login: " " }])(
    "rejects malformed organization nodes %j even alongside a valid member",
    async (node) => {
      const body = await orgMembershipResponse(["openclaw"]).json<MembershipPayload>();
      body.data.user.organizations.nodes.push(node);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body)),
      );
      await expect(
        verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", 42),
      ).rejects.toMatchObject({ status: 502, code: "org_verification_failed" });
    },
  );

  it.each([null, [], "bad", {}, { data: null }, { data: { user: [] } }, { errors: "bad" }])(
    "rejects malformed GraphQL envelopes %j",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body)),
      );
      await expect(
        verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", 42),
      ).rejects.toMatchObject({ status: 502, code: "org_verification_failed" });
    },
  );

  it("rejects cursor cycles and malformed pagination before accepting membership", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(orgMembershipResponse(["other"], true, "first"))
      .mockResolvedValueOnce(orgMembershipResponse(["other"], true, "second"))
      .mockResolvedValueOnce(orgMembershipResponse(["openclaw"], true, "first"));
    vi.stubGlobal("fetch", upstream);
    await expect(
      verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", 42),
    ).rejects.toMatchObject({ status: 502, code: "org_verification_failed" });
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["missing continuation", true, null],
    ["blank continuation", true, ""],
    ["invalid hasNextPage", "yes", "next"],
  ])("rejects %s pagination", async (_label, hasNextPage, endCursor) => {
    const body = await orgMembershipResponse(["openclaw"]).json<MembershipPayload>();
    body.data.user.organizations.pageInfo = { hasNextPage, endCursor };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );
    await expect(
      verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", 42),
    ).rejects.toMatchObject({ status: 502, code: "org_verification_failed" });
  });

  it("caps membership bodies and maps failed body reads to the upstream error contract", async () => {
    let cancelled = false;
    const oversized = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(33));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const failed = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("synthetic-private-upstream"));
        },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(oversized).mockResolvedValueOnce(failed),
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        verifyGitHubOrgMemberWithToken(
          { ...env(), MAX_RESPONSE_BYTES: "32" } as unknown as Env,
          "org-token",
          "octo",
          42,
        ),
      ).rejects.toMatchObject({
        status: 502,
        code: "org_verification_failed",
        message: "GitHub membership response was invalid",
      });
    }
    expect(cancelled).toBe(true);
  });

  it("returns rate-limit metadata with an upstream failure and blocks credential redirects", async () => {
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 429,
          headers: {
            "x-ratelimit-resource": "graphql",
            "x-ratelimit-remaining": "0",
            "retry-after": "60",
          },
        }),
    );
    vi.stubGlobal("fetch", upstream);
    await expect(
      verifyGitHubOrgMemberWithToken(env(), "org-token", "octo", 42),
    ).rejects.toMatchObject({
      status: 502,
      code: "org_verification_failed",
      details: {
        github_rate_limit_resource: "graphql",
        github_rate_limit_remaining: "0",
        github_retry_after: "60",
      },
    });
    expect(upstream.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });
});

function env(): Env {
  return { ALLOWED_GITHUB_ORG: "openclaw", REQUEST_TIMEOUT_MS: "1234" } as unknown as Env;
}

function graphqlRateLimitResponse(status = 200, errorType = "RATE_LIMIT"): Response {
  return Response.json(
    status === 403
      ? { message: "API rate limit already exceeded for user ID 42." }
      : { errors: [{ type: errorType, message: "synthetic rate limit" }] },
    {
      status,
      headers: { "x-ratelimit-resource": "graphql", "x-ratelimit-remaining": "0" },
    },
  );
}

type MembershipPayload = {
  data: {
    user: {
      databaseId: unknown;
      organizations: { nodes: unknown[]; pageInfo: unknown };
    };
  };
};

function orgMembershipResponse(
  organizations: string[],
  hasNextPage = false,
  endCursor: string | null = null,
): Response {
  return Response.json({
    data: {
      user: {
        databaseId: 42,
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
