import { afterEach, describe, expect, it, vi } from "vitest";
import { CACHE_PUBLICATION_EPOCH } from "../src/cache-publication";
import { queries } from "../src/generated/sql";
import { withGitHubEgress } from "../src/github-egress";
import { callGitHubWeb } from "../src/github-web";
import { classifyRoute, defaultPolicy } from "../src/policy";
import { terminalLogCacheKey, terminalLogCacheProof } from "../src/terminal-log-cache";
import type { RelayRequest } from "../src/types";

vi.mock("../src/github-web", () => ({ callGitHubWeb: vi.fn() }));
vi.mock("../src/public-repos", () => ({
  observeAnonymousPublicRepo: async (_env: unknown, _route: unknown, fetch: () => unknown) => ({
    response: await fetch(),
  }),
}));

const request: RelayRequest = {
  pool: "maintainers",
  method: "GET",
  path: "/repos/openclaw/octopool/actions/jobs/42/logs",
  headers: { "cache-control": "max-age=0", "if-none-match": '"client-validator"' },
};
const policy = defaultPolicy("openclaw");

afterEach(() => vi.restoreAllMocks());

function setup(completed = false) {
  vi.mocked(callGitHubWeb).mockReset();
  const first = vi.fn().mockResolvedValue(completed ? { completed: 1 } : null);
  const bind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockReturnValue({ bind });
  const env = withGitHubEgress({ DB: { prepare } } as unknown as Env, []);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const prove = () =>
    terminalLogCacheProof(
      env,
      {} as ExecutionContext,
      request,
      classifyRoute(request, policy),
      policy,
    );
  return { first, bind, prepare, log, prove };
}

describe("terminal job completion proof", () => {
  it("tries one pool/path-scoped D1 query before spending anonymous quota", async () => {
    const { prepare, bind, log, prove } = setup(true);
    await expect(prove()).resolves.toEqual({ key: terminalLogCacheKey(request) });
    expect(prepare).toHaveBeenCalledExactlyOnceWith(queries.readCompletedJobCacheProof);
    expect(bind).toHaveBeenCalledExactlyOnceWith(
      "maintainers",
      "/repos/openclaw/octopool/actions/jobs/42",
      CACHE_PUBLICATION_EPOCH,
      "42",
    );
    expect(callGitHubWeb).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome: "cached_job_view" }));
  });

  it("retains the anonymous fallback without passing client freshness or validators", async () => {
    const { log, prove } = setup();
    vi.mocked(callGitHubWeb).mockResolvedValue({
      status: 200,
      headers: {},
      body: { id: 42, status: "completed" },
    });
    await expect(prove()).resolves.toEqual({ key: terminalLogCacheKey(request) });
    expect(callGitHubWeb).toHaveBeenCalledWith(
      expect.anything(),
      {
        pool: request.pool,
        method: "GET",
        path: "/repos/openclaw/octopool/actions/jobs/42",
        headers: { accept: "application/vnd.github+json" },
      },
      expect.objectContaining({ kind: "job_view" }),
      expect.anything(),
    );
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome: "anonymous_api" }));
  });

  it.each([
    undefined,
    { status: 503, headers: {}, body: { id: 42, status: "completed" } },
    { status: 200, headers: {}, body: { id: 42, status: "in_progress" } },
    { status: 200, headers: {}, body: { id: 43, status: "completed" } },
    { status: 200, headers: {}, body: { status: "completed" } },
  ])("leaves logs unproven without successful exact-job evidence: %j", async (response) => {
    const { log, prove } = setup();
    vi.mocked(callGitHubWeb).mockResolvedValue(response);
    await expect(prove()).resolves.toBeUndefined();
    expect(callGitHubWeb).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unproven" }));
  });

  it("still tries the anonymous source when the cache query fails", async () => {
    const { first, prove } = setup();
    first.mockRejectedValue(new Error("D1 unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(callGitHubWeb).mockResolvedValue({
      status: 200,
      headers: {},
      body: { id: 42, status: "completed" },
    });
    await expect(prove()).resolves.toEqual({ key: terminalLogCacheKey(request) });
  });
});
