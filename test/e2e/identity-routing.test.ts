import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { loadIdentities } from "../../src/db";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { bearer, githubUpstream, jsonResponse, POOL, relay, seedPool } from "./harness";
import { issueEventCases } from "../fixtures/issue-event-visibility";
import { releaseMarkdown } from "../fixtures/release-summary";
import { requestWithEnv } from "./identity-routing-support";

const PATH = "/repos/openclaw/octopool";
const conditional = { headers: { "if-none-match": '"identity-routing"' } };

describe("eligible and usable identity routing", () => {
  it("serves an allowlisted public repo with only a wildcard PAT", async () => {
    await seedPool();
    await env.DB.prepare(
      "UPDATE identity_scopes SET owner = '*' WHERE identity_id = 'primary'",
    ).run();
    const route = classifyRoute(
      { pool: POOL, method: "GET", path: PATH },
      defaultPolicy("openclaw"),
    );
    const ids = (await loadIdentities(env, POOL, route, { fresh: true })).map((id) => id.id);
    const upstream = githubUpstream({ primary: jsonResponse({ private: false }) });
    vi.stubGlobal("fetch", upstream);
    const response = await relay(PATH, undefined, conditional);
    const body = await response.json();
    expect({ ids, status: response.status, body }).toMatchObject({
      ids: ["primary"],
      status: 200,
      body: { identity: { id: "primary" } },
    });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("skips a preferred missing credential for a healthy PAT", async () => {
    await seedPool({ secondary: true });
    await env.DB.prepare(
      "UPDATE identities SET secret_ref = 'SYNTHETIC_MISSING_BINDING' WHERE id = 'primary'",
    ).run();
    const upstream = githubUpstream({ primary: jsonResponse({ private: false }) });
    vi.stubGlobal("fetch", upstream);
    const response = await relay(PATH, undefined, conditional);
    const body = await response.json();
    expect({ status: response.status, body }).toMatchObject({
      status: 200,
      body: { identity: { id: "secondary" } },
    });
    expect(upstream).toHaveBeenCalledTimes(2);
    const health = await poolCoordinatorStub(env, POOL).snapshot();
    expect(health.rates).toEqual([]);
    expect(health.cooldowns).toEqual([
      expect.objectContaining({
        identity_id: "primary",
        route_key: "*",
        status: 503,
        reason: "identity_secret_missing",
      }),
    ]);
  });

  it("does not eagerly check an unselected missing binding", async () => {
    await seedPool({ secondary: true });
    vi.stubGlobal("fetch", githubUpstream({ primary: jsonResponse({ private: false }) }));
    expect(await (await requestWithEnv({ TEST_PAT_SECONDARY: undefined })).json()).toMatchObject({
      identity: { id: "primary" },
    });
    expect((await poolCoordinatorStub(env, POOL).snapshot()).cooldowns).toEqual([]);
  });

  it.each([404, 422, 503, 401, 403, 429])(
    "preserves ordinary resource %s selection and feedback",
    async (status) => {
      await seedPool({ secondary: true });
      const tokens: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const token = bearer(input, init);
          if (token === "test-org-token") return jsonResponse({ private: false });
          tokens.push(token!);
          return token === "test-primary-token"
            ? jsonResponse({ message: "resource failure" }, status)
            : jsonResponse({ private: false });
        }),
      );
      const response = await requestWithEnv();
      const failover = [401, 403, 429].includes(status);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: failover ? 200 : status,
        identity: { id: failover ? "secondary" : "primary" },
      });
      expect(tokens).toEqual(
        failover ? ["test-primary-token", "test-secondary-token"] : ["test-primary-token"],
      );
      const snapshot = await poolCoordinatorStub(env, POOL).snapshot();
      expect(snapshot.rates).toEqual([]);
      expect(snapshot.cooldowns).toEqual(
        failover
          ? [expect.objectContaining({ identity_id: "primary", status, reason: "github_error" })]
          : [],
      );
    },
  );

  it.each(["private", "owner-policy", "logs-policy", "stored-policy", "native"])(
    "retains the %s boundary with a missing wildcard PAT and healthy alternate",
    async (boundary) => {
      await seedPool({ secondary: true });
      await env.DB.prepare("UPDATE identity_scopes SET owner = '*'").run();
      if (boundary === "owner-policy" || boundary === "logs-policy")
        await env.DB.prepare("UPDATE pools SET policy_json = ?")
          .bind(
            JSON.stringify({ allowed_owners: [], allow_public_repos: false, allow_logs: false }),
          )
          .run();
      if (boundary === "stored-policy")
        await env.DB.prepare("UPDATE pools SET policy_json = '[]'").run();
      const upstream = vi.fn<typeof fetch>(async () =>
        jsonResponse({ private: boundary === "private" }),
      );
      vi.stubGlobal("fetch", upstream);
      const path =
        boundary === "native"
          ? `${PATH}/rules/branches/main`
          : boundary === "logs-policy"
            ? `${PATH}/actions/jobs/42/logs`
            : PATH;
      const response = await requestWithEnv({ TEST_PAT_PRIMARY: undefined }, path);
      expect(response.status).toBe(boundary === "stored-policy" ? 503 : 424);
      const reason =
        boundary === "private"
          ? "repo_not_public"
          : boundary === "native"
            ? "local_credentials_required"
            : boundary === "logs-policy"
              ? "logs_denied"
              : "owner_denied";
      expect(await response.json()).toMatchObject({
        error:
          boundary === "stored-policy"
            ? { code: "pool_policy_unavailable" }
            : { code: "fallback_local", details: { reason } },
      });
      expect(upstream.mock.calls.map(([input, init]) => bearer(input, init))).toEqual(
        boundary === "private" ? ["test-org-token"] : [],
      );
      expect(await poolCoordinatorStub(env, POOL).snapshot()).toMatchObject({
        cooldowns: [],
        rates: [],
      });
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS count FROM github_cache_entries").first(),
      ).toEqual({ count: 0 });
    },
  );

  it("does not widen alternate eligibility after selected local failure", async () => {
    await seedPool({ secondary: true });
    await env.DB.prepare(
      "UPDATE identity_scopes SET repo = 'different-repo' WHERE identity_id = 'secondary'",
    ).run();
    const upstream = githubUpstream({ primary: jsonResponse({ private: false }) });
    vi.stubGlobal("fetch", upstream);
    const response = await requestWithEnv({ TEST_PAT_PRIMARY: undefined });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "identity_secret_missing" } });
    expect(upstream.mock.calls.map(([input, init]) => bearer(input, init))).toEqual([
      "test-org-token",
    ]);
    expect((await poolCoordinatorStub(env, POOL).snapshot()).cooldowns).toEqual([
      expect.objectContaining({ identity_id: "primary" }),
    ]);
  });
});

