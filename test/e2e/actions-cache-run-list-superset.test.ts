import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bearer, jsonResponse, relay, seedPool } from "./harness";
import { historicalHead, runCard } from "../fixtures/actions-ownership";

type RelayEnvelope = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  body_encoding: string;
  relay: { cache: string; cacheable: boolean; route_kind: string };
};

const RUNS_PATH = "/repos/openclaw/octopool/actions/runs";

describe("Actions run-list superset", () => {
  beforeEach(seedPool);

  it("owns misleading metadata through canonical fill, filtering, hits, and active TTL", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(bearer(request)).toBeUndefined();
        urls.push(request.url);
        if (new URL(request.url).hostname === "api.github.com") {
          return jsonResponse({
            total_count: 1,
            workflow_runs: [run(103, "main", "completed", "failure")],
          });
        }
        return new Response(
          `<strong>2 workflow runs</strong>${
            runCard(101, historicalHead, {
              state: "in progress",
              title: "Fix failed test: Handle pushed commits",
              workflow: "scheduled workflow dispatch",
              branch: "completed successfully pushed",
            }) + runCard(102, historicalHead, { state: "queued", title: "cancelled pull request" })
          }`.replaceAll("openclaw/Peekaboo", "openclaw/octopool"),
        );
      }),
    );
    const first = await shapedRunList({ limit: "2" });
    expect(first.body).toMatchObject({
      total_count: 2,
      workflow_runs: [
        {
          id: 101,
          status: "in_progress",
          conclusion: null,
          event: "pull_request",
          head_sha: historicalHead,
        },
        { id: 102, status: "queued", conclusion: null, event: "pull_request" },
      ],
    });
    expect(first.relay.cache).toBe("miss");
    expect(
      await env.DB.prepare(
        "SELECT unixepoch(expires_at) - unixepoch(created_at) AS ttl FROM github_cache_entries WHERE route_kind = 'run_list'",
      ).first(),
    ).toEqual({ ttl: 60 });
    const active = await shapedRunList({ status: "in_progress", limit: "1" });
    expect(runIDs(active.body)).toEqual([101]);
    expect(active.relay.cache).toBe("hit");
    const completed = await shapedRunList({ status: "completed", limit: "1" });
    expect(runIDs(completed.body)).toEqual([103]);
    expect(runIDs((await shapedRunList({ status: "completed", limit: "1" })).body)).toEqual([103]);
    expect(urls.map((url) => new URL(url).origin + new URL(url).pathname)).toEqual([
      "https://github.com/openclaw/octopool/actions",
      "https://api.github.com/repos/openclaw/octopool/actions/runs",
    ]);
    expect(Object.fromEntries(new URL(urls[1]!).searchParams)).toEqual({
      status: "completed",
      per_page: "1",
    });
    const repeated = await shapedRunList({ limit: "2" });
    expect(repeated.body).toEqual(first.body);
    expect(repeated.relay.cache).toBe("hit");
  });

  it.each([
    ["completed successfully", "success"],
    ["failed", "failure"],
    ["timed out", "timed_out"],
    ["startup failure", "startup_failure"],
  ])("keeps owned terminal %s metadata and the completed list TTL", async (state, conclusion) => {
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `<strong>1 workflow run</strong>${runCard(101, historicalHead, {
            state,
            title: "queued cancelled failed pushed",
            workflow: "pending scheduled",
            branch: "in progress",
          })}`.replaceAll("openclaw/Peekaboo", "openclaw/octopool"),
        ),
    );
    vi.stubGlobal("fetch", upstream);
    const first = await shapedRunList({ limit: "1" });
    expect(first.body).toMatchObject({
      workflow_runs: [{ id: 101, status: "completed", conclusion, event: "pull_request" }],
    });
    expect(
      await env.DB.prepare(
        "SELECT unixepoch(expires_at) - unixepoch(created_at) AS ttl FROM github_cache_entries WHERE route_kind = 'run_list'",
      ).first(),
    ).toEqual({ ttl: 120 });
    expect((await shapedRunList({ status: "completed", limit: "1" })).relay.cache).toBe("hit");
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each([
    ["unknown status", "not failed", "pull request"],
    ["conflicting status", "queued failed", "pull request"],
    ["missing trigger", "in progress", ""],
    ["conflicting trigger", "in progress", "pull request pushed"],
    ["unknown trigger", "in progress", "repository dispatch"],
    [
      "linked prose",
      "in progress",
      '<a href="/openclaw/octopool/tree/refs/heads/pull-request">pull request</a>',
    ],
  ])("uses exact REST and caches its metadata for %s", async (_name, state, trigger) => {
    const urls: string[] = [];
    const body = {
      total_count: 1,
      workflow_runs: [{ ...run(301, "main", "queued", null), event: "workflow_dispatch" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(bearer(request)).toBeUndefined();
        urls.push(request.url);
        return new URL(request.url).hostname === "github.com"
          ? new Response(
              `<strong>1 workflow run</strong>${runCard(101, historicalHead, { state, trigger, title: "completed successfully pushed" })}`.replaceAll(
                "openclaw/Peekaboo",
                "openclaw/octopool",
              ),
            )
          : jsonResponse(body);
      }),
    );
    expect((await shapedRunList({ limit: "1" })).body).toEqual(body);
    expect((await shapedRunList({ limit: "1" })).relay.cache).toBe("hit");
    expect(urls).toEqual([
      "https://github.com/openclaw/octopool/actions",
      "https://api.github.com/repos/openclaw/octopool/actions/runs?page=1&per_page=25",
    ]);
  });

  it("serves branch, status, and limit variants from one canonical fill", async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(bearer(request)).toBeUndefined();
      const url = new URL(request.url);
      expect(url.hostname).toBe("github.com");
      expect(url.pathname).toBe("/openclaw/octopool/actions");
      expect(Object.fromEntries(url.searchParams)).toEqual({});
      return new Response(
        runListHTML(4, [
          [1, "main", "completed successfully"],
          [2, "main", "failed"],
          [3, "feature", "in progress"],
          [4, "main", "queued"],
        ]),
      );
    });
    vi.stubGlobal("fetch", upstream);

    const branch = await shapedRunList({ branch: "main", per_page: "2" });
    expect(branch.body).toMatchObject({ total_count: 3 });
    expect(runIDs(branch.body)).toEqual([1, 2]);

    const status = await shapedRunList({ status: "failure", per_page: "1" });
    expect(status.body).toMatchObject({ total_count: 1 });
    expect(runIDs(status.body)).toEqual([2]);

    const limited = await shapedRunList({ limit: "1" });
    expect(limited.body).toMatchObject({ total_count: 4 });
    expect(runIDs(limited.body)).toEqual([1]);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(
        "SELECT backend FROM audit_events WHERE cache_status = 'miss' LIMIT 1",
      ).first(),
    ).toEqual({ backend: "github_web" });
  });

  it("normalizes and locally shapes a conditional shim request", async () => {
    let exactURL: URL | undefined;
    let conditionalHeader: string | null = null;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (bearer(request) === "test-org-token") {
        return jsonResponse({ private: false });
      }
      if (bearer(request) === "test-primary-token") {
        exactURL = new URL(request.url);
        conditionalHeader = request.headers.get("if-none-match");
        return jsonResponse(
          {
            total_count: 100,
            workflow_runs: [
              run(1, "main", "completed", "success"),
              run(2, "main", "completed", "success"),
              run(3, "main", "completed", "success"),
            ],
          },
          200,
          {
            etag: '"upstream"',
            "last-modified": "Sat, 18 Jul 2026 08:00:00 GMT",
            link: '<https://api.github.com/repositories/1/actions/runs?page=2>; rel="next"',
          },
        );
      }
      return jsonResponse({ message: "unavailable" }, 503);
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(RUNS_PATH, undefined, {
      query: { limit: "2" },
      headers: {
        "x-octopool-public-shape": "actions-summary-v1",
        "if-none-match": '"client"',
      },
    });
    expect(response.status).toBe(200);
    const envelope = await response.json<RelayEnvelope>();
    expect(runIDs(envelope.body)).toEqual([1, 2]);
    expect(envelope.body).toMatchObject({ total_count: 100 });
    expect(envelope.headers).not.toHaveProperty("etag");
    expect(envelope.headers).not.toHaveProperty("last-modified");
    expect(envelope.headers).not.toHaveProperty("link");
    expect(Object.fromEntries(exactURL!.searchParams)).toEqual({ per_page: "2" });
    expect(conditionalHeader).toBe('"client"');
  });

  it("falls back to an exact filtered request when the superset can underfill", async () => {
    const urls: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      urls.push(url);
      if (url.hostname === "api.github.com") {
        return jsonResponse({
          total_count: 3,
          workflow_runs: [
            run(101, "target", "completed", "success"),
            run(102, "target", "completed", "success"),
            run(103, "target", "completed", "success"),
          ],
        });
      }
      return new Response(
        runListHTML(
          200,
          Array.from({ length: 25 }, (_, index) => [index + 1, "main", "completed successfully"]),
        ),
      );
    });
    vi.stubGlobal("fetch", upstream);

    const response = await shapedRunList({ branch: "target", limit: "2" });
    expect(runIDs(response.body)).toEqual([101, 102]);
    expect(urls).toHaveLength(2);
    expect(urls.map((url) => url.hostname)).toEqual(["github.com", "api.github.com"]);
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({});
    expect(Object.fromEntries(urls[1]!.searchParams)).toEqual({
      branch: "target",
      per_page: "2",
    });
  });

  it("does not treat a page-sized total as proof that a filter is complete", async () => {
    const urls: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(new Request(input).url);
      urls.push(url);
      if (url.hostname === "api.github.com") {
        return jsonResponse({
          total_count: 20,
          workflow_runs: Array.from({ length: 20 }, (_, index) =>
            run(index + 100, "main", "completed", "failure"),
          ),
        });
      }
      return new Response(
        runListHTML(
          25,
          Array.from({ length: 25 }, (_, index) => [index + 1, "main", "completed successfully"]),
        ),
      );
    });
    vi.stubGlobal("fetch", upstream);

    const response = await shapedRunList({ status: "failure", limit: "20" });
    expect(runIDs(response.body)).toHaveLength(20);
    expect(urls.map((url) => url.hostname)).toEqual(["github.com", "api.github.com"]);
    expect(Object.fromEntries(urls[1]!.searchParams)).toEqual({
      per_page: "20",
      status: "failure",
    });
  });

  it("preserves GitHub validation for unsupported status values", async () => {
    const apiRequests: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (bearer(request) === "test-org-token") {
        return jsonResponse({ private: false });
      }
      if (url.hostname === "github.com") {
        return new Response("not found", { status: 404 });
      }
      apiRequests.push(url);
      return jsonResponse({ message: "Validation Failed" }, 422);
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(RUNS_PATH, undefined, {
      query: { status: "not-a-github-status" },
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });
    expect(response.status).toBe(200);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      status: 422,
      body: { message: "Validation Failed" },
    });
    expect(apiRequests).toHaveLength(2);
    for (const url of apiRequests) {
      expect(Object.fromEntries(url.searchParams)).toEqual({ status: "not-a-github-status" });
    }
  });

  it("shares workflow-scoped variants through one public page fill", async () => {
    const urls: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      urls.push(url);
      expect(url.hostname).toBe("github.com");
      return new Response(
        runListHTML(2, [
          [9, "main", "completed successfully"],
          [10, "main", "completed successfully"],
        ]),
      );
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(
      "/repos/openclaw/octopool/actions/workflows/ci.yml/runs",
      undefined,
      {
        query: { branch: "main", limit: "1" },
        headers: { "x-octopool-public-shape": "actions-summary-v1" },
      },
    );
    expect(response.status).toBe(200);
    const envelope = await response.json<RelayEnvelope>();
    expect(runIDs(envelope.body)).toEqual([9]);
    expect(envelope.body).toMatchObject({ total_count: 2 });
    const cached = await relay(
      "/repos/openclaw/octopool/actions/workflows/ci.yml/runs",
      undefined,
      {
        query: { status: "success", limit: "1" },
        headers: { "x-octopool-public-shape": "actions-summary-v1" },
      },
    );
    expect((await cached.json<RelayEnvelope>()).relay.cache).toBe("hit");
    expect(urls).toHaveLength(1);
    expect(urls[0]?.pathname).toBe("/openclaw/octopool/actions/workflows/ci.yml");
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({});
  });

  it("leaves non-shim run-list requests on exact per-query caching", async () => {
    const urls: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      urls.push(url);
      return jsonResponse({
        total_count: 1,
        workflow_runs: [run(7, "main", "completed", "success")],
      });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(RUNS_PATH, undefined, {
      query: { branch: "main", per_page: "1" },
    });
    expect(response.status).toBe(200);
    expect(urls).toHaveLength(1);
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({
      branch: "main",
      per_page: "1",
    });
  });
});

