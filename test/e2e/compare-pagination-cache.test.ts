import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { GITHUB_EDGE_CACHE_NAMESPACE } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { bearer, jsonResponse, rateHeaders, relay, seedPool } from "./harness";

const REPO_PATH = "/repos/openclaw/octopool";
const COMPARE_PATH = `${REPO_PATH}/compare/base...head`;
const COMMITS = Array.from({ length: 31 }, (_, index) => ({
  sha: String(index).padStart(40, "0"),
}));
const NEXT_PAGE = `<https://api.github.com${COMPARE_PATH}?page=2&per_page=30>; rel="next"`;
const PAGINATION: Record<string, string>[] = [
  { page: "1" },
  { per_page: "30" },
  { page: "1", per_page: "30" },
];

type Envelope = {
  body: { total_commits: number; commits: { sha: string }[] };
  headers: Record<string, string>;
  relay: { cache: string };
};

describe.each(["anonymous", "identity"])("compare pagination through %s cache", (source) => {
  describe.each(["unpaged", "paged"])("%s fill first", (first) => {
    it.each(PAGINATION)("preserves the body and pagination headers for %j", async (query) => {
      await seedPool();
      let fills = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          expect(url.hostname).toBe("api.github.com");
          if (url.pathname === REPO_PATH) return jsonResponse({ private: false });
          expect(url.pathname).toBe(COMPARE_PATH);
          if (source === "identity" && bearer(request) === undefined) {
            return jsonResponse({ message: "anonymous unavailable" }, 503);
          }
          fills++;
          const paged = url.searchParams.has("page") || url.searchParams.has("per_page");
          return jsonResponse(
            { total_commits: COMMITS.length, commits: paged ? COMMITS.slice(0, 30) : COMMITS },
            200,
            { ...rateHeaders({ remaining: 4999 }), ...(paged ? { link: NEXT_PAGE } : {}) },
          );
        }),
      );

      const variants = first === "unpaged" ? [{}, query] : [query, {}];
      for (const [index, variant] of variants.entries()) {
        const result = await relay(COMPARE_PATH, undefined, { query: variant });
        expect(result.status).toBe(200);
        const envelope = await result.json<Envelope>();
        expect(envelope.relay.cache).toBe("miss");
        expectCompare(envelope, Object.keys(variant).length !== 0);
        expect(fills).toBe(index + 1);
      }

      const rows = await env.DB.prepare(
        "SELECT cache_key FROM github_cache_entries WHERE route_kind = 'compare'",
      ).all<{ cache_key: string }>();
      expect(rows.results).toHaveLength(2);
      // Confirm both representations survive D1 reloads as well as edge hits.
      for (const storage of ["edge", "shared"]) {
        if (storage === "shared") {
          await Promise.all(
            rows.results.map(({ cache_key }) =>
              deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, cache_key),
            ),
          );
        }
        for (const variant of variants) {
          const result = await relay(COMPARE_PATH, undefined, { query: variant });
          expect(result.status).toBe(200);
          const envelope = await result.json<Envelope>();
          expect(envelope.relay.cache).toBe("hit");
          expectCompare(envelope, Object.keys(variant).length !== 0);
        }
        expect(fills).toBe(2);
      }
    });
  });
});

function expectCompare(envelope: Envelope, paged: boolean): void {
  expect(envelope.body).toEqual({
    total_commits: COMMITS.length,
    commits: paged ? COMMITS.slice(0, 30) : COMMITS,
  });
  expect(envelope.headers.link).toBe(paged ? NEXT_PAGE : undefined);
}
