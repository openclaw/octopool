import { describe, expect, it, vi } from "vitest";
import { githubCacheKey } from "../src/cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import { opaqueCacheKeys, unchangedJSONKeys } from "./fixtures/opaque-cache-keys";

describe("opaque cache codec generation", () => {
  it.each(opaqueCacheKeys)("retires old $name shared and identity keys", async (fixture) => {
    const request = validateRelayRequest(fixture.request);
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    expect(await githubCacheKey(request.pool, request, route)).not.toBe(fixture.shared);
    expect(
      await githubCacheKey(request.pool, request, route, { kind: "pat", id: "primary" }),
    ).not.toBe(fixture.identity);
    const upper = {
      ...request,
      headers: { ...request.headers, accept: request.headers!.accept!.toUpperCase() },
    };
    expect(await githubCacheKey(request.pool, upper, route)).toBe(
      await githubCacheKey(request.pool, request, route),
    );
  });

  it.each(unchangedJSONKeys)(
    "keeps $name and normalized default JSON keys warm",
    async (fixture) => {
      for (const accept of [
        undefined,
        "application/json",
        "application/vnd.github+json",
        "APPLICATION/VND.GITHUB.V3+JSON",
      ]) {
        const request = validateRelayRequest({
          ...fixture.request,
          headers: { ...fixture.request.headers, ...(accept === undefined ? {} : { accept }) },
        });
        const route = classifyRoute(request, defaultPolicy("openclaw"));
        expect(await githubCacheKey(request.pool, request, route)).toBe(fixture.shared);
        expect(
          await githubCacheKey(request.pool, request, route, { kind: "pat", id: "primary" }),
        ).toBe(fixture.identity);
      }
    },
  );

  it.each([
    [8, "actions-summary-metadata-v3"],
    [9, "release-summary-raw-v2"],
    [10, "issue-events-public-v2"],
  ] as const)(
    "composes codec with %s / %s instead of replacing representation",
    async (index, representation) => {
      const request = validateRelayRequest(opaqueCacheKeys[index].request);
      const digest = vi.spyOn(crypto.subtle, "digest");
      try {
        await githubCacheKey(
          request.pool,
          request,
          classifyRoute(request, defaultPolicy("openclaw")),
        );
        const material = JSON.parse(
          new TextDecoder().decode(digest.mock.calls[0]![1] as Uint8Array),
        );
        expect(material).toMatchObject({
          protocol_epoch: "publication-v1",
          representation,
          body_codec: "lossless-v1",
        });
      } finally {
        digest.mockRestore();
      }
    },
  );
});
