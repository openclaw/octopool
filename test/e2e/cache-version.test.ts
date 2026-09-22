import { describe, expect, it, vi } from "vitest";
import { bearer, jsonResponse, relay, seedPool } from "./harness";

const PATH = "/repos/openclaw/version-fixture";

describe("effective GitHub API version cache identity", () => {
  it.each(["anonymous", "pooled"])(
    "reuses the default version through %s reads",
    async (source) => {
      await seedPool();
      const versions: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          if (new URL(request.url).hostname !== "api.github.com") return jsonResponse({}, 404);
          if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
          if (source === "pooled" && bearer(request) !== "test-primary-token")
            return jsonResponse({}, 503);
          const version = request.headers.get("x-github-api-version")!;
          versions.push(version);
          return jsonResponse({ private: false, description: version });
        }),
      );
      const defaults = { "x-github-api-version": "2022-11-28" };
      const read = async (headers: Record<string, string> = {}) => {
        const response = await relay(PATH, undefined, { headers });
        expect(response.status).toBe(200);
        return response.json();
      };
      expect(await read()).toMatchObject({
        body: { description: "2022-11-28" },
        relay: { cache: "miss" },
      });
      expect(await read(defaults)).toMatchObject({
        body: { description: "2022-11-28" },
        relay: { cache: "hit" },
      });
      expect(versions).toEqual(["2022-11-28"]);
      expect(await read({ ...defaults, "cache-control": "max-age=0" })).toMatchObject({
        relay: { cache: "miss" },
      });
      expect(await read()).toMatchObject({ relay: { cache: "hit" } });
      expect(versions).toEqual(["2022-11-28", "2022-11-28"]);
      expect(await read({ "x-github-api-version": "2099-01-01" })).toMatchObject({
        body: { description: "2099-01-01" },
        relay: { cache: "miss" },
      });
      expect(versions).toEqual(["2022-11-28", "2022-11-28", "2099-01-01"]);
    },
  );
});
