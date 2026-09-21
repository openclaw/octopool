import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_EDGE_CACHE_NAMESPACE } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { releaseMetadataHTML } from "../fixtures/release-metadata";
import { bearer, callWorker, jsonResponse, relay, seedPool } from "./harness";

const metadata = { "x-octopool-public-shape": "release-metadata-v1" };
const exact = { "x-octopool-public-shape": "release-summary-v1" };
const repo = "/repos/openclaw/octopool";
type Envelope = { body: unknown; headers: Record<string, string>; relay: { cache: string } };

describe("release metadata HTML at the Worker boundary", () => {
  beforeEach(seedPool);

  it.each([
    { name: "stable tagged", tag: "v0.6.9", latest: false, badge: "" },
    { name: "latest redirect", tag: "v0.6.9", latest: true, badge: "Latest" },
    { name: "prerelease tagged", tag: "v0.6.9-beta", latest: false, badge: "Pre-release" },
    { name: "slash tag", tag: "release/1.0", latest: false, badge: "" },
  ])("serves and isolates proven metadata: $name", async ({ tag, latest, badge }) => {
    const suffix = latest ? "latest" : `tags/${encodeURIComponent(tag)}`;
    const path = `${repo}/releases/${suffix}`;
    const tagURL = `https://github.com/openclaw/octopool/releases/tag/${encodeURIComponent(tag)}`;
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        if (request.url === "https://api.github.com" + repo)
          return jsonResponse({ private: false });
        if (request.url === "https://github.com/openclaw/octopool/releases/latest")
          return new Response(null, { status: 302, headers: { location: tagURL } });
        if (request.url === tagURL)
          return new Response(releaseMetadataHTML(tag, badge), {
            headers: { "content-type": "text/html", etag: '"html-only"' },
          });
        return jsonResponse({ message: "anonymous quota exhausted" }, 429);
      }),
    );
    const expected = {
      tag_name: tag,
      html_url: tagURL,
      draft: false,
      prerelease: badge === "Pre-release",
      published_at: "2026-09-20T19:08:46Z",
    };
    const first = await relay(path, undefined, { headers: metadata });
    expect(first.status).toBe(200);
    const wire = await first.json<Envelope>();
    expect(wire.body).toEqual(expected);
    expect(wire.relay.cache).toBe("miss");
    expect(wire.headers).not.toHaveProperty("etag");
    const row = await env.DB.prepare(
      "SELECT cache_key, created_at, expires_at FROM github_cache_entries WHERE path = ?",
    )
      .bind(path)
      .first<{ cache_key: string; created_at: string; expires_at: string }>();
    expect(row).not.toBeNull();
    for (const layer of ["edge", "shared"]) {
      if (layer === "shared") await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, row!.cache_key);
      const hit = await (await relay(path, undefined, { headers: metadata })).json<Envelope>();
      expect(hit.body).toEqual(expected);
      expect(hit.relay.cache).toBe("hit");
    }
    expect(calls.filter((request) => request.url === tagURL)).toHaveLength(1);
    expect(calls.some((request) => request.url === "https://api.github.com" + path)).toBe(false);
    const fresh = await relay(path, undefined, {
      headers: { ...metadata, "cache-control": "max-age=0" },
    });
    expect(fresh.status).toBe(200);
    expect((await fresh.json<Envelope>()).body).toEqual(expected);
    expect(calls.filter((request) => request.url === tagURL)).toHaveLength(2);
    for (const headers of [exact, {}]) {
      const unavailable = await relay(path, undefined, { headers });
      expect(unavailable.status).toBe(424);
      expect(await unavailable.json()).toMatchObject({ error: { code: "fallback_local" } });
    }
    expect(
      calls.every(
        (request) =>
          !["test-primary-token", "test-secondary-token"].includes(bearer(request) ?? ""),
      ),
    ).toBe(true);
  });

  it.each([
    "missing timestamp",
    "truncated header",
    "wrong breadcrumb",
    "wrong redirect repository",
    "wrong redirect tag",
    "draft badge",
    "conflicting badges",
    "private marker",
    "unknown query",
    "conditional",
    "custom media",
    "numeric release ID",
    "release list",
  ])("keeps unsupported or unproven metadata on exact fallback: %s", async (scenario) => {
    const tag = "v0.6.9";
    const path =
      `${repo}/releases/${scenario === "numeric release ID" ? "123" : scenario === "release list" ? "" : "tags/" + tag}`.replace(
        /\/$/,
        "",
      );
    let html = releaseMetadataHTML(tag);
    if (scenario === "missing timestamp")
      html = html.replace('datetime="2026-09-20T19:08:46Z"', "");
    if (scenario === "truncated header") html = html.slice(0, html.indexOf("</h1>"));
    if (scenario === "wrong breadcrumb")
      html = html.replace("/releases/tag/v0.6.9", "/releases/tag/other");
    if (scenario === "draft badge") html = releaseMetadataHTML(tag, "Draft");
    if (scenario === "conflicting badges")
      html = releaseMetadataHTML(tag, "Latest").replace(
        "</h1>",
        '</h1><span class="Label Label--large">Pre-release</span>',
      );
    if (scenario === "private marker") html = html.replace('content="true"', 'content="false"');
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        if (request.url === "https://api.github.com" + repo)
          return jsonResponse({ private: false });
        if (new URL(request.url).hostname === "github.com") {
          if (scenario.startsWith("wrong redirect") && request.url.endsWith("/tag/v0.6.9"))
            return new Response(null, {
              status: 302,
              headers: {
                location:
                  scenario === "wrong redirect repository"
                    ? "https://github.com/other/repo/releases/tag/other"
                    : "https://github.com/openclaw/octopool/releases/tag/other",
              },
            });
          return new Response(html, { headers: { "content-type": "text/html" } });
        }
        return jsonResponse({ message: "anonymous unavailable" }, 429);
      }),
    );
    const response = await relay(path, undefined, {
      headers: {
        ...metadata,
        ...(scenario === "conditional" ? { "if-none-match": '"caller"' } : {}),
        ...(scenario === "custom media" ? { accept: "application/vnd.github.raw+json" } : {}),
      },
      ...(scenario === "unknown query" ? { query: { page: "2" } } : {}),
    });
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({ error: { code: "fallback_local" } });
    expect(
      calls.every(
        (request) =>
          !["test-primary-token", "test-secondary-token"].includes(bearer(request) ?? ""),
      ),
    ).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM github_cache_entries").first("n")).toBe(
      0,
    );
  });

  it("retains policy denial before HTML dispatch", async () => {
    expect(
      (
        await callWorker("/v1/admin/string-rewrites", {
          method: "PUT",
          headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" },
          body: JSON.stringify({
            schema_version: 1,
            expected_revision: 1,
            rules: [{ pattern: "releases", replacement: "public" }],
          }),
        })
      ).status,
    ).toBe(200);
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const response = await relay(`${repo}/releases/latest`, undefined, { headers: metadata });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "string_rewrite_denied" } });
    expect(upstream).not.toHaveBeenCalled();
  });
});
