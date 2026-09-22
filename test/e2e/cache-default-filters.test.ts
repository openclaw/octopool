import { describe, expect, it, vi } from "vitest";
import { bearer, jsonResponse, relay, seedPool } from "./harness";

const BASE = "/repos/openclaw/octopool";
const paths = [
  `${BASE}/actions/runs/42/jobs`,
  `${BASE}/commits/0123456789abcdef0123456789abcdef01234567/check-runs`,
  `${BASE}/commits/main/check-runs`,
];

describe("default latest-filter cache reuse", () => {
  it.each(paths.flatMap((path) => ["anonymous", "pooled"].map((source) => ({ path, source }))))(
    "shares omitted and latest filters for $source $path",
    async ({ path, source }) => {
      await seedPool();
      const filters: (string | null)[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (url.hostname !== "api.github.com") return jsonResponse({}, 404);
          if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
          if (source === "pooled" && bearer(request) !== "test-primary-token")
            return jsonResponse({}, 503);
          filters.push(url.searchParams.get("filter"));
          const all = url.searchParams.getAll("filter").includes("all");
          return jsonResponse({
            total_count: all ? 2 : 1,
            [path.endsWith("/jobs") ? "jobs" : "check_runs"]: all
              ? [{ id: 1 }, { id: 2 }]
              : [{ id: 2 }],
          });
        }),
      );
      const read = async (
        query: Record<string, string | string[]> = {},
        headers: Record<string, string> = {},
      ) => {
        const response = await relay(path, undefined, { query, headers });
        expect(response.status).toBe(200);
        return response.json<{ body: unknown }>();
      };
      // Exercise both fill directions, including identity-specific keys.
      const first = source === "anonymous" ? {} : { filter: "latest" };
      const equivalent = source === "anonymous" ? { filter: "latest" } : {};
      const warm = await read(first);
      expect(warm).toMatchObject({ body: { total_count: 1 }, relay: { cache: "miss" } });
      expect(await read(equivalent)).toMatchObject({ body: warm.body, relay: { cache: "hit" } });
      expect(filters).toHaveLength(1);

      expect(await read({ filter: "all" })).toMatchObject({
        body: { total_count: 2 },
        relay: { cache: "miss" },
      });
      expect(await read({ filter: ["latest", "all"] })).toMatchObject({
        body: { total_count: 2 },
        relay: { cache: "miss" },
      });
      expect(await read({ filter: "latest" }, { "cache-control": "max-age=0" })).toMatchObject({
        body: warm.body,
        relay: { cache: "miss" },
      });
      expect(filters).toHaveLength(4);
      expect(await read()).toMatchObject({ body: warm.body, relay: { cache: "hit" } });
      expect(filters).toHaveLength(4);
    },
  );
});
