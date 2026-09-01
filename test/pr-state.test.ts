import { afterEach, describe, expect, it, vi } from "vitest";
import { withGitHubEgress, type GitHubEgressEnv } from "../src/github-egress";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import { verifyPRStateHint, verifyPRStateHintLive } from "../src/pr-state";
import {
  matchingPRMetadata,
  oversizedPRMetadata,
  oversizedPRStream,
  PR_HEAD,
  PR_METADATA_CAP,
  prMetadataStream,
} from "./fixtures/pr-state-metadata";

describe("PR state hint verification", () => {
  const policy = defaultPolicy("openclaw");

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a matching PR head discriminator", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          state: "open",
          merged_at: null,
          head: { sha: "0123456789abcdef0123456789abcdef01234567" },
        }),
      ),
    );
    const request = requestWithHint({ pr_head_sha: "0123456789abcdef0123456789abcdef01234567" });
    const database = databaseWithFreshProof(null);
    const route = await verifyPRStateHint(env(database), request, classifyRoute(request, policy));

    expect(route.state_hint).toBe("pr-head:0123456789abcdef0123456789abcdef01234567");
    expect(route.state_hint_source).toBe("live");
    expect(database.run).toHaveBeenCalledOnce();
  });

  it("reuses a fresh proof without touching GitHub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = requestWithHint({ pr_head_sha: "0123456789abcdef0123456789abcdef01234567" });
    const route = await verifyPRStateHint(
      env(databaseWithFreshProof({ "1": 1 })),
      request,
      classifyRoute(request, policy),
    );

    expect(route.state_hint).toBe("pr-head:0123456789abcdef0123456789abcdef01234567");
    expect(route.state_hint_source).toBe("cached");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops a stale or forged PR head discriminator", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          state: "open",
          merged_at: null,
          head: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        }),
      ),
    );
    const request = requestWithHint({ pr_head_sha: "0123456789abcdef0123456789abcdef01234567" });
    const route = await verifyPRStateHint(
      env(databaseWithFreshProof(null)),
      request,
      classifyRoute(request, policy),
    );

    expect(route.state_hint).toBeUndefined();
  });

  it("drops the discriminator when verification fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const request = requestWithHint({ pr_head_sha: "0123456789abcdef0123456789abcdef01234567" });
    const route = await verifyPRStateHint(
      env(databaseWithFreshProof(null)),
      request,
      classifyRoute(request, policy),
    );

    expect(route.state_hint).toBeUndefined();
  });

  it("drops the discriminator when proof lookup fails", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const first = vi.fn(async () => {
      throw new Error("table missing");
    });
    const bind = vi.fn(() => ({ first, run: vi.fn() }));
    const database = { prepare: vi.fn(() => ({ bind })) };
    const request = requestWithHint({ pr_head_sha: "0123456789abcdef0123456789abcdef01234567" });
    const route = await verifyPRStateHint(
      env(database as unknown as TestDB),
      request,
      classifyRoute(request, policy),
    );

    expect(route.state_hint).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a matching merged discriminator", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          state: "closed",
          merged_at: "2026-05-29T00:00:00Z",
          head: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        }),
      ),
    );
    const request = requestWithHint({ pr_state: "merged" });
    const route = await verifyPRStateHint(
      env(databaseWithFreshProof(null)),
      request,
      classifyRoute(request, policy),
    );

    expect(route.state_hint).toBe("pr-state:merged");
    expect(route.state_hint_source).toBe("live");
  });

  describe.each([
    { name: "ordinary", verify: verifyPRStateHint },
    { name: "forced live", verify: verifyPRStateHintLive },
  ])("bounded $name verification", ({ name, verify }) => {
    function input() {
      const request = requestWithHint({ pr_head_sha: PR_HEAD, pr_state: "merged" });
      const classified = classifyRoute(request, policy);
      const route =
        name === "ordinary"
          ? classified
          : {
              ...classified,
              state_hint: `pr-head:${PR_HEAD}`,
              state_hint_source: "cached" as const,
            };
      const database = databaseWithFreshProof(name === "ordinary" ? null : { "1": 1 });
      return { request, route, database };
    }

    it("accepts exactly cap bytes and keeps head precedence, anonymous egress and TTL", async () => {
      const body = matchingPRMetadata();
      const fixture = prMetadataStream([body.slice(0, 128), body.slice(128)]);
      const upstream = vi.fn(async () => fixture.response);
      vi.stubGlobal("fetch", upstream);
      const { request, route, database } = input();
      const result = await verify(env(database), request, route);
      expect(result).toMatchObject({ state_hint: `pr-head:${PR_HEAD}`, state_hint_source: "live" });
      expect(fixture.observations).toEqual({ pulls: 3, chunkBytes: [128, 128], cancellations: 0 });
      expect(database.run).toHaveBeenCalledOnce();
      expect(database.bind).toHaveBeenLastCalledWith(
        "openclaw",
        "openclaw",
        "42",
        `pr-head:${PR_HEAD}`,
        "+300 seconds",
      );
      expect(upstream).toHaveBeenCalledOnce();
      const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.github.com/repos/openclaw/openclaw/pulls/42");
      expect(new Headers(init.headers).get("authorization")).toBeNull();
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal?.aborted).toBe(false);
      if (name === "forced live") expect(database.first).not.toHaveBeenCalled();
    });

    it.each(oversizedPRMetadata)("rejects $name before writing a proof", async (definition) => {
      const fixture = oversizedPRStream(definition);
      const upstream = vi.fn(async () => fixture.response);
      vi.stubGlobal("fetch", upstream);
      const { request, route, database } = input();
      const result = await verify(env(database), request, route);
      expect.soft(result.state_hint).toBeUndefined();
      expect.soft(result.state_hint_source).toBeUndefined();
      expect.soft(database.run).not.toHaveBeenCalled();
      expect.soft(fixture.observations).toEqual({
        pulls: definition.pulled.length,
        chunkBytes: definition.pulled,
        cancellations: 1,
      });
      expect(fixture.stream.locked).toBe(false);
      expect(upstream).toHaveBeenCalledOnce();
    });

    it.each(["malformed JSON", "read failure", "non-2xx", "network", "head mismatch", "null JSON"])(
      "does not write or retain a trusted hint after %s",
      async (failure) => {
        const fixture = prMetadataStream([matchingPRMetadata().slice(0, 128)], { failAtPull: 2 });
        const upstream = vi.fn(async () => {
          if (failure === "network") throw new Error("network down");
          if (failure === "read failure") return fixture.response;
          if (failure === "non-2xx") return new Response("unavailable", { status: 503 });
          if (failure === "head mismatch")
            return Response.json({
              head: { sha: PR_HEAD.toUpperCase() },
              state: "closed",
              merged_at: "now",
            });
          return new Response(failure === "null JSON" ? "null" : '{"head":');
        });
        vi.stubGlobal("fetch", upstream);
        const { request, route, database } = input();
        const result = await verify(env(database), request, route);
        expect(result.state_hint).toBeUndefined();
        expect(result.state_hint_source).toBeUndefined();
        expect(database.run).not.toHaveBeenCalled();
        expect(upstream).toHaveBeenCalledOnce();
        if (failure === "read failure") {
          expect(fixture.observations).toEqual({ pulls: 2, chunkBytes: [128], cancellations: 0 });
        }
      },
    );

    it("does not return a newly trusted hint after a failed write acknowledgment", async () => {
      const upstream = vi.fn(async () => Response.json({ head: { sha: PR_HEAD } }));
      vi.stubGlobal("fetch", upstream);
      const { request, route, database } = input();
      database.run.mockRejectedValueOnce(new Error("write acknowledgment unavailable"));
      const result = await verify(env(database), request, route);
      expect(result.state_hint).toBeUndefined();
      expect(result.state_hint_source).toBeUndefined();
      expect(database.run).toHaveBeenCalledOnce();
      expect(upstream).toHaveBeenCalledOnce();
      // This controls the caller result; a rejected acknowledgment says nothing about commit.
    });

    it("preserves hard string-protection denial", async () => {
      const upstream = vi.fn();
      vi.stubGlobal("fetch", upstream);
      const { request, route, database } = input();
      const guarded = withGitHubEgress(env(database), [
        { pattern: "^https://api.github.com/", replacement: "public" },
      ]);
      await expect(verify(guarded, request, route)).rejects.toMatchObject({
        status: 403,
        code: "string_rewrite_denied",
      });
      expect(upstream).not.toHaveBeenCalled();
      expect(database.run).not.toHaveBeenCalled();
    });
  });
});

function requestWithHint(route_hint: Record<string, string>) {
  return validateRelayRequest({
    pool: "maintainers",
    method: "GET",
    path: "/repos/openclaw/openclaw/pulls/42/files",
    route_hint,
  });
}

type TestDB = {
  run: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  bind: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
};

function env(database: TestDB): GitHubEgressEnv {
  return withGitHubEgress(
    {
      REQUEST_TIMEOUT_MS: "15000",
      MAX_RESPONSE_BYTES: String(PR_METADATA_CAP),
      DB: database,
    } as unknown as Env,
    [],
  );
}

function databaseWithFreshProof(row: { "1": number } | null): TestDB {
  const first = vi.fn(async () => row);
  const run = vi.fn(async () => ({}));
  const bind = vi.fn(() => ({ first, run }));
  const prepare = vi.fn(() => ({ bind }));
  return { prepare, run, first, bind };
}
