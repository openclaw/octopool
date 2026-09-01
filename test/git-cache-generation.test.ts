import { describe, expect, it } from "vitest";
import { githubCacheKey } from "../src/cache";
import { gitRefRequest } from "../src/github-public-git";
import { withGitHubEgress } from "../src/github-egress";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import { gitCacheKeys } from "./fixtures/git-cache-keys";

describe("Git framing cache generation", () => {
  it.each(gitCacheKeys)("bounds shared and identity retirement for $name", async (fixture) => {
    const request = validateRelayRequest(fixture.request);
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    const shared = await githubCacheKey(request.pool, request, route);
    const identity = await githubCacheKey(request.pool, request, route, {
      id: "primary",
      kind: "pat",
    });
    expect.soft(shared === fixture.shared).toBe(!fixture.retire);
    expect.soft(identity === fixture.identity).toBe(!fixture.retire);
    if (fixture.retire) {
      const { headers: _headers, ...canonical } = request;
      const canonicalShared = await githubCacheKey(request.pool, canonical, route);
      const canonicalIdentity = await githubCacheKey(request.pool, canonical, route, {
        id: "primary",
        kind: "pat",
      });
      if (request.headers?.accept?.trim() === "") {
        expect(gitRefRequest(withGitHubEgress({} as Env, []), request, route)).toBeDefined();
        expect(shared).not.toBe(canonicalShared);
        expect(identity).not.toBe(canonicalIdentity);
        const otherBlank = {
          ...request,
          headers: { accept: request.headers.accept === "" ? " \t " : "" },
        };
        expect(shared).not.toBe(await githubCacheKey(request.pool, otherBlank, route));
        expect(identity).not.toBe(
          await githubCacheKey(request.pool, otherBlank, route, { id: "primary", kind: "pat" }),
        );
      }
      for (const accept of [
        "application/json",
        "application/vnd.github+json",
        "APPLICATION/VND.GITHUB.V3+JSON",
      ]) {
        const variant = { ...request, headers: { accept } };
        expect(await githubCacheKey(request.pool, variant, route)).toBe(canonicalShared);
        expect(
          await githubCacheKey(request.pool, variant, route, { id: "primary", kind: "pat" }),
        ).toBe(canonicalIdentity);
      }
    }
  });
});
