import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { GITHUB_EDGE_CACHE_NAMESPACE } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { PUBLIC_PROOF_EDGE_NAMESPACE } from "../../src/public-repos";
import { queries } from "../../src/generated/sql";
import { exactWorkflowRun } from "../fixtures/exact-workflow-run";
import { bearer, jsonResponse, relay, seedPool } from "./harness";
import { requestWithEnv } from "./identity-routing-support";
import { observePublicationD1 } from "./publication-d1-observer";

const repo = "/repos/openclaw/jobs-equivalence";
const runPath = `${repo}/actions/runs/42`;
const plain = `${runPath}/jobs`;
const pinned = `${runPath}/attempts/2/jobs`;
const run = exactWorkflowRun(42, "openclaw/jobs-equivalence");
const jobs = Array.from({ length: 102 }, (_, id) => ({
  id: id + 1,
  run_id: 42,
  run_attempt: 2,
  status: "in_progress",
  name: `Job ${id + 1}`,
}));
type Envelope = {
  body: { total_count: number; jobs: unknown[] };
  headers: Record<string, string>;
  identity?: { id: string; kind: string };
  relay: { cache: string; cache_expires_at: string; stale_reason?: string };
};

async function setup(
  options: { pooledPath?: string | undefined; completed?: boolean; empty?: boolean } = {},
) {
  await seedPool();
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.toLowerCase() === repo) return jsonResponse({ private: false });
    if (url.hostname !== "api.github.com") return jsonResponse({}, 404);
    if (options.pooledPath === url.pathname && bearer(request) !== "test-primary-token")
      return jsonResponse({}, 503);
    const result = { ...run, ...(options.completed ? { status: "completed" } : {}) };
    if (url.pathname.endsWith("/runs"))
      return jsonResponse({ total_count: 1, workflow_runs: [result] });
    if (!url.pathname.endsWith("/jobs")) return jsonResponse(result);
    const page = Number(url.searchParams.get("page") ?? 1);
    const size = Number(url.searchParams.get("per_page") ?? 30);
    const all = options.empty
      ? []
      : options.completed
        ? jobs.map((job) => ({ ...job, status: "completed" }))
        : jobs;
    const links: string[] = [];
    for (const [rel, target] of [
      ["prev", page - 1],
      ["next", page + 1],
    ] as const) {
      if (target < 1 || target > Math.ceil(all.length / size)) continue;
      const link = new URL(url);
      link.searchParams.set("page", String(target));
      link.searchParams.set("per_page", String(size));
      links.push(`<${link}>; rel="${rel}"`);
    }
    return jsonResponse(
      {
        total_count: all.length,
        jobs: all.slice((page - 1) * size, page * size),
        extra: "preserved",
      },
      200,
      {
        etag: '"source-jobs"',
        "last-modified": "Sun, 20 Sep 2026 00:00:00 GMT",
        ...(links.length ? { link: links.join(", ") } : {}),
      },
    );
  });
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

async function rows() {
  return (await env.DB.prepare("SELECT * FROM github_cache_entries ORDER BY cache_key").all())
    .results;
}
async function evictEdges() {
  const entries = await env.DB.prepare("SELECT cache_key FROM github_cache_entries").all<{
    cache_key: string;
  }>();
  for (const row of entries.results)
    await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, row.cache_key);
}
async function audit() {
  return env.DB.prepare(
    "SELECT cache_status, fallback_reason, cache_miss_reason, identity_id FROM audit_events ORDER BY rowid DESC LIMIT 1",
  ).first();
}

const directions = [
  { source: plain, target: pinned },
  { source: pinned, target: plain },
];

