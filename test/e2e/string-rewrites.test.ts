import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import {
  CALLER_TOKEN,
  callWorker,
  githubUpstream,
  jsonResponse,
  POOL,
  relay,
  seedPool,
} from "./harness";

const adminPath = "/v1/admin/string-rewrites";
const callerPath = `/v1/pools/${POOL}/string-rewrites`;
const synthetic = [{ pattern: "internal-model", replacement: "gpt-5.6-sol" }];
const adminHeaders = {
  authorization: "Bearer test-admin-token",
  "content-type": "application/json",
};

async function put(rules: unknown, expectedRevision = 1): Promise<Response> {
  return callWorker(adminPath, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ schema_version: 1, expected_revision: expectedRevision, rules }),
  });
}

async function expectNoPublication(): Promise<void> {
  for (const table of ["audit_events", "github_cache_entries", "github_public_repos"]) {
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).toEqual({
      count: 0,
    });
  }
}

describe("authoritative string rewrite policy API", () => {
  it("seeds an explicit singleton empty revision and exposes identical authenticated GETs", async () => {
    await seedPool();
    const admin = await callWorker(adminPath, { headers: adminHeaders });
    const caller = await callWorker(callerPath, {
      headers: { authorization: `Bearer ${CALLER_TOKEN}` },
    });
    expect(admin.status).toBe(200);
    expect(caller.status).toBe(200);
    expect(admin.headers.get("cache-control")).toBe("no-store");
    expect(caller.headers.get("cache-control")).toBe("no-store");
    const body = await admin.json();
    expect(body).toEqual({
      schema_version: 1,
      revision: 1,
      updated_at: expect.stringMatching(/^\d{4}-.*Z$/),
      rules: [],
    });
    expect(await caller.json()).toEqual(body);
    await expect(
      env.DB.prepare(
        "INSERT INTO string_rewrite_policy SELECT 2, schema_version, revision, updated_at, rules_json FROM string_rewrite_policy",
      ).run(),
    ).rejects.toThrow();
  });

  it.each([
    [adminPath, "GET", undefined, 401],
    [adminPath, "GET", CALLER_TOKEN, 401],
    [adminPath, "PUT", CALLER_TOKEN, 401],
    [callerPath, "GET", undefined, 401],
    [callerPath, "GET", "wrong-token", 401],
    ["/v1/pools/ungranted/string-rewrites", "GET", CALLER_TOKEN, 401],
    [callerPath, "PUT", CALLER_TOKEN, 404],
  ] as const)("requires the appropriate auth for %s %s %#", async (path, method, token, status) => {
    await seedPool();
    await put(synthetic);
    const response = await callWorker(path, {
      method,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("internal-model");
  });

  it("updates by revision without echoing rules and prevents stale writes", async () => {
    const response = await put(synthetic);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      schema_version: 1,
      revision: 2,
      updated_at: expect.any(String),
      rule_count: 1,
    });
    const stale = await put([]);
    expect(stale.status).toBe(409);
    expect(stale.headers.get("cache-control")).toBe("no-store");
    expect(await stale.text()).not.toContain("internal-model");
    const read = await callWorker(adminPath, { headers: adminHeaders });
    expect(await read.json()).toMatchObject({ revision: 2, rules: synthetic });
    const cleared = await put([], 2);
    expect(await cleared.json()).toMatchObject({ revision: 3, rule_count: 0 });
  });

  it("atomically permits only one competing writer", async () => {
    const responses = await Promise.all([
      put(synthetic),
      put([{ pattern: "internal-family-[a-z]+", replacement: "" }]),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const row = await env.DB.prepare(
      "SELECT revision, rules_json FROM string_rewrite_policy",
    ).first<{ revision: number; rules_json: string }>();
    expect(row?.revision).toBe(2);
    expect(JSON.parse(row!.rules_json)).toHaveLength(1);
  });

  it.each([
    '{"schema_version":1,"expected_revision":1,"rules":[],"rules":[]}',
    '{"schema_version":1,"expected_revision":1,"rul\\u0065s":[],"rules":[]}',
    '{"schema_version":1,"expected_revision":1,"rules":[{"pattern":"a","replacement":"","replacement":"X"}]}',
    '{"schema_version":2,"expected_revision":1,"rules":[]}',
    '{"schema_version":1,"expected_revision":0,"rules":[]}',
    '{"schema_version":1,"expected_revision":1.5,"rules":[]}',
    '{"schema_version":1,"expected_revision":9007199254740992,"rules":[]}',
    '{"schema_version":1,"rules":[]}',
    '{"schema_version":1,"expected_revision":1,"rules":[],"extra":true}',
    '{"schema_version":1,"expected_revision":1,"rules":[{"pattern":"internal-model(?=x)","replacement":""}]}',
    '{"schema_version":1,"expected_revision":1,"rules":[{"pattern":"a"}]}',
    '{"schema_version":1,"expected_revision":1,"rules":[{"pattern":"a","replacement":"\\ud800"}]}',
    '{"schema_version":1,"expected_revision":1,"rules":null}',
    "invalid internal-model JSON",
    " ".repeat(65_537),
  ])("rejects malformed policy with a content-free response %#", async (body) => {
    const response = await callWorker(adminPath, { method: "PUT", headers: adminHeaders, body });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_string_rewrite_policy", message: "Invalid string rewrite policy" },
    });
    expect(
      await env.DB.prepare("SELECT revision, rules_json FROM string_rewrite_policy").first(),
    ).toEqual({ revision: 1, rules_json: "[]" });
  });

  it("rejects invalid UTF-8 and unsupported media types", async () => {
    const body = new Uint8Array([
      ...new TextEncoder().encode(
        '{"schema_version":1,"expected_revision":1,"rules":[{"pattern":"',
      ),
      0xff,
      ...new TextEncoder().encode('","replacement":""}]}'),
    ]);
    const invalid = await callWorker(adminPath, { method: "PUT", headers: adminHeaders, body });
    expect(invalid.status).toBe(400);
    const media = await callWorker(adminPath, {
      method: "PUT",
      headers: { ...adminHeaders, "content-type": "text/plain" },
      body: "{}",
    });
    expect(media.status).toBe(400);
  });
});