describe.each([
  {
    kind: "release",
    path: `${PATH}/releases/tags/v0.8.0`,
    publicBody: { tag_name: "v0.8.0", draft: false, body: releaseMarkdown },
    headers: { "x-octopool-public-shape": "release-summary-v1" },
  },
  ...issueEventCases.map((fixture) => ({ ...fixture, headers: {} })),
])("$kind token-free credential boundary", ({ kind, path, publicBody, headers }) => {
  it.each([200, 429, 503])(
    "keeps upstream %s anonymous with a missing PAT and healthy alternate",
    async (status) => {
      await seedPool({ secondary: true });
      const calls: Request[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          calls.push(request);
          if (new URL(request.url).pathname === PATH) return jsonResponse({ private: false });
          return jsonResponse(
            status === 200 ? publicBody : { message: "anonymous unavailable" },
            status,
          );
        }),
      );
      const response = await requestWithEnv({ TEST_PAT_PRIMARY: undefined }, path, { headers });
      expect(response.status).toBe(status === 200 ? 200 : 424);
      const body = await response.json<{ identity?: unknown; body?: unknown }>();
      expect(body.identity).toBeUndefined();
      if (status === 200) expect(body.body).toEqual(publicBody);
      else expect(body).toMatchObject({ error: { code: "fallback_local" } });
      const resources = calls.filter((request) => new URL(request.url).pathname === path);
      expect(resources).toHaveLength(1);
      expect(resources[0]!.headers.has("authorization")).toBe(false);
      expect(
        calls.every(
          (request) =>
            bearer(request) === undefined ||
            (kind === "release" &&
              bearer(request) === "test-org-token" &&
              new URL(request.url).pathname === PATH),
        ),
      ).toBe(true);
      expect(await poolCoordinatorStub(env, POOL).snapshot()).toMatchObject({
        cooldowns: [],
        rates: [],
      });
      expect(
        (await env.DB.prepare("SELECT identity_id FROM github_cache_entries").all()).results.every(
          (row) => row.identity_id === null,
        ),
      ).toBe(true);
    },
  );
});

