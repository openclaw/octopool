import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { githubToken } from "../../src/github-auth";
import { withGitHubEgress } from "../../src/github-egress";
import {
  bearer,
  callWorker,
  CALLER_TOKEN,
  jsonResponse,
  POOL,
  rateHeaders,
  seedPool,
} from "./harness";

const permissions = {
  metadata: "read",
  contents: "read",
  pull_requests: "read",
  issues: "read",
  actions: "read",
  checks: "read",
  statuses: "read",
};
let installation = 71000;
const query =
  "query($owner:String!,$name:String!,$pr:Int!) { repository(owner:$owner,name:$name) { pullRequest(number:$pr) { state mergeable headRefOid comments(first:10) { nodes { body } } } } }";
const batchQuery =
  'query($owner:String!,$name:String!){p1:repository(owner:$owner,name:$name){pullRequest(number:42){title}} p2:repository(owner:"OPENCLAW",name:"OCTOPOOL"){pullRequest(number:43){title}}}';
const raw =
  '{"data":{"repository":{"pullRequest":{"state":"OPEN","mergeable":"MERGEABLE","headRefOid":"0123456789abcdef0123456789abcdef01234567","comments":{"nodes":[{"body":"a & b \\u003cfixture\\u003e"}]},"large":9007199254740993}}}}';
type Envelope = {
  status: number;
  body: string;
  body_encoding: string;
  identity: { id: string; kind: string };
  relay: { cache: string; route_kind: string };
};

async function seedApp(): Promise<number> {
  await seedPool({ secondary: true });
  const id = ++installation;
  await env.DB.prepare(
    "UPDATE identities SET kind='github_app', secret_ref='TEST_APP_KEY', installation_id=? WHERE id='secondary'",
  )
    .bind(id)
    .run();
  return id;
}

function read(
  options: { query?: string; repo?: string; maxAge?: number; token?: string } = {},
): Promise<Response> {
  return callWorker("/v1/github/request", {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token ?? CALLER_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      pool: POOL,
      method: "POST",
      path: "/graphql",
      graphql: {
        query: options.query ?? query,
        variables: { owner: "openclaw", name: options.repo ?? "octopool", pr: 42 },
      },
      headers: { "cache-control": `max-age=${options.maxAge ?? 0}` },
    }),
  });
}