describe("raw run jobs latest-attempt equivalence", () => {
  it.each(directions)(
    "accepts canonical repository casing in the $source proof and links",
    async ({ source, target }) => {
      const upstream = await setup();
      const mixedRepo = "/repos/OpenClaw/Jobs-Equivalence";
      await relay(runPath.replace(repo, mixedRepo));
      await relay(source.replace(repo, mixedRepo));
      await evictEdges();
      await env.DB.prepare(
        "UPDATE github_cache_entries SET response_headers_json = ? WHERE path = ?",
      )
        .bind(
          JSON.stringify({
            link: `<https://api.github.com${source}?page=2&per_page=30>; rel="next"`,
          }),
          source.replace(repo, mixedRepo),
        )
        .run();
      upstream.mockClear();
      const response = await (await relay(target.replace(repo, mixedRepo))).json<Envelope>();
      expect(response.relay.cache).toBe("hit");
      expect(response.headers.link).toContain(
        `https://api.github.com${target.replace(repo, mixedRepo)}?`,
      );
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it.each(
    directions.flatMap((direction) =>
      [1, 99].map((repositoryId) => ({ ...direction, repositoryId })),
    ),
  )(
    "maps numeric repository links only with proof: $source, repository=$repositoryId",
    async ({ source, target, repositoryId }) => {
      const upstream = await setup();
      await relay(runPath);
      await relay(source);
      await evictEdges();
      await env.DB.prepare(
        "UPDATE github_cache_entries SET response_headers_json = ? WHERE path = ?",
      )
        .bind(
          JSON.stringify({
            link: `<https://api.github.com${source.replace(repo, `/repositories/${repositoryId}`)}?page=2&per_page=30>; rel="next"`,
          }),
          source,
        )
        .run();
      upstream.mockClear();
      const response = await (await relay(target)).json<Envelope>();
      expect(response.relay.cache).toBe(repositoryId === 1 ? "hit" : "miss");
      expect(response.headers.link).toContain(`https://api.github.com${target}?`);
      expect(upstream).toHaveBeenCalledTimes(repositoryId === 1 ? 0 : 1);
    },
  );

  it.each(directions)("keeps filter=all exact for $source", async ({ source, target }) => {
    const upstream = await setup();
    await relay(runPath);
    await relay(source, undefined, { query: { filter: "all" } });
    upstream.mockClear();
    expect(
      await (await relay(source, undefined, { query: { filter: "all" } })).json(),
    ).toMatchObject({ relay: { cache: "hit" } });
    expect(upstream).not.toHaveBeenCalled();
    expect(await audit()).toMatchObject({ fallback_reason: null });
    expect(await (await relay(target)).json()).toMatchObject({ relay: { cache: "miss" } });
    expect(
      await (await relay(target, undefined, { query: { filter: "all" } })).json(),
    ).toMatchObject({ relay: { cache: "miss" } });
  });

  it("accepts a positive maximum age covering both entries", async () => {
    const upstream = await setup();
    await relay(runPath);
    await relay(plain);
    upstream.mockClear();
    expect(
      await (await relay(pinned, undefined, { headers: { "cache-control": "max-age=30" } })).json(),
    ).toMatchObject({ relay: { cache: "hit" } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["older", "same-second"])(
    "rejects an empty plain page with %s proof ordering",
    async (ordering) => {
      const upstream = await setup({ empty: true });
      await relay(runPath);
      await relay(plain);
      await evictEdges();
      await env.DB.prepare(
        "UPDATE github_cache_entries SET created_at = datetime((SELECT created_at FROM github_cache_entries WHERE path = ?), ?) WHERE path = ?",
      )
        .bind(runPath, ordering === "older" ? "-30 seconds" : "+0 seconds", plain)
        .run();
      upstream.mockClear();
      expect(await (await relay(pinned)).json()).toMatchObject({ relay: { cache: "miss" } });
      expect(upstream).toHaveBeenCalledOnce();
    },
  );

  it.each(["proof", "jobs"])("falls through if the optional %s lookup fails", async (which) => {
    const upstream = await setup();
    await relay(runPath);
    await relay(plain);
    await evictEdges();
    const key = await env.DB.prepare("SELECT cache_key FROM github_cache_entries WHERE path = ?")
      .bind(which === "proof" ? runPath : plain)
      .first("cache_key");
    const db = observePublicationD1(env.DB, {
      before: async (sql, values) => {
        if (sql === queries.readGitHubCache && values[0] === key)
          throw new Error("synthetic optional lookup failure");
      },
    });
    upstream.mockClear();
    expect(await (await requestWithEnv({ DB: db }, pinned, {})).json()).toMatchObject({
      relay: { cache: "miss" },
    });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("rechecks latest-attempt proof expiry after a delayed source lookup", async () => {
    await setup();
    await relay(runPath);
    await relay(plain);
    await evictEdges();
    await env.DB.prepare(
      "UPDATE github_cache_entries SET expires_at = datetime('now', '+2 seconds') WHERE path = ?",
    )
      .bind(runPath)
      .run();
    const key = await env.DB.prepare("SELECT cache_key FROM github_cache_entries WHERE path = ?")
      .bind(plain)
      .first("cache_key");
    const db = observePublicationD1(env.DB, {
      before: async (sql, values) => {
        if (sql === queries.readGitHubCache && values[0] === key)
          await new Promise((resolve) => setTimeout(resolve, 2100));
      },
    });
    expect(await (await requestWithEnv({ DB: db }, pinned, {})).json()).toMatchObject({
      relay: { cache: "miss" },
    });
  });

  it.each(
    directions.flatMap((direction) =>
      [1, 2].flatMap((page) => [false, true].map((pooled) => ({ ...direction, page, pooled }))),
    ),
  )("reuses $source page $page, pooled=$pooled", async ({ source, target, page, pooled }) => {
    const upstream = await setup({ pooledPath: pooled ? source : undefined });
    const query = { page: String(page), per_page: "100" };
    await relay(runPath);
    const original = await (await relay(source, undefined, { query })).json<Envelope>();
    if (pooled) await evictEdges();
    const before = await rows();
    upstream.mockClear();
    const response = await (await relay(target, undefined, { query })).json<Envelope>();
    expect(response.body).toEqual(original.body);
    expect(response.relay).toMatchObject({
      cache: "hit",
      cache_expires_at: before.find((row) => row.path === source)!.expires_at,
    });
    expect(response.identity).toEqual(pooled ? { id: "primary", kind: "pat" } : undefined);
    expect(response.headers.etag).toBeUndefined();
    expect(response.headers["last-modified"]).toBeUndefined();
    expect(response.headers.link).toContain(`https://api.github.com${target}?`);
    expect(response.headers.link).not.toContain(`https://api.github.com${source}?`);
    expect(upstream).not.toHaveBeenCalled();
    expect(await rows()).toEqual(before);
    expect(await audit()).toMatchObject({
      cache_status: "hit",
      fallback_reason: "run_jobs_superset",
      cache_miss_reason: null,
      identity_id: pooled ? "primary" : null,
    });
  });

  it.each(
    directions.flatMap((direction) =>
      [
        "default",
        "source-latest",
        "target-latest",
        "list-proof",
        "pooled-proof",
        "empty",
        "completed",
      ].map((variant) => ({ ...direction, variant })),
    ),
  )("supports $variant with source $source", async ({ source, target, variant }) => {
    const upstream = await setup({
      pooledPath: variant === "pooled-proof" ? runPath : undefined,
      empty: variant === "empty",
      completed: variant === "completed",
    });
    await relay(variant === "list-proof" ? `${repo}/actions/runs` : runPath);
    if (variant === "empty") {
      await env.DB.prepare(
        "UPDATE github_cache_entries SET created_at = datetime('now', '-2 seconds') WHERE path = ?",
      )
        .bind(runPath)
        .run();
      await evictEdges();
    }
    const original = await (
      await relay(source, undefined, {
        query: variant === "source-latest" ? { filter: "latest" } : {},
      })
    ).json<Envelope>();
    const before = await rows();
    upstream.mockClear();
    const response = await (
      await relay(target, undefined, {
        query: variant === "target-latest" ? { filter: "latest" } : {},
      })
    ).json<Envelope>();
    expect(response.relay).toMatchObject({
      cache: "hit",
      cache_expires_at: before.find((row) => row.path === source)!.expires_at,
    });
    expect(response.body).toEqual(original.body);
    expect(upstream).not.toHaveBeenCalled();
    expect(await rows()).toEqual(before);
    if (variant === "completed") {
      const ttl = await env.DB.prepare(
        "SELECT unixepoch(expires_at)-unixepoch(created_at) AS ttl FROM github_cache_entries WHERE path = ?",
      )
        .bind(source)
        .first("ttl");
      expect(ttl).toBe(source === pinned ? 3600 : 60);
    }
  });

  it.each([
    "missing-proof",
    "attempt-proof",
    "expired-proof",
    "proof-age",
    "proof-epoch",
    "proof-identity",
    "proof-scope",
    "proof-wrong-id",
    "proof-wrong-url",
    "proof-invalid-attempt",
    "old-attempt",
    "new-attempt",
    "source-all",
    "target-all",
    "mixed-attempts",
    "wrong-run",
    "incomplete",
    "invalid-count",
    "missing-next",
    "wrong-link",
    "expired-source",
    "source-age",
    "source-epoch",
    "source-identity",
    "source-scope",
    "live",
    "explicit-age-stale",
    "version",
    "media",
    "shape",
    "query",
    "conditional",
    "other-page",
    "other-size",
  ])("rejects unsafe reuse: %s", async (constraint) => {
    const pooledPath =
      constraint.startsWith("proof-") && ["proof-identity", "proof-scope"].includes(constraint)
        ? runPath
        : ["source-identity", "source-scope"].includes(constraint)
          ? plain
          : undefined;
    const upstream = await setup({ pooledPath });
    if (constraint !== "missing-proof")
      await relay(constraint === "attempt-proof" ? `${runPath}/attempts/2` : runPath);
    await relay(plain, undefined, { query: constraint === "source-all" ? { filter: "all" } : {} });
    await evictEdges();
    if (
      constraint === "expired-proof" ||
      constraint === "expired-source" ||
      constraint === "explicit-age-stale"
    )
      await env.DB.prepare(
        "UPDATE github_cache_entries SET expires_at = datetime('now', ?) WHERE path = ?",
      )
        .bind(
          constraint === "explicit-age-stale" ? "-1 second" : "-61 seconds",
          constraint === "expired-proof" ? runPath : plain,
        )
        .run();
    if (constraint === "proof-age" || constraint === "source-age")
      await env.DB.prepare(
        "UPDATE github_cache_entries SET created_at = datetime('now', '-30 seconds') WHERE path = ?",
      )
        .bind(constraint === "proof-age" ? runPath : plain)
        .run();
    if (constraint.endsWith("epoch"))
      await env.DB.prepare(
        "UPDATE github_cache_entries SET publication_epoch = 'old' WHERE path = ?",
      )
        .bind(constraint === "proof-epoch" ? runPath : plain)
        .run();
    if (constraint.endsWith("identity"))
      await env.DB.prepare("UPDATE identities SET status = 'disabled'").run();
    if (constraint.endsWith("scope")) await env.DB.prepare("DELETE FROM identity_scopes").run();
    if (["proof-wrong-id", "proof-wrong-url", "proof-invalid-attempt"].includes(constraint))
      await env.DB.prepare("UPDATE github_cache_entries SET body_json = ? WHERE path = ?")
        .bind(
          JSON.stringify({
            ...run,
            ...(constraint === "proof-wrong-id"
              ? { id: 99 }
              : constraint === "proof-wrong-url"
                ? { url: "https://api.github.com/repos/other/repo/actions/runs/42" }
                : { run_attempt: 0 }),
          }),
          runPath,
        )
        .run();
    if (["mixed-attempts", "wrong-run", "incomplete", "invalid-count"].includes(constraint))
      await env.DB.prepare("UPDATE github_cache_entries SET body_json = ? WHERE path = ?")
        .bind(
          JSON.stringify({
            total_count: constraint === "invalid-count" ? "102" : 102,
            jobs:
              constraint === "incomplete"
                ? jobs.slice(0, 2)
                : jobs.slice(0, 30).map((job) => ({
                    ...job,
                    ...(constraint === "mixed-attempts"
                      ? { run_attempt: 1 }
                      : constraint === "wrong-run"
                        ? { run_id: 99 }
                        : {}),
                  })),
          }),
          plain,
        )
        .run();
    if (constraint === "missing-next" || constraint === "wrong-link")
      await env.DB.prepare(
        "UPDATE github_cache_entries SET response_headers_json = ? WHERE path = ?",
      )
        .bind(
          JSON.stringify(
            constraint === "missing-next"
              ? {}
              : { link: '<https://api.github.com/repos/wrong/path?page=2>; rel="next"' },
          ),
          plain,
        )
        .run();
    upstream.mockClear();
    const target =
      constraint === "old-attempt"
        ? pinned.replace("/2/", "/1/")
        : constraint === "new-attempt"
          ? pinned.replace("/2/", "/3/")
          : pinned;
    const response = await relay(target, undefined, {
      query:
        constraint === "target-all"
          ? { filter: "all" }
          : constraint === "query"
            ? { unknown: "1" }
            : constraint === "other-page"
              ? { page: "2" }
              : constraint === "other-size"
                ? { per_page: "20" }
                : {},
      headers: {
        ...(constraint === "live" ? { "cache-control": "max-age=0" } : {}),
        ...(["proof-age", "source-age", "explicit-age-stale"].includes(constraint)
          ? { "cache-control": "max-age=10" }
          : {}),
        ...(constraint === "version" ? { "x-github-api-version": "2099-01-01" } : {}),
        ...(constraint === "media" ? { accept: "application/vnd.github.raw+json" } : {}),
        ...(constraint === "shape" ? { "x-octopool-public-shape": "actions-jobs-v1" } : {}),
        ...(constraint === "conditional" ? { "if-none-match": '"client"' } : {}),
      },
    });
    expect((await response.json<Envelope>()).relay.cache).toBe(
      constraint === "conditional" ? "bypass" : "miss",
    );
    expect(upstream).toHaveBeenCalled();
    expect(await audit()).toMatchObject({ fallback_reason: null });
  });

  it.each(directions)(
    "refreshes the stale $source entry after serving its timestamp unchanged",
    async ({ source, target }) => {
      const upstream = await setup();
      await relay(runPath);
      await relay(source);
      await evictEdges();
      await env.DB.prepare(
        "UPDATE github_cache_entries SET expires_at = datetime('now', '-30 seconds') WHERE path = ?",
      )
        .bind(source)
        .run();
      const expiry = await env.DB.prepare(
        "SELECT expires_at FROM github_cache_entries WHERE path = ?",
      )
        .bind(source)
        .first("expires_at");
      upstream.mockClear();
      const response = await (await relay(target)).json<Envelope>();
      expect(response.relay).toMatchObject({
        cache: "stale",
        stale_reason: "stale_while_revalidate",
        cache_expires_at: expiry,
      });
      expect(upstream).toHaveBeenCalledOnce();
      expect(new URL(new Request(...upstream.mock.calls[0]!).url).pathname).toBe(source);
      expect(await audit()).toMatchObject({
        cache_status: "stale",
        fallback_reason: "run_jobs_superset",
        cache_miss_reason: null,
      });
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS n FROM github_cache_entries WHERE path = ?")
          .bind(target)
          .first("n"),
      ).toBe(0);
      expect(await (await relay(target)).json()).toMatchObject({ relay: { cache: "hit" } });
    },
  );

  it.each(["private", "proof-failure"])("keeps the public guard for %s", async (failure) => {
    const upstream = await setup();
    await relay(runPath);
    await relay(plain);
    await env.DB.prepare("DELETE FROM github_public_repo_proofs").run();
    await deleteEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/jobs-equivalence");
    upstream.mockImplementation(async () =>
      jsonResponse({ private: true }, failure === "private" ? 200 : 503),
    );
    const response = await relay(pinned);
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: {
        details: { reason: failure === "private" ? "repo_not_public" : "repo_public_check_failed" },
      },
    });
    expect(await audit()).not.toMatchObject({ fallback_reason: "run_jobs_superset" });
  });
});
