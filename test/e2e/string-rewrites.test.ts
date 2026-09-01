import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  CALLER_TOKEN,
  callWorker,
  callWarmWorker,
  githubUpstream,
  jsonResponse,
  POOL,
  relay,
  seedPool,
} from "./harness";
import { ownedWork } from "./owned-work";

const adminPath = "/v1/admin/string-rewrites";
const callerPath = `/v1/pools/${POOL}/string-rewrites`;
const synthetic = [{ pattern: "internal-model", replacement: "gpt-5.6-sol" }];
const adminHeaders = {
  authorization: "Bearer test-admin-token",
  "content-type": "application/json",
};

describe("canonical relay egress protection", () => {
  it("authenticates before revealing any policy-dependent denial", async () => {
    await seedPool();
    await put([{ pattern: "cobalt-mint", replacement: "public" }]);
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    for (const path of ["/repos/example/demo", "/repos/example/cobalt-mint"]) {
      expect((await relay(path, "invalid-caller-token")).status).toBe(401);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each(["\t", "\n", "\r", ""])("blocks path controls and direct matches %#", async (control) => {
    await seedPool();
    await put([{ pattern: "cobalt-mint", replacement: "public" }]);
    const upstream = vi.fn<typeof fetch>(async () => jsonResponse({}, 404));
    vi.stubGlobal("fetch", upstream);
    const response = await relay(`/repos/example/demo/commits/cobalt-${control}mint`);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("cobalt");
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ["/repos/Cobalt-Mint/demo", { headers: { "if-none-match": '"audit"' } }],
    ["/repos/example/Cobalt-Mint", { headers: { "if-none-match": '"audit"' } }],
    ["/repos/Cobalt-Mint/demo/pulls/17/files", { route_hint: { pr_state: "closed" } }],
  ] as const)("blocks derived proof paths %s", async (path, options) => {
    await seedPool();
    await put([{ pattern: "cobalt-mint", replacement: "public" }]);
    const upstream = vi.fn<typeof fetch>(async () => jsonResponse({}, 404));
    vi.stubGlobal("fetch", upstream);
    const response = await relay(path, CALLER_TOKEN, options);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("cobalt");
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["cobalt-%09mint", "safe"])(
    "preserves literal encoded and safe paths %s",
    async (ref) => {
      await seedPool();
      await put([{ pattern: "cobalt-mint", replacement: "public" }]);
      const upstream = vi.fn<typeof fetch>(async () =>
        jsonResponse({ sha: "abc", private: false }),
      );
      vi.stubGlobal("fetch", upstream);
      expect((await relay(`/repos/example/demo/commits/${ref}`)).status).toBe(200);
      expect(upstream).toHaveBeenCalled();
      expect(new Request(upstream.mock.calls[0]![0], upstream.mock.calls[0]![1]).url).toContain(
        ref,
      );
    },
  );

  it.each([
    [
      "/repos/example/demo/pulls/17",
      "^/repos/example/demo$",
      { headers: { "if-none-match": '"audit"' } },
    ],
    [
      "/repos/example/demo/pulls/17/files",
      "^/repos/example/demo/pulls/17$",
      { route_hint: { pr_state: "closed" } },
    ],
    ["/repos/example/demo/actions/jobs/19/logs", "^/repos/example/demo/actions/jobs/19$", {}],
    [
      "/repos/example/demo/pulls/17",
      "^/example/demo/pull/17.diff$",
      { headers: { accept: "application/vnd.github.v3.diff" } },
    ],
    [
      "/repos/example/demo/contents/README.md",
      "^/example/demo/main/README.md$",
      { query: { ref: "main" } },
    ],
    ["/repos/example/demo/git/ref/heads/main", "^/example/demo.git/info/refs$", {}],
  ] as const)("checks every derived transport before fetch %#", async (path, pattern, options) => {
    await seedPool();
    await put([{ pattern, replacement: "public" }]);
    const upstream = vi.fn<typeof fetch>(async () => jsonResponse({}, 404));
    vi.stubGlobal("fetch", upstream);
    const response = await relay(path, CALLER_TOKEN, options);
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    await expectNoPublication();
  });

  it("guards the membership refresh without changing credential ownership", async () => {
    await seedPool();
    await env.DB.prepare(
      "UPDATE callers SET org_identity_verified_at = '2000-01-01', github_login = 'cobalt-mint'",
    ).run();
    await put([{ pattern: "cobalt-mint", replacement: "public" }]);
    const upstream = vi.fn<typeof fetch>(async () => jsonResponse({}, 404));
    vi.stubGlobal("fetch", upstream);
    expect((await relay("/repos/example/demo")).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    await expectNoPublication();
  });

  it("propagates a denial from a nested Git repository page probe", async () => {
    await seedPool();
    await put([{ pattern: "^/example/demo/issues$", replacement: "public" }]);
    const packet = (value: string) => (value.length + 4).toString(16).padStart(4, "0") + value;
    const sha = "a".repeat(40);
    const advertisement =
      packet("# service=git-upload-pack\n") +
      "0000" +
      packet(`${sha} HEAD\0symref=HEAD:refs/heads/main\n`) +
      packet(`${sha} refs/heads/main\n`) +
      "0000";
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response(advertisement, {
          headers: { "content-type": "application/x-git-upload-pack-advertisement" },
        }),
    );
    vi.stubGlobal("fetch", upstream);
    expect((await relay("/repos/example/demo/git/ref/heads/main")).status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
    await expectNoPublication();
  });

  it("guards pooled log redirects without forwarding authorization", async () => {
    await seedPool();
    await env.DB.prepare("UPDATE identity_scopes SET owner = 'example'").run();
    await env.DB.prepare("UPDATE pools SET policy_json = ?")
      .bind(
        JSON.stringify({
          allowed_owners: ["example"],
          allow_public_repos: true,
          allow_search: true,
          allow_logs: true,
        }),
      )
      .run();
    await put([{ pattern: "cobalt-mint", replacement: "public" }]);
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.headers.get("authorization") === "Bearer test-org-token")
        return jsonResponse({ private: false });
      if (request.headers.get("authorization") === "Bearer test-primary-token") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://logs.actions.githubusercontent.com/cobalt-mint" },
        });
      }
      if (url.pathname.endsWith("/actions/jobs/19"))
        return jsonResponse({ id: 19, status: "in_progress" });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", upstream);
    const response = await relay("/repos/example/demo/actions/jobs/19/logs");
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(403);
    const requests = upstream.mock.calls.map(([input, init]) => new Request(input, init));
    expect(
      requests.some(
        (request) => request.headers.get("authorization") === "Bearer test-primary-token",
      ),
    ).toBe(true);
    expect(requests.every((request) => new URL(request.url).hostname === "api.github.com")).toBe(
      true,
    );
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first()).toEqual({
      count: 0,
    });
  });

  it.each([
    "https://github.com/example/cobalt-mint",
    "https://raw.githubusercontent.com/example/demo/main/cobalt-mint",
  ])("checks allowed-host redirects %s", async (location) => {
    await seedPool();
    await put([{ pattern: "cobalt-mint", replacement: "public" }]);
    const upstream = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 302, headers: { location } }),
    );
    vi.stubGlobal("fetch", upstream);
    const response = await relay("/repos/example/demo/pulls/17", CALLER_TOKEN, {
      headers: { accept: "application/vnd.github.v3.diff" },
    });
    expect(response.status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
    await expectNoPublication();
  });

  it("keeps concurrent policy snapshots isolated across a redirect", async () => {
    await seedPool();
    await put([{ pattern: "cobalt-mint", replacement: "public" }]);
    let started!: () => void;
    const { promise: waiting, release } = ownedWork.gate();
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const url = new Request(input, init).url;
      if (url.endsWith("/pull/17.diff")) {
        started();
        await waiting;
        return new Response(null, {
          status: 302,
          headers: { location: "https://github.com/example/cobalt-mint" },
        });
      }
      return jsonResponse({ private: false });
    });
    vi.stubGlobal("fetch", upstream);
    const first = relay("/repos/example/demo/pulls/17", CALLER_TOKEN, {
      headers: { accept: "application/vnd.github.v3.diff" },
    });
    try {
      await reached;
      expect((await put([{ pattern: "azure-sage", replacement: "public" }], 2)).status).toBe(200);
      expect((await relay("/repos/example/cobalt-mint")).status).toBe(200);
    } finally {
      release();
      await Promise.allSettled([first]);
    }
    expect((await first).status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("preserves empty-policy casing but rejects literal parser controls", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>(async () => jsonResponse({ private: false }));
    vi.stubGlobal("fetch", upstream);
    expect((await relay("/repos/Cobalt-Mint/demo")).status).toBe(200);
    upstream.mockClear();
    expect((await relay("/repos/example/demo/commits/cobalt-\tmint")).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});

async function put(rules: unknown, expectedRevision = 1): Promise<Response> {
  return callWorker(adminPath, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ schema_version: 1, expected_revision: expectedRevision, rules }),
  });
}

async function expectNoPublication(): Promise<void> {
  for (const table of ["audit_events", "github_cache_entries", "github_public_repo_proofs"]) {
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
    const warm = callWarmWorker;
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