describe("real D1 eligibility boundaries", () => {
  it("preserves pool, active, exact/case, NULL, App, publicOnly, ownerless and DISTINCT semantics", async () => {
    await seedPool();
    await env.DB.prepare(
      "INSERT INTO pools (id, name, policy_json) VALUES ('other', 'other', '{}')",
    ).run();
    const fixtures: [string, string, string, string, string | null, string][] = [
      ["exact", POOL, "pat", "OPENCLAW", "OCTOPOOL", "active"],
      ["app", POOL, "github_app", "OpenClaw", null, "active"],
      ["app-exact", POOL, "github_app", "openclaw", "octopool", "active"],
      ["wrong-repo", POOL, "github_app", "openclaw", "another", "active"],
      ["wildcard-app", POOL, "github_app", "*", null, "active"],
      ["wildcard-repo", POOL, "pat", "*", "octopool", "active"],
      ["broad", POOL, "pat", "*", null, "active"],
      ["disabled", POOL, "pat", "*", null, "disabled"],
      ["elsewhere", "other", "pat", "*", null, "active"],
      ["wrong-owner", POOL, "pat", "another", null, "active"],
    ];
    for (const [id, pool, kind, owner, repo, status] of fixtures) {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO identities (id, pool_id, kind, login, secret_ref, status) VALUES (?, ?, ?, ?, 'ABSENT', ?)",
        ).bind(id, pool, kind, id, status),
        env.DB.prepare(
          "INSERT INTO identity_scopes (identity_id, owner, repo) VALUES (?, ?, ?)",
        ).bind(id, owner, repo),
      ]);
    }
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO identity_scopes (identity_id, owner, repo) VALUES ('broad', 'OpenClaw', 'Octopool')",
      ),
      env.DB.prepare(
        "INSERT INTO identity_scopes (identity_id, owner, repo) VALUES ('broad', 'openclaw', NULL)",
      ),
      env.DB.prepare(
        "INSERT INTO identity_scopes (identity_id, owner, repo) VALUES ('broad', '*', NULL)",
      ),
      env.DB.prepare(
        "INSERT INTO identities (id, pool_id, kind, login, secret_ref, status) VALUES ('unscoped', ?, 'pat', 'unscoped', 'ABSENT', 'active')",
      ).bind(POOL),
    ]);
    const policy = defaultPolicy("openclaw");
    const ids = async (path: string) =>
      (
        await loadIdentities(
          env,
          POOL,
          classifyRoute({ pool: POOL, method: "GET", path }, policy),
          { fresh: true },
        )
      )
        .map((id) => id.id)
        .sort();
    expect(await ids(PATH)).toEqual(["app", "app-exact", "broad", "exact", "primary"]);
    expect(await ids("/repos/another/public")).toEqual(["broad"]);
    expect(await ids("/rate_limit")).toEqual([
      "app",
      "app-exact",
      "broad",
      "exact",
      "primary",
      "unscoped",
      "wildcard-app",
      "wildcard-repo",
      "wrong-owner",
      "wrong-repo",
    ]);
    const { queries } = await import("../../src/generated/sql");
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${queries.listActiveIdentitiesForRoute}`)
      .bind(POOL, "openclaw", "octopool")
      .all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join("\n")).toContain(
      "idx_identities_pool_status",
    );
  });

  it("uses the wildcard PAT outside the allowlist after public proof", async () => {
    await seedPool();
    await env.DB.prepare("UPDATE identity_scopes SET owner = '*'").run();
    const upstream = githubUpstream({ primary: jsonResponse({ private: false }) });
    vi.stubGlobal("fetch", upstream);
    expect(
      await (await relay("/repos/another/public", undefined, conditional)).json(),
    ).toMatchObject({ identity: { id: "primary" } });
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