function upstream(
  id: number,
  options: {
    visibility?: boolean;
    installationStatus?: number;
    mintStatus?: number;
    issued?: Record<string, unknown>;
    permissions?: Record<string, string>;
    account?: string;
    graphql?: () => Response | Promise<Response>;
    broad?: boolean;
  } = {},
) {
  const minted: string[] = [];
  let queries = 0;
  const mock = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path.startsWith("/repos/openclaw/")) {
      expect(bearer(request)).toBe("test-org-token");
      return jsonResponse({ private: options.visibility ?? false });
    }
    if (path === `/app/installations/${id}`) {
      expect(request.method).toBe("GET");
      return jsonResponse(
        {
          account: { login: options.account ?? "openclaw" },
          permissions: options.permissions ?? {
            ...permissions,
            contents: "write",
            administration: "write",
            members: "read",
          },
        },
        options.installationStatus ?? 200,
      );
    }
    if (path === `/app/installations/${id}/access_tokens`) {
      expect(request.method).toBe("POST");
      if (request.body === null && options.broad)
        return jsonResponse({
          token: "installation-wide",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      const body = await request.json<{ repositories: string[]; permissions: unknown }>();
      expect(body.repositories).toHaveLength(1);
      expect(body.permissions).toEqual(options.permissions ?? permissions);
      const repo = body.repositories[0]!;
      minted.push(repo);
      return jsonResponse(
        {
          token: `scoped-${repo}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: options.permissions ?? permissions,
          repositories: [{ full_name: `openclaw/${repo}`, private: false }],
          ...options.issued,
        },
        options.mintStatus ?? 201,
      );
    }
    expect(request.url).toBe("https://api.github.com/graphql");
    expect(request.method).toBe("POST");
    const body = await request.json<{ query: string; variables: { name: string } }>();
    expect(bearer(request)).toBe(`scoped-${body.variables.name}`);
    expect(request.headers.has("cache-control")).toBe(false);
    queries++;
    return (
      options.graphql?.() ??
      new Response(raw, {
        headers: {
          "content-type": "application/json",
          ...Object.fromEntries(new Headers(rateHeaders({ remaining: 4_999 - queries }))),
          "x-ratelimit-resource": "graphql",
        },
      })
    );
  });
  vi.stubGlobal("fetch", mock);
  return { mock, minted, queries: () => queries };
}

describe("repository GraphQL relay", () => {
  it("uses one verified public repo token for every alias and reuses the batch for 20 seconds", async () => {
    const id = await seedApp();
    const body = {
      data: { p1: { pullRequest: { title: "first" } }, p2: { pullRequest: { title: "second" } } },
    };
    const calls = upstream(id, { graphql: () => jsonResponse(body) });
    expect(await (await read({ query: batchQuery, maxAge: 20 })).json<Envelope>()).toMatchObject({
      body: JSON.stringify(body),
      relay: { cache: "miss" },
    });
    expect(await (await read({ query: batchQuery, maxAge: 20 })).json<Envelope>()).toMatchObject({
      body: JSON.stringify(body),
      relay: { cache: "hit" },
    });
    expect(calls.minted).toEqual(["octopool"]);
    expect(calls.queries()).toBe(1);
    expect(await (await read({ query: batchQuery, maxAge: 0 })).json<Envelope>()).toMatchObject({
      relay: { cache: "miss" },
    });
    expect(calls.queries()).toBe(2);
  });

  it("rejects a second repository before any visibility or credential work", async () => {
    const id = await seedApp();
    const calls = upstream(id);
    expect(
      (await read({ query: batchQuery.replace('name:"OCTOPOOL"', 'name:"private"') })).status,
    ).toBe(424);
    expect(calls.mock).not.toHaveBeenCalled();
  });
  it("never reuses or overwrites an installation-wide token", async () => {
    const id = await seedApp();
    const calls = upstream(id, { broad: true });
    const identity = {
      id: "secondary",
      kind: "github_app" as const,
      login: "secondary",
      secret_ref: "TEST_APP_KEY",
      installation_id: id,
      weight: 100,
    };
    expect(await githubToken(withGitHubEgress(env, []), identity)).toBe("installation-wide");
    expect((await read()).status).toBe(200);
    expect(await githubToken(withGitHubEgress(env, []), identity)).toBe("installation-wide");
    expect(calls.minted).toEqual(["octopool"]);
    expect(calls.queries()).toBe(1);
  });

  it("uses only the repo-scoped App, preserves bytes, caches normalized queries, and audits live reads", async () => {
    const id = await seedApp();
    const calls = upstream(id);
    const first = await (await read()).json<Envelope>();
    expect(first).toMatchObject({
      status: 200,
      body: raw,
      body_encoding: "text",
      identity: { id: "secondary", kind: "github_app" },
      relay: { route_kind: "graphql_read", cache: "miss" },
    });
    expect(
      await (await read({ query: query.replaceAll("{", "{\n"), maxAge: 30 })).json<Envelope>(),
    ).toMatchObject({ body: raw, relay: { cache: "hit" } });
    expect(calls.queries()).toBe(1);
    await read();
    await read({ repo: "openclaw" });
    expect(calls.queries()).toBe(3);
    expect(calls.minted).toEqual(["octopool", "openclaw"]);
    const audits = await env.DB.prepare(
      "SELECT route_key, route_kind, identity_id, requested_max_age, cache_status FROM audit_events ORDER BY rowid",
    ).all();
    expect(audits.results).toEqual(
      [0, 30, 0, 0].map((age, i) => ({
        route_key: "POST /graphql repository-read",
        route_kind: "graphql_read",
        identity_id: "secondary",
        requested_max_age: age,
        cache_status: i === 1 ? "hit" : "miss",
      })),
    );
    expect((await poolCoordinatorStub(env, POOL).snapshot()).rates).toMatchObject([
      { identity_id: "secondary", resource: "graphql", remaining: 4996 },
    ]);
    expect(
      await env.DB.prepare(
        "SELECT DISTINCT unixepoch(expires_at)-unixepoch(created_at) AS ttl, unixepoch(stale_expires_at)-unixepoch(expires_at) AS stale FROM github_cache_entries",
      ).all(),
    ).toMatchObject({ results: [{ ttl: 60, stale: 0 }] });
  });

  it.each([query, batchQuery])(
    "refuses private repositories before token exchange or query execution: %s",
    async (query) => {
      const id = await seedApp();
      const calls = upstream(id, { visibility: true });
      const response = await read({ query });
      expect(response.status).toBe(424);
      expect(await response.json()).toMatchObject({
        error: { code: "fallback_local", details: { reason: "repo_not_public" } },
      });
      expect(calls.mock).toHaveBeenCalledTimes(1);
      expect(calls.minted).toEqual([]);
    },
  );

  it("refuses PAT-only pools", async () => {
    await seedPool();
    const mock = vi.fn<typeof fetch>(async () => jsonResponse({ private: false }));
    vi.stubGlobal("fetch", mock);
    expect((await read()).status).toBe(424);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("never executes when public visibility is unknown", async () => {
    await seedApp();
    const mock = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe("GET");
      expect(request.url).not.toContain("/app/installations/");
      expect(request.url).not.toContain("/graphql");
      return jsonResponse({ message: "unavailable" }, 503);
    });
    vi.stubGlobal("fetch", mock);
    const response = await read();
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { details: { reason: "repo_public_check_failed" } },
    });
    expect(mock).toHaveBeenCalled();
  });

  it("caps the upstream response before storage", async () => {
    const id = await seedApp();
    upstream(id, { graphql: () => new Response("x".repeat(Number(env.MAX_RESPONSE_BYTES) + 1)) });
    const response = await read();
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { details: { reason: "github_response_too_large" } },
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM github_cache_entries").first(),
    ).toEqual({ count: 0 });
  });

  it.each([
    { installationStatus: 404 },
    { mintStatus: 422 },
    { account: "another-owner" },
    { issued: { repositories: [] } },
    { issued: { repositories: [{ full_name: "openclaw/octopool", private: true }] } },
    {
      issued: {
        repositories: [{ full_name: "openclaw/octopool" }, { full_name: "openclaw/private" }],
      },
    },
    { issued: { repositories: [{ full_name: "other/octopool" }] } },
    { issued: { permissions: { ...permissions, contents: "write" } } },
    { issued: { permissions: { ...permissions, members: "read" } } },
    { issued: { permissions: {} } },
    { issued: { expires_at: "invalid" } },
  ])("falls back without ever broadening failed token issuance: %j", async (options) => {
    const id = await seedApp();
    const calls = upstream(id, options);
    const response = await read({ query: batchQuery });
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "github_app_repo_token_unavailable" } },
    });
    expect(calls.queries()).toBe(0);
  });

  it("requests only permissions actually granted to the App", async () => {
    const id = await seedApp();
    const calls = upstream(id, { permissions: { metadata: "read", contents: "read" } });
    expect((await read()).status).toBe(200);
    expect(calls.queries()).toBe(1);
  });

  it("returns HTTP-200 errors unchanged, records exhaustion, and never caches errors", async () => {
    const id = await seedApp();
    const body = {
      data: null,
      errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
    };
    const calls = upstream(id, {
      graphql: () =>
        jsonResponse(body, 200, {
          ...Object.fromEntries(new Headers(rateHeaders({ remaining: 0 }))),
          "x-ratelimit-resource": "graphql",
        }),
    });
    expect(await (await read()).json<Envelope>()).toMatchObject({
      status: 200,
      body: JSON.stringify(body),
    });
    expect((await read()).status).toBe(424);
    expect(calls.queries()).toBe(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM github_cache_entries").first(),
    ).toEqual({ count: 0 });
    expect((await poolCoordinatorStub(env, POOL).snapshot()).rates).toMatchObject([
      { identity_id: "secondary", resource: "graphql", remaining: 0 },
    ]);
  });

  it("records GraphQL secondary limits in the identity cooldown", async () => {
    const id = await seedApp();
    upstream(id, {
      graphql: () =>
        jsonResponse(
          {
            errors: [
              { type: "RATE_LIMITED", message: "You have exceeded a secondary rate limit." },
            ],
          },
          200,
        ),
    });
    expect((await read()).status).toBe(200);
    expect((await poolCoordinatorStub(env, POOL).snapshot()).cooldowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity_id: "secondary",
          route_key: "*",
          reason: "github_error",
        }),
      ]),
    );
    expect((await read()).status).toBe(424);
  });

  it("keeps authentication and the AST boundary ahead of backend work", async () => {
    const id = await seedApp();
    const calls = upstream(id);
    expect((await read({ token: "invalid" })).status).toBe(401);
    for (const query of [
      'mutation { deleteRepository(input:{repositoryId:"x"}) { clientMutationId } }',
      "{ viewer { login } }",
      'query { repository(owner:"other",name:"octopool") { name } }',
    ]) {
      expect((await read({ query })).status).toBe(424);
    }
    expect(calls.mock).not.toHaveBeenCalled();
  });
});
