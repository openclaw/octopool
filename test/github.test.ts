import { afterEach, describe, expect, it, vi } from "vitest";
import { callPublicGitHub } from "../src/github";
import { withGitHubEgress, type GitHubEgressEnv } from "../src/github-egress";
import { responseCapBytes } from "../src/github-limits";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import { envelopeBytes, opaqueBytes } from "./fixtures/opaque-bytes";

describe("github api provider", () => {
  const policy = defaultPolicy("openclaw");

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(opaqueBytes)("round-trips API $name without changing bytes", async (fixture) => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array(fixture.bytes), {
          headers: { "content-type": "text/plain", etag: '"bytes"' },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await callPublicGitHub(env(), request, classifyRoute(request, policy));
    expect(envelopeBytes(response)).toEqual(fixture.bytes);
    expect(response).toMatchObject({
      status: 200,
      body_encoding: fixture.encoding,
      headers: { "content-type": "text/plain", etag: '"bytes"' },
    });
    if (fixture.bytes.length === 0) expect(response.body).toBeNull();
  });

  it.each([
    [' {"a":1} \r\n', { a: 1 }],
    ["[1,true]", [1, true]],
    ["null", null],
    ["9007199254740993", 9007199254740992],
    ['"\\ud800"', "\ud800"],
    ["\ufeff42", 42],
  ])("retains parsed JSON semantics for %s", async (text, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(String(text), { headers: { "content-type": "application/json" } }),
      ),
    );
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
    });
    expect(await callPublicGitHub(env(), request, classifyRoute(request, policy))).toMatchObject({
      body,
      body_encoding: "json",
    });
  });

  it.each([
    { bytes: [0x7b, 0xff], encoding: "base64" },
    { bytes: [0xef, 0xbb, 0xbf, 0x7b], encoding: "base64" },
    { bytes: [0x7b, 0x61], encoding: "text" },
  ])("round-trips malformed JSON fallback $bytes", async ({ bytes, encoding }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(bytes), { headers: { "content-type": "application/json" } }),
      ),
    );
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
    });
    const response = await callPublicGitHub(env(), request, classifyRoute(request, policy));
    expect(envelopeBytes(response)).toEqual(bytes);
    expect(response.body_encoding).toBe(encoding);
  });

  it("retains successful JSON parsing after the existing nonfatal JSON decode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([0x22, 0xff, 0x22]), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
    });
    expect(await callPublicGitHub(env(), request, classifyRoute(request, policy))).toMatchObject({
      body: "�",
      body_encoding: "json",
    });
  });

  it("fetches user profiles without pooled authorization", async () => {
    const fetchMock = vi.fn(async () => Response.json({ login: "dependabot[bot]" }));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/users/dependabot%5Bbot%5D",
    });

    await callPublicGitHub(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/users/dependabot%5Bbot%5D",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
  });

  it("uses the configured cap for every route", () => {
    const runList = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
    });
    const repo = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool",
    });

    expect(classifyRoute(runList, policy).kind).toBe("run_list");
    expect(classifyRoute(repo, policy).kind).toBe("repo_view");
    expect(responseCapBytes(env())).toBe(2_097_152);
  });

  it("accepts Actions run lists below the configured cap", async () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
    });
    const body = {
      total_count: 1,
      workflow_runs: [{ id: 1, display_title: "x".repeat(1_100_000) }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );

    await expect(
      callPublicGitHub(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({
      status: 200,
      body,
    });
  });
});

function env(overrides: Partial<Env> = {}): GitHubEgressEnv {
  return withGitHubEgress(
    {
      REQUEST_TIMEOUT_MS: "15000",
      MAX_RESPONSE_BYTES: "2097152",
      ...overrides,
    } as Env,
    [],
  );
}