async function shapedRunList(query: Record<string, string>): Promise<RelayEnvelope> {
  const response = await relay(RUNS_PATH, undefined, {
    query,
    headers: { "x-octopool-public-shape": "actions-summary-v1" },
  });
  expect(response.status).toBe(200);
  return response.json<RelayEnvelope>();
}

function run(
  id: number,
  headBranch: string,
  status: string,
  conclusion: string | null,
): Record<string, unknown> {
  return { id, head_branch: headBranch, status, conclusion };
}

function runIDs(body: unknown): number[] {
  if (typeof body !== "object" || body === null || !("workflow_runs" in body)) {
    return [];
  }
  const runs = body.workflow_runs;
  return Array.isArray(runs)
    ? runs.flatMap((item) =>
        typeof item === "object" && item !== null && "id" in item && typeof item.id === "number"
          ? [item.id]
          : [],
      )
    : [];
}

function runListHTML(total: number, runs: [id: number, branch: string, state: string][]): string {
  return `<strong>${total} workflow runs</strong>${runs
    .map(
      ([id, branch, state]) => `
        <div class="Box-row js-socket-channel js-updatable-content">
          <a href="/openclaw/octopool/actions/runs/${id}" aria-label="${state}: Run ${id} of CI. run ${id}">
            <span class="h4 markdown-title">run ${id}</span>
          </a>
          <span class="text-bold">CI</span> #${id}:
          Commit <a href="/openclaw/octopool/commit/1e6a563d13924ba423febe3a4cb47eeb9d594322">1e6a563</a>
          pushed
          <relative-time datetime="2026-06-11T06:38:49Z"></relative-time>
          <a class="branch-name" href="/openclaw/octopool/tree/refs/heads/${branch}">${branch}</a>
        </div>`,
    )
    .join("")}`;
}
