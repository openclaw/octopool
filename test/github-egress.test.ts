import { afterEach, describe, expect, it, vi } from "vitest";
import { withGitHubEgress } from "../src/github-egress";

describe("request-local canonical GitHub transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["https://api.github.com/repos/example/safe/../cobalt-mint", {}],
    ["https://api.github.com/repos/example/demo?q=cobalt%2Dmint", {}],
    [
      "https://api.github.com/repos/example/demo",
      { headers: { "if-none-match": " cobalt-mint\t" } },
    ],
    [
      "https://api.github.com/graphql",
      { method: "POST", body: '{"variables":{"login":"\\u0063obalt-mint"}}' },
    ],
  ])("checks canonical values before fetch %#", async (url, init) => {
    const upstream = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", upstream);
    const context = withGitHubEgress({} as Env, [
      { pattern: "^cobalt-mint$", replacement: "public" },
    ]);
    await expect(context.githubEgress.fetch(url, init)).rejects.toMatchObject({
      code: "string_rewrite_denied",
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("checks the whole final URL after hostname canonicalization", async () => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const context = withGitHubEgress({} as Env, [
      { pattern: "^https://api.github.com/", replacement: "public" },
    ]);
    await expect(
      context.githubEgress.fetch("https://API.GITHUB.COM/repos/example/demo"),
    ).rejects.toMatchObject({ code: "string_rewrite_denied" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not echo rejected transport values", async () => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const context = withGitHubEgress({} as Env, [{ pattern: "unrelated", replacement: "public" }]);
    await expect(
      context.githubEgress.fetch("https://cobalt-mint@api.github.com/repos/example/demo"),
    ).rejects.toMatchObject({
      code: "string_rewrite_denied",
      message: "Request blocked by string protection",
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("captures immutable rules without mutating bindings and forces manual redirects", async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", upstream);
    const bindings = {} as Env;
    const rules = [{ pattern: "cobalt-mint", replacement: "public" }];
    const first = withGitHubEgress(bindings, rules);
    rules[0]!.pattern = "azure-sage";
    const second = withGitHubEgress(bindings, rules);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.githubEgress)).toBe(true);
    expect(bindings).not.toHaveProperty("githubEgress");
    await expect(
      first.githubEgress.fetch("https://api.github.com/repos/example/cobalt-mint"),
    ).rejects.toMatchObject({ code: "string_rewrite_denied" });
    await second.githubEgress.fetch("https://api.github.com/repos/example/cobalt-mint", {
      redirect: "follow",
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0]![1]?.redirect).toBe("manual");
  });
});
