import { describe, expect, it } from "vitest";
import { parseGraphQLRead } from "../src/graphql-read";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import { githubCacheKey } from "../src/cache";
import { compileStringRewriteRules, guardStringRewriteRead } from "../src/string-rewrites";

const root = (fields: string) => `{ repository(owner:"openclaw", name:"octopool") { ${fields} } }`;
const envelope = (query: string, variables: unknown = {}) =>
  validateRelayRequest({
    pool: "maintainers",
    method: "POST",
    path: "/graphql",
    graphql: { query, variables },
  });

describe("repository GraphQL AST boundary", () => {
  it.each([
    root("pullRequest(number:42) { state mergeable headRefOid }"),
    root(
      "pullRequest(number:42) { commits(last:1) { nodes { commit { statusCheckRollup { state contexts(first:100) { nodes { __typename ... on CheckRun { name conclusion } } } } } } } }",
    ),
    root(
      "pullRequest(number:42) { comments(first:100) { nodes { body author { login } } pageInfo { hasNextPage endCursor } } }",
    ),
    '{ r: repository(owner:"openclaw", name:"octopool") @include(if:true) { name @skip(if:false) } __typename }',
    'query Q { ...Root } fragment Root on Query { repository(owner:"openclaw",name:"octopool") { ...Names } } fragment Names on Repository { name }',
    root("owner { repositories(first:10) { nodes { name } } }"),
  ])("accepts a bounded public repository read: %s", (query) => {
    expect(parseGraphQLRead({ query })).toMatchObject({ owner: "openclaw", repo: "octopool" });
  });

  it.each([
    'mutation { repository(owner:"openclaw",name:"octopool") { name } }',
    'subscription { repository(owner:"openclaw",name:"octopool") { name } }',
    "{ viewer { login } }",
    root("viewerPermission"),
    root("safe: viewerCanAdminister"),
    root("__schema { types { name } }"),
    root('__type(name:"User") { name }'),
    ...[
      "node",
      "nodes",
      "search",
      "rateLimit",
      "organization",
      "user",
      "repositoryOwner",
      "enterprise",
      "resource",
      "marketplaceListings",
      "securityAdvisories",
      "sponsorsListing",
      "topic",
      "codeOfConduct",
      "codesOfConduct",
      "license",
      "licenses",
      "meta",
    ].map((field) => `{ ${field} { id } }`),
    `${root("name")} ${root("id")}`,
    'query A { repository(owner:"openclaw",name:"octopool") { name } } query B { viewer { login } }',
    '{ a: repository(owner:"openclaw",name:"octopool") { name } b: repository(owner:"openclaw",name:"other") { name } }',
    '{ repository(owner:"openclaw",name:"octopool") { name } other: rateLimit { remaining } }',
    root("name @defer"),
    root("...Missing"),
    `${root("...A")} fragment A on Repository { ...B } fragment B on Repository { ...A }`,
    `${root("name")} fragment Hidden on Repository { viewerPermission }`,
    `${root("name")} fragment Hidden on Repository { ...Missing }`,
    `${root("name")} fragment X on Repository { name } fragment X on Repository { id }`,
    root(`${"owner { ".repeat(12)}login${" }".repeat(12)}`),
    `${root("name")} #${"x".repeat(16_384)}`,
    '{ repository(owner:"openclaw",owner:"other",name:"octopool") { name } }',
    '{ repository(owner:"openclaw",name:"../private") { name } }',
    'query($owner:String="openclaw") { repository(owner:$owner,name:"octopool") { name } }',
  ])("refuses forbidden or unbounded documents: %s", (query) => {
    expect(() => parseGraphQLRead({ query })).toThrow();
  });

  it("resolves only supplied string variables and binds operationName", () => {
    const query =
      "query Q($owner:String!, $name:String!) { repository(owner:$owner,name:$name) { name } }";
    expect(
      parseGraphQLRead({
        query,
        variables: { owner: "OpenClaw", name: "Octopool", extra: [true, null, { number: 1 }] },
        operationName: "Q",
      }),
    ).toMatchObject({ owner: "openclaw", repo: "octopool" });
    for (const variables of [
      {},
      { owner: true, name: "octopool" },
      { owner: "openclaw", name: ["octopool"] },
      { owner: "openclaw", name: "octopool", large: "x".repeat(16_384) },
      { owner: "openclaw", name: "octopool", invalid: undefined },
    ]) {
      expect(() => parseGraphQLRead({ query, variables })).toThrow();
    }
    expect(() =>
      parseGraphQLRead({
        query,
        variables: { owner: "openclaw", name: "octopool" },
        operationName: "Other",
      }),
    ).toThrow();
  });

  it("normalizes printed documents and nested variable keys, retaining pool/repo/values", async () => {
    const a = envelope(root("name"), { z: { b: 1, a: 2 }, a: [3, 4] });
    const b = envelope('query {repository(owner: "openclaw",name: "octopool"){name}}', {
      a: [3, 4],
      z: { a: 2, b: 1 },
    });
    const route = classifyRoute(a, defaultPolicy("openclaw"));
    expect(route).toMatchObject({
      kind: "graphql_read",
      routeKey: "POST /graphql repository-read",
      resource: "graphql",
    });
    expect(await githubCacheKey(a.pool, a, route)).toBe(await githubCacheKey(b.pool, b, route));
    expect(await githubCacheKey("other", a, route)).not.toBe(
      await githubCacheKey(a.pool, a, route),
    );
    const changed = envelope(root("name"), { a: [4, 3], z: { b: 1, a: 2 } });
    expect(await githubCacheKey(a.pool, a, route)).not.toBe(
      await githubCacheKey(a.pool, changed, route),
    );
    expect(() => classifyRoute(a, defaultPolicy("another"))).toThrow();
  });

  it("checks decoded GraphQL strings and variables even before cache reuse", () => {
    const rules = compileStringRewriteRules([{ pattern: "forbidden", replacement: "public" }]);
    for (const request of [
      envelope(root('object(expression:"\\u0066orbidden") { id }')),
      envelope(root("name"), { value: "forbidden" }),
    ]) {
      expect(() => guardStringRewriteRead(request, rules)).toThrow();
    }
  });

  it("does not admit REST writes or mix GraphQL with REST/conditional envelopes", () => {
    for (const changes of [
      { method: "PATCH" },
      { path: "/repos/openclaw/octopool" },
      { method: "GET" },
      { headers: { "if-none-match": "old" } },
      { query: { query: "other" } },
    ]) {
      expect(() =>
        validateRelayRequest({
          pool: "maintainers",
          method: "POST",
          path: "/graphql",
          graphql: { query: root("name") },
          ...changes,
        }),
      ).toThrow();
    }
  });
});
