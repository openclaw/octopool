import { afterEach, expect, it, vi } from "vitest";
import { withGitHubEgress } from "../src/github-egress";
import { parseActionsRunHTML, parseActionsRunListHTML } from "../src/github-html-actions";
import { callGitHubWeb } from "../src/github-web";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";

afterEach(() => vi.unstubAllGlobals());

it.skipIf(process.env.OCTOPOOL_LIVE_GITHUB !== "1")(
  "parses live public Actions pages and all job-group batches without API quota",
  async () => {
    const owner = "openclaw";
    const repo = "openclaw";
    const id = 35562572332;
    const pushRunID = 35563305550;
    const root = `https://github.com/${owner}/${repo}`;
    const pages = await Promise.all(
      [
        `${root}/actions/runs/${pushRunID}`,
        `${root}/actions`,
        `${root}/actions/workflows/ci.yml`,
        `${root}/actions/runs/${id}`,
      ].map(async (url) => {
        const response = await fetch(url, {
          headers: { "user-agent": "octopool", accept: "text/html" },
          signal: AbortSignal.timeout(30000),
        });
        expect(response.status).toBe(200);
        return response.text();
      }),
    );
    const run = parseActionsRunHTML(pages[0]!, owner, repo, pushRunID);
    expect(run).toMatchObject({
      id: pushRunID,
      run_attempt: expect.any(Number),
      status: expect.any(String),
      name: expect.any(String),
      head_sha: expect.stringMatching(/^[a-f0-9]{40}$/),
      event: "push",
    });
    const issueRun = parseActionsRunHTML(pages[3]!, owner, repo, id);
    expect(issueRun).toMatchObject({ id, event: "issue_comment" });
    const lists = pages.slice(1, 3).map((html) => parseActionsRunListHTML(html, owner, repo));
    for (const list of lists) {
      expect(list).toBeDefined();
      expect(list?.total_count).toBeGreaterThan(0);
      expect(list?.workflow_runs.length).toBe(25);
      for (const item of list!.workflow_runs) {
        expect(item).toMatchObject({
          id: expect.any(Number),
          run_number: expect.any(Number),
          name: expect.any(String),
          status: expect.any(String),
          html_url: expect.any(String),
          created_at: expect.any(String),
        });
        for (const key of ["head_sha", "head_branch", "conclusion", "event"])
          expect(item).toHaveProperty(key);
      }
    }
    const originalFetch = globalThis.fetch;
    for (const [index, suffix] of ["runs", "workflows/ci.yml/runs"].entries()) {
      const page = pages[index + 1]!;
      const parsed = lists[index]!;
      const needsHydration = parsed.workflow_runs.filter(
        (item) => !/^[a-f0-9]{40}$/i.test(String(item.head_sha)) || typeof item.event !== "string",
      ).length;
      const fetchedURLs: string[] = [];
      // Replay the just-fetched list so cardinality and hydration use one snapshot.
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        fetchedURLs.push(url);
        expect(new URL(url).hostname).toBe("github.com");
        if (url.endsWith(index === 0 ? "/actions" : "/actions/workflows/ci.yml")) {
          return new Response(page);
        }
        return originalFetch(url, init);
      });
      const listRequest = validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: `/repos/${owner}/${repo}/actions/${suffix}`,
        query: { per_page: "25" },
        headers: { "x-octopool-public-shape": "actions-summary-v1" },
      });
      const started = performance.now();
      const hydrated = await callGitHubWeb(
        withGitHubEgress({ REQUEST_TIMEOUT_MS: "30000" } as unknown as Env, []),
        listRequest,
        classifyRoute(listRequest, defaultPolicy(owner)),
        { skipAnonymousAPI: true },
      );
      const elapsedMs = Math.round(performance.now() - started);
      if (needsHydration > 8) {
        expect(hydrated).toBeUndefined();
        expect(fetchedURLs).toHaveLength(1);
        expect(elapsedMs).toBeLessThan(1000);
      } else {
        expect(hydrated).toMatchObject({ backend: "web" });
        expect(hydrated?.body).toHaveProperty("workflow_runs.length", parsed.workflow_runs.length);
      }
      process.stdout.write(
        `${JSON.stringify({ list: suffix, cards: parsed.workflow_runs.length, needsHydration, result: hydrated === undefined ? "undefined: hydration count exceeds 8" : "complete", runPageFetches: fetchedURLs.length - 1, elapsedMs })}\n`,
      );
      let freshHydrations: number | undefined;
      let freshRunFetches = 0;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        expect(new URL(url).hostname).toBe("github.com");
        const response = await originalFetch(url, init);
        if (url.endsWith(index === 0 ? "/actions" : "/actions/workflows/ci.yml")) {
          const fresh = parseActionsRunListHTML(await response.clone().text(), owner, repo);
          expect(fresh).toBeDefined();
          freshHydrations = fresh!.workflow_runs.filter(
            (item) =>
              !/^[a-f0-9]{40}$/i.test(String(item.head_sha)) || typeof item.event !== "string",
          ).length;
        } else {
          freshRunFetches++;
        }
        return response;
      });
      const freshStarted = performance.now();
      const freshResult = await callGitHubWeb(
        withGitHubEgress({ REQUEST_TIMEOUT_MS: "30000" } as unknown as Env, []),
        listRequest,
        classifyRoute(listRequest, defaultPolicy(owner)),
        { skipAnonymousAPI: true },
      );
      const freshElapsedMs = Math.round(performance.now() - freshStarted);
      expect(freshElapsedMs).toBeLessThan(1600);
      if (freshResult === undefined) {
        expect((freshHydrations ?? 0) > 8 || freshElapsedMs >= 950).toBe(true);
        if ((freshHydrations ?? 0) > 8) expect(freshRunFetches).toBe(0);
      } else {
        expect(freshResult).toMatchObject({ backend: "web" });
      }
      process.stdout.write(
        `${JSON.stringify({ liveFetch: suffix, needsHydration: freshHydrations, result: freshResult === undefined ? "undefined: count/deadline bound" : "complete", runPageFetches: freshRunFetches, elapsedMs: freshElapsedMs })}\n`,
      );
    }
    const batches: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(new URL(url).hostname).toBe("github.com");
      const response = await originalFetch(url, init);
      if (url.includes("job_groups_batch")) {
        const body = (await response.clone().json()) as {
          hasMore: boolean;
          totalCount: number;
          jobGroups: unknown[];
        };
        batches.push({
          batch: new URL(url).searchParams.get("batch"),
          hasMore: body.hasMore,
          totalCount: body.totalCount,
          groups: body.jobGroups.length,
        });
      }
      return response;
    });
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: `/repos/${owner}/${repo}/actions/runs/${id}/attempts/1/jobs`,
      query: { per_page: "100" },
      headers: { "x-octopool-public-shape": "actions-jobs-v1" },
    });
    const jobs = await callGitHubWeb(
      withGitHubEgress({ REQUEST_TIMEOUT_MS: "30000" } as unknown as Env, []),
      request,
      classifyRoute(request, defaultPolicy(owner)),
      { skipAnonymousAPI: true },
    );
    expect(jobs).toMatchObject({
      backend: "web",
      body: {
        total_count: 2,
        jobs: [
          {
            id: 106218103310,
            status: "completed",
            conclusion: "skipped",
            started_at: null,
            completed_at: null,
            steps: [],
          },
          {
            id: 106218103534,
            status: "completed",
            conclusion: "skipped",
            started_at: null,
            completed_at: null,
            steps: [],
          },
        ],
      },
    });
    expect(batches).toEqual([
      { batch: "0", hasMore: true, totalCount: 2, groups: 1 },
      { batch: "1", hasMore: false, totalCount: 2, groups: 1 },
    ]);
    console.log(
      JSON.stringify(
        {
          run_view: run,
          canonical_issue_run: issueRun,
          run_list: {
            total_count: lists[0]!.total_count,
            capped: lists[0]!.capped,
            workflow_runs: lists[0]!.workflow_runs.slice(0, 3),
          },
          workflow_run_list: {
            total_count: lists[1]!.total_count,
            capped: lists[1]!.capped,
            workflow_runs: lists[1]!.workflow_runs.slice(0, 3),
          },
          job_batches: batches,
          run_jobs: jobs?.body,
        },
        null,
        2,
      ),
    );
  },
  120000,
);
