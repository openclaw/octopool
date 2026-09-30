import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { parseGraphQLRead } from "../src/graphql-read";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import { cachedResponseStillFresh, cacheTTLSeconds, githubCacheKey } from "../src/cache";
import { compileStringRewriteRules, guardStringRewriteRead } from "../src/string-rewrites";

const root = (fields: string) => `{ repository(owner:"openclaw", name:"octopool") { ${fields} } }`;
const codexBatch = readFileSync(
  new URL("../cmd/octopool/testdata/graphql-read/codex-batch.txt", import.meta.url),
  "utf8",
);
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
    '{ a:repository(owner:"OpenClaw",name:"Octopool"){name} b:repository(owner:"openclaw",name:"octopool"){id} __typename }',
    'query { ...Roots } fragment Roots on Query { a:repository(owner:"openclaw",name:"octopool"){name} ... on Query { b:repository(owner:"OPENCLAW",name:"OCTOPOOL"){id} } }',
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
    '{ a: repository(owner:"openclaw",name:"octopool") { name } b: repository(owner:"other",name:"octopool") { name } }',
    '{ a: repository(owner:"openclaw",name:"octopool") { name } b: repository(owner:"openclaw",name:"../private") { name } }',
    '{ a: repository(owner:"openclaw",name:"octopool") { name } b: repository(owner:"openclaw",name:"octopool",extra:"x") { name } }',
    '{ a: repository(owner:"openclaw",name:"octopool") { name } ...More } fragment More on Query { b:repository(owner:"openclaw",name:"other"){name} }',
    codexBatch,
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

  it("accepts the exact captured Codex batch only after the CLI removes viewer", () => {
    const query = codexBatch.replace("viewer { login }", "");
    expect(parseGraphQLRead({ query })).toMatchObject({ owner: "openclaw", repo: "openclaw" });
    expect(() =>
      parseGraphQLRead({
        query: query.replace(
          'p2: repository(owner:"openclaw",name:"openclaw")',
          'p2: repository(owner:"openclaw",name:"private")',
        ),
      }),
    ).toThrow();
  });

  it("resolves and validates every alias against one repository", () => {
    const query =
      'query($owner:String!,$name:String!){a:repository(owner:"OpenClaw",name:"Octopool"){name} b:repository(owner:$owner,name:$name){id}}';
    expect(
      parseGraphQLRead({ query, variables: { owner: "openclaw", name: "octopool" } }),
    ).toMatchObject({ owner: "openclaw", repo: "octopool" });
    for (const variables of [
      { owner: "other", name: "octopool" },
      { owner: "openclaw", name: "private" },
      { owner: "openclaw", name: false },
      { owner: "openclaw", name: "x".repeat(101) },
      {},
    ]) {
      expect(() => parseGraphQLRead({ query, variables })).toThrow();
    }
  });

  it("bounds reuse by both the requested age and the 60-second static TTL", () => {
    const request = envelope(root("name"));
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    expect(cacheTTLSeconds(route)).toBe(60);
    const now = Date.now();
    const cached = (age: number) => ({
      status: 200,
      headers: {},
      body: "{}",
      body_encoding: "text" as const,
      created_at: new Date(now - age * 1000).toISOString(),
      expires_at: new Date(now + (60 - age) * 1000).toISOString(),
    });
    expect(cachedResponseStillFresh(cached(10), 20)).toBe(true);
    expect(cachedResponseStillFresh(cached(21), 20)).toBe(false);
    expect(cachedResponseStillFresh(cached(21), 30)).toBe(true);
    expect(cachedResponseStillFresh(cached(61), 120)).toBe(false);
  });

  it("partitions batched pages and PRs by the full query and variable values", async () => {
    const query = codexBatch.replace("viewer { login }", "");
    const request = envelope(query);
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    const key = await githubCacheKey(request.pool, request, route);
    for (const changed of [
      envelope(query.replaceAll('after:"MjAw"', 'after:"MzAw"')),
      envelope(query.replace("157854", "157855")),
      envelope(query.replace("146339", "146340")),
      envelope(query, { cursor: "MjAw", pr: 1 }),
      envelope(query, { cursor: "MzAw", pr: 2 }),
    ]) {
      expect(await githubCacheKey(request.pool, changed, route)).not.toBe(key);
    }
    const variableQuery = query
      .replace("query {", "query($cursor:String,$pr:Int!){")
      .replaceAll('"MjAw"', "$cursor")
      .replace("157854", "$pr");
    const a = envelope(variableQuery, { cursor: "MjAw", pr: 1 });
    for (const variables of [
      { cursor: "MzAw", pr: 1 },
      { cursor: "MjAw", pr: 2 },
    ]) {
      expect(await githubCacheKey(a.pool, a, route)).not.toBe(
        await githubCacheKey(a.pool, envelope(variableQuery, variables), route),
      );
    }
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