describe("server read enforcement", () => {
  it.each([
    { path: "/repos/openclaw/internal-model" },
    { path: "/repos/openclaw/%69nternal-model" },
    { path: "/repos/openclaw/%2569nternal-model" },
    { path: "/repos/openclaw/%252569nternal-model" },
    { path: "/unsupported/internal-model" },
    { query: { q: "internal-model" } },
    { query: { q: ["safe", "%69nternal-model"] } },
    { query: { "internal-model": "safe" } },
    { query: { q: "%2569nternal-model" } },
    { query: { q: "\\u0069nternal-model" } },
    { query: { q: "%5Cu0069nternal-model" } },
    { headers: { accept: "internal-model" } },
    { headers: { "if-none-match": "internal-model" } },
    { headers: { "x-github-api-version": "%69nternal-model" } },
  ])("denies before classification, probes, upstream, cache, or audit %#", async (fields) => {
    await seedPool();
    await put(synthetic);
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
    const logs = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", upstream);
    const response = await callWorker("/v1/github/request", {
      method: "POST",
      headers: { authorization: `Bearer ${CALLER_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        pool: POOL,
        method: "GET",
        path: "/repos/openclaw/octopool",
        ...fields,
      }),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain('"code":"string_rewrite_denied"');
    expect(body).not.toContain("internal-model");
    expect(body).not.toContain("fallback_local");
    expect(upstream).not.toHaveBeenCalled();
    expect(logs).not.toHaveBeenCalled();
    await expectNoPublication();
  });

  it("checks JSON-escaped input and redacts validation errors before the guard", async () => {
    await seedPool();
    await put(synthetic);
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const request = {
      pool: POOL,
      method: "GET",
      path: "/repos/openclaw/octopool",
      query: { q: "internal-model" },
    };
    const escaped = await callWorker("/v1/github/request", {
      method: "POST",
      headers: { authorization: `Bearer ${CALLER_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(request).replace("internal-model", "\\u0069nternal-model"),
    });
    expect(escaped.status).toBe(403);
    for (const query of [{ "internal-model-token": "safe" }, { "internal-model": 42 }]) {
      const response = await callWorker("/v1/github/request", {
        method: "POST",
        headers: { authorization: `Bearer ${CALLER_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ...request, query }),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("internal-model");
    }
    expect(upstream).not.toHaveBeenCalled();
    await expectNoPublication();
  });

  it("rejects duplicate envelopes and invalid UTF-8 before normalization", async () => {
    await seedPool();
    const prefix = '{"pool":"maintainers","method":"GET","path":"/user"';
    for (const body of [
      prefix + ',"path":"/rate_limit"}',
      new Uint8Array([
        ...new TextEncoder().encode(prefix + ',"query":{"q":"'),
        0xff,
        ...new TextEncoder().encode('"}}'),
      ]),
    ]) {
      const response = await callWorker("/v1/github/request", {
        method: "POST",
        headers: { authorization: `Bearer ${CALLER_TOKEN}`, "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_json" } });
    }
    await expectNoPublication();
  });

  it("sees updates immediately in a warm isolate and blocks an already cached route", async () => {
    await seedPool();
    const upstream = githubUpstream({ primary: jsonResponse({ number: 17 }) });
    vi.stubGlobal("fetch", upstream);
    const warm = async (path: string, init?: RequestInit): Promise<Response> => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`https://octopool.dev${path}`, init),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    };
    const request = {
      method: "POST",
      headers: { authorization: `Bearer ${CALLER_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        pool: POOL,
        method: "GET",
        path: "/repos/openclaw/internal-model/pulls/17",
      }),
    };
    expect((await warm("/v1/github/request", request)).status).toBe(200);
    const before = await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM github_cache_entries").first(),
    ).toEqual({ count: 1 });
    const update = await warm(adminPath, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ schema_version: 1, expected_revision: 1, rules: synthetic }),
    });
    expect(update.status).toBe(200);
    const downloaded = await warm(callerPath, {
      headers: { authorization: `Bearer ${CALLER_TOKEN}` },
    });
    expect(await downloaded.json()).toMatchObject({ revision: 2, rules: synthetic });
    upstream.mockClear();
    expect((await warm("/v1/github/request", request)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first()).toEqual(
      before,
    );
    await env.DB.prepare("DELETE FROM string_rewrite_policy").run();
    expect((await warm("/v1/github/request", request)).status).toBe(503);
    expect(
      (await warm(callerPath, { headers: { authorization: `Bearer ${CALLER_TOKEN}` } })).status,
    ).toBe(503);
  });

  it.each([
    "DELETE FROM string_rewrite_policy",
    "DROP TABLE string_rewrite_policy",
    "UPDATE string_rewrite_policy SET rules_json = 'broken internal-model'",
    'UPDATE string_rewrite_policy SET rules_json = \'[{"pattern":"internal-model(?=x)","replacement":""}]\'',
    'UPDATE string_rewrite_policy SET rules_json = \'[{"pattern":"a","replacement":"","replacement":"X"}]\'',
    "UPDATE string_rewrite_policy SET rules_json = 'null'",
    "UPDATE string_rewrite_policy SET updated_at = 'internal-model'",
  ])("fails closed on missing/corrupt policy %#", async (sql) => {
    await seedPool();
    await env.DB.prepare(sql).run();
    const upstream = vi.fn<typeof fetch>();
    const logs = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", upstream);
    for (const response of [
      await relay("/repos/openclaw/octopool"),
      await callWorker(adminPath, { headers: adminHeaders }),
      await callWorker(callerPath, { headers: { authorization: `Bearer ${CALLER_TOKEN}` } }),
      await put([]),
    ]) {
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        error: {
          code: "string_rewrite_policy_unavailable",
          message: "String protection policy unavailable",
        },
      });
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(logs).not.toHaveBeenCalled();
    await expectNoPublication();
  });

  it("never translates a policy D1 overload into local fallback", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    vi.spyOn(env.DB, "withSession").mockImplementation(() => {
      throw new Error("D1 DB is overloaded. Requests queued for too long. internal-model");
    });
    const response = await relay("/repos/openclaw/octopool");
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("string_rewrite_policy_unavailable");
    expect(text).not.toContain("fallback_local");
    expect(text).not.toContain("internal-model");
    expect(upstream).not.toHaveBeenCalled();
    await expectNoPublication();
  });
});
