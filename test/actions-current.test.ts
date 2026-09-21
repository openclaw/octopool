import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withGitHubEgress } from "../src/github-egress";
import {
  parseActionsJobGroupsJSON,
  parseActionsJobGroupsPageJSON,
  parseActionsJobHTML,
  parseActionsRunHTML,
  parseActionsRunListHTML,
} from "../src/github-html-actions";
import { callGitHubWeb } from "../src/github-web";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import {
  filterRunListSuperset,
  projectLargerRunListPage,
  runListSupersetUnderfilled,
  runListSupersetView,
} from "../src/run-list-superset";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/actions-current/${name}`, import.meta.url), "utf8");
const runID = 35562572332;
const path = `/repos/openclaw/openclaw/actions/runs/${runID}`;
const runHTML = fixture("run.html.txt");
const skippedHTML = fixture("skipped-job.html.txt");
const firstBatch = JSON.parse(fixture("job-batch-0.json"));
const lastBatch = JSON.parse(fixture("job-batch-1.json"));
const firstJob = parseActionsJobGroupsPageJSON(firstBatch, "openclaw", "openclaw", runID)!.jobs[0]!;

afterEach(() => vi.unstubAllGlobals());

async function readWeb(routePath = path, query?: Record<string, string>) {
  const request = validateRelayRequest({
    pool: "maintainers",
    method: "GET",
    path: routePath,
    query,
    headers: {
      "x-octopool-public-shape": routePath.endsWith("/jobs")
        ? "actions-jobs-v1"
        : "actions-summary-v1",
    },
  });
  return callGitHubWeb(
    withGitHubEgress({} as Env, []),
    request,
    classifyRoute(request, defaultPolicy("openclaw")),
  );
}

describe("current GitHub Actions markup", () => {
  it.each(["missing element", "missing datetime"])(
    "rejects an owned active-job header without timing: %s",
    (variant) => {
      const summary = {
        id: 106229081199,
        name: "preflight",
        status: "in_progress",
        conclusion: null,
        href: "/openclaw/openclaw/actions/runs/35566435541/job/106229081199",
      };
      const html = fixture("active-job.html.txt").replace(
        /<relative-time\b[\s\S]*?<\/relative-time>/,
        (tag) => (variant === "missing element" ? "" : tag.replace(/\sdatetime="[^"]*"/, "")),
      );
      expect(parseActionsJobHTML(html, summary, "openclaw", "openclaw")).toBeUndefined();
      expect(
        parseActionsJobHTML(html.replace("Started", "succeeded"), summary, "openclaw", "openclaw"),
      ).toBeUndefined();
    },
  );

  it.each(["queued", "untimed success", "null conclusion"])(
    "rejects incomplete step lifecycle evidence on a completed job: %s",
    (variant) => {
      const summary = {
        id: 106220362714,
        name: "preflight",
        status: "completed",
        conclusion: "success",
        href: "/openclaw/openclaw/actions/runs/35563377671/job/106220362714",
      };
      const html = fixture("completed-job.html.txt").replace(/<check-step\b[\s\S]*?>/, (tag) => {
        if (variant !== "null conclusion")
          tag = tag.replace(/\sdata-(?:started|completed)-at="[^"]*"/g, "");
        if (variant !== "untimed success")
          tag = tag.replace('data-conclusion="success"', 'data-conclusion="null"');
        return tag;
      });
      expect(parseActionsJobHTML(html, summary, "openclaw", "openclaw")).toBeUndefined();
    },
  );

  it.each(["PageHeader-actions", "PageHeader-navigation"])(
    "does not let %s on a title bypass retained metadata validation",
    (controlClass) => {
      const html = runHTML.replace(
        'class="markdown-title"',
        `class="markdown-title ${controlClass}" class="conflicting"`,
      );
      expect(parseActionsRunHTML(html, "openclaw", "openclaw", runID)).toBeUndefined();
    },
  );

  it("rejects a stale queued group when the selected page has become skipped", () => {
    const queued = { ...firstJob, status: "queued", conclusion: null };
    expect(parseActionsJobHTML(skippedHTML, queued, "openclaw", "openclaw")).toBeUndefined();
    expect(
      parseActionsJobHTML(
        skippedHTML.replace(
          "This job was skipped",
          'This job was skipped<check-steps data-job-status="queued"></check-steps>',
        ),
        queued,
        "openclaw",
        "openclaw",
      ),
    ).toBeUndefined();
  });

  it("rejects duplicate or foreign job metadata even when a queued job has no steps", () => {
    const summary = {
      id: 106220362714,
      name: "preflight",
      status: "queued",
      conclusion: null,
      href: "/openclaw/openclaw/actions/runs/35563377671/job/106220362714",
    };
    const navigation = /<react-partial[\s\S]*?<\/react-partial>/.exec(
      fixture("completed-job.html.txt"),
    )![0];
    const steps = '<check-steps data-job-status="queued"></check-steps>';
    const page = (contents: string) =>
      `${navigation}<section aria-label="Check run summary" class="js-selected-check-run">${contents}</section>`;
    expect(parseActionsJobHTML(page(steps), summary, "openclaw", "openclaw")).toMatchObject({
      status: "queued",
      steps: [],
    });
    expect(
      parseActionsJobHTML(page(steps + steps), summary, "openclaw", "openclaw"),
    ).toBeUndefined();
    expect(
      parseActionsJobHTML(
        page(steps + '<span data-url="/other/repo/runs/1/header"></span>'),
        summary,
        "openclaw",
        "openclaw",
      ),
    ).toBeUndefined();
  });

  it.each([26, 100])("keeps requests above 25 cards on REST (per_page %i)", async (perPage) => {
    const upstream = vi.fn(async (url: string) => {
      expect(new URL(url).hostname).toBe("api.github.com");
      return Response.json({
        total_count: 2500,
        workflow_runs: Array.from({ length: perPage }, (_, index) => ({ id: index + 1 })),
      });
    });
    vi.stubGlobal("fetch", upstream);
    for (const route of [
      "/repos/openclaw/openclaw/actions/runs",
      "/repos/openclaw/openclaw/actions/workflows/ci.yml/runs",
    ]) {
      const response = await readWeb(route, { per_page: String(perPage) });
      expect(response).toMatchObject({ backend: "github" });
      expect(response?.body).toHaveProperty("workflow_runs.length", perPage);
    }
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("reads an active job's Started header as start time, never completion time", () => {
    const summary = {
      id: 106229081199,
      name: "preflight",
      status: "in_progress",
      conclusion: null,
      href: "/openclaw/openclaw/actions/runs/35566435541/job/106229081199",
    };
    const result = parseActionsJobHTML(
      fixture("active-job.html.txt"),
      summary,
      "openclaw",
      "openclaw",
    );
    expect(result).toMatchObject({
      status: "in_progress",
      started_at: "2026-09-21T05:56:51Z",
      completed_at: null,
      steps: expect.arrayContaining([
        expect.objectContaining({ status: "in_progress", conclusion: null }),
      ]),
    });
    expect(JSON.stringify(result)).not.toContain('"conclusion":"null"');
  });

  it("rejects mixed job states, reversed step timing, and steps after completion", () => {
    const summary = {
      id: 106220362714,
      name: "preflight",
      status: "completed",
      conclusion: "success",
      href: "/openclaw/openclaw/actions/runs/35563377671/job/106220362714",
    };
    const html = fixture("completed-job.html.txt");
    expect(
      parseActionsJobHTML(
        html,
        { ...summary, status: "in_progress", conclusion: null },
        "openclaw",
        "openclaw",
      ),
    ).toBeUndefined();
    expect(
      parseActionsJobHTML(html, { ...summary, conclusion: "failure" }, "openclaw", "openclaw"),
    ).toBeUndefined();
    expect(
      parseActionsJobHTML(
        html.replace('datetime="2026-09-21T05:16:35Z"', 'datetime="2026-09-21T05:15:49Z"'),
        summary,
        "openclaw",
        "openclaw",
      ),
    ).toBeUndefined();
    expect(
      parseActionsJobHTML(
        html.replace(
          'data-completed-at="2026-09-21T05:15:49Z"',
          'data-completed-at="2026-09-21T05:15:47Z"',
        ),
        summary,
        "openclaw",
        "openclaw",
      ),
    ).toBeUndefined();
  });

  it("preserves an upstream lower bound when slicing unfiltered runs", () => {
    const response = {
      status: 200,
      headers: {},
      body_encoding: "json" as const,
      body: { total_count: 2500, workflow_runs: [{ id: 1 }, { id: 2 }] },
    };
    expect(filterRunListSuperset(response, { limit: 1 }).body).toEqual({
      total_count: 2500,
      workflow_runs: [{ id: 1 }],
    });
  });

  it("requires selected-job ownership even for queued and in-progress jobs", () => {
    const job = {
      id: 106220362714,
      name: "preflight",
      status: "in_progress",
      conclusion: null,
      href: "/openclaw/openclaw/actions/runs/35563377671/job/106220362714",
    };
    const html = fixture("completed-job.html.txt");
    expect(
      parseActionsJobHTML(
        html.replace(/"selectedJobId":\s*106220362714/, '"selectedJobId":1'),
        job,
        "openclaw",
        "openclaw",
      ),
    ).toBeUndefined();
    expect(
      parseActionsJobHTML(
        html.replace(
          /"summaryHref":\s*"[^"]+"/,
          '"summaryHref":"/openclaw/openclaw/actions/runs/1"',
        ),
        job,
        "openclaw",
        "openclaw",
      ),
    ).toBeUndefined();
    expect(
      parseActionsJobHTML(
        "<div>Queued</div>",
        { ...job, status: "queued" },
        "openclaw",
        "openclaw",
      ),
    ).toBeUndefined();
  });

  it("refuses skipped placeholders with conflicting owned timing evidence", () => {
    for (const timing of [
      `<span data-url="/openclaw/openclaw/runs/${firstJob.id}/header"></span>`,
      '<relative-time datetime="2026-09-21T04:53:38Z"></relative-time>',
      '<span data-started-at="2026-09-21T04:53:38Z"></span>',
    ]) {
      expect(
        parseActionsJobHTML(
          skippedHTML.replace("This job was skipped", `This job was skipped${timing}`),
          firstJob,
          "openclaw",
          "openclaw",
        ),
      ).toBeUndefined();
    }
  });

  it.each([10, 30])(
    "bounds hydrated pages while retaining a complete larger job count (limit %i)",
    async (limit) => {
      const jobs = Array.from({ length: 30 }, (_, index) => ({
        ...firstBatch.jobGroups[0].nonNested.jobs[0],
        id: firstJob.id + index,
        href: `/openclaw/openclaw/actions/runs/${runID}/job/${firstJob.id + index}`,
      }));
      const upstream = vi.fn(async (url: string) => {
        if (url.includes("job_groups_batch"))
          return Response.json({
            jobGroups: [{ name: "matrix", nonNested: { jobs } }],
            totalCount: 1,
            hasMore: false,
          });
        if (url.startsWith("https://api.github.com/")) return Response.json({ exact: true });
        return new Response(skippedHTML.replaceAll(String(firstJob.id), url.split("/").at(-1)!));
      });
      vi.stubGlobal("fetch", upstream);
      const response = await readWeb(`${path}/attempts/1/jobs`, { per_page: String(limit) });
      if (limit === 10) {
        expect(response).toMatchObject({ backend: "web", body: { total_count: 30 } });
        expect(response?.body).toHaveProperty("jobs.length", 10);
        expect(upstream).toHaveBeenCalledTimes(11);
      } else {
        expect(response).toMatchObject({ backend: "github", body: { exact: true } });
        expect(upstream).toHaveBeenCalledTimes(2);
      }
    },
  );

  it("reads the run's retained header, summary and attempt through unrelated malformed dialog controls", () => {
    expect(parseActionsRunHTML(runHTML, "openclaw", "openclaw", runID)).toMatchObject({
      id: runID,
      name: "Security Review",
      run_number: 76278,
      status: "completed",
      conclusion: "skipped",
      event: "issue",
      run_attempt: 1,
      head_sha: "f76d38a4ac5e5f4e6c5a5320436db169e33d5c8a",
    });
  });

  it.each([
    [
      "conflicting responsive statuses",
      (html: string) => html.replace('aria-label="skipped: "', 'aria-label="failed: "'),
    ],
    [
      "duplicate header attribute",
      (html: string) =>
        html.replace("<page-header ", '<page-header aria-label="one" aria-label="two" '),
    ],
    [
      "duplicate summary attribute",
      (html: string) =>
        html.replace(
          'aria-label="Workflow run summary"',
          'aria-label="Workflow run summary" aria-label="other"',
        ),
    ],
    [
      "duplicate owned title attribute",
      (html: string) =>
        html.replace('class="markdown-title"', 'class="markdown-title" class="other"'),
    ],
    [
      "malformed retained title",
      (html: string) =>
        html.replace('<span class="markdown-title"', '<p><span class="markdown-title"'),
    ],
    [
      "unowned commit",
      (html: string) => html.replace("/openclaw/openclaw/commit/", "/elsewhere/repo/commit/"),
    ],
  ] as const)("rejects %s", (_name, transform) => {
    expect(parseActionsRunHTML(transform(runHTML), "openclaw", "openclaw", runID)).toBeUndefined();
  });

  it("selects page transport for shaped run views without an API request", async () => {
    const upstream = vi.fn(async (_url: string) => new Response(runHTML));
    vi.stubGlobal("fetch", upstream);
    expect(await readWeb()).toMatchObject({
      backend: "web",
      body: { id: runID, run_attempt: 1, conclusion: "skipped" },
    });
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `https://github.com/openclaw/openclaw/actions/runs/${runID}`,
    );
  });

  it("reads current list cards and responsive counts without borrowing title prose", () => {
    const parsed = parseActionsRunListHTML(fixture("list.html.txt"), "openclaw", "openclaw");
    expect(parsed).toMatchObject({ total_count: 2500, capped: true });
    expect(
      parsed?.workflow_runs.map((run) => [run.id, run.name, run.run_number, run.event]),
    ).toEqual([
      [35562581101, "Docs Agent", 325025, null],
      [35562581066, "Security Review", 76287, null],
      [35562580066, "PR context and evidence", 901389, null],
    ]);
    const workflow = parseActionsRunListHTML(fixture("workflow.html.txt"), "openclaw", "openclaw");
    expect(workflow?.workflow_runs[0]).toMatchObject({
      event: "workflow_dispatch",
      run_number: 482558,
    });
    expect(workflow?.workflow_runs[2]).toMatchObject({ status: "in_progress", conclusion: null });
    expect(workflow?.workflow_runs[3]).toMatchObject({
      status: "pending",
      event: "push",
      head_sha: "65485f6adee955abe60d18ec3277ff9bd77e1309",
    });
  });

  it.each([
    [
      "count disagreement",
      (html: string) => html.replace("2,500+ workflow runs", "2,501+ workflow runs"),
    ],
    [
      "timestamp disagreement",
      (html: string) => html.replace("2026-09-21T04:53:48Z", "2026-09-20T04:53:48Z"),
    ],
    [
      "duplicate workflow",
      (html: string) =>
        html.replace(
          '<span class="text-bold">Docs Agent</span>',
          '<span class="text-bold">Docs Agent</span><span class="text-bold">other</span>',
        ),
    ],
    [
      "duplicate owned attribute",
      (html: string) =>
        html.replace('aria-label="skipped: ', 'aria-label="other" aria-label="skipped: '),
    ],
    ["absent count", (html: string) => html.replaceAll("2,500+ workflow runs", "unknown")],
  ] as const)("rejects list %s", (_name, transform) => {
    expect(
      parseActionsRunListHTML(transform(fixture("list.html.txt")), "openclaw", "openclaw"),
    ).toBeUndefined();
  });

  it("keeps uncapped totals exact", () => {
    const html = fixture("list.html.txt")
      .replaceAll("2,500+ workflow runs", "3 workflow runs")
      .replace('count_is_capped="true"', 'count_is_capped="false"');
    expect(parseActionsRunListHTML(html, "openclaw", "openclaw")).toMatchObject({
      total_count: 3,
      capped: false,
    });
    expect(
      parseActionsRunListHTML(
        html.replaceAll("3 workflow runs", "2 workflow runs"),
        "openclaw",
        "openclaw",
      ),
    ).toBeUndefined();
  });

  it("refuses an underfilled capped page before hydrating any runs", async () => {
    const upstream = vi.fn(async (url: string) =>
      url.startsWith("https://github.com/")
        ? new Response(fixture("list.html.txt"))
        : Response.json({ total_count: 2501, workflow_runs: [] }),
    );
    vi.stubGlobal("fetch", upstream);
    expect(await readWeb("/repos/openclaw/openclaw/actions/runs", { per_page: "4" })).toMatchObject(
      { backend: "github" },
    );
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("does not treat a lower bound as proof that a short cache page or filtered subset is complete", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/actions/runs",
      query: { per_page: "3", branch: "main" },
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });
    const view = runListSupersetView(request, classifyRoute(request, defaultPolicy("openclaw")));
    const response = {
      status: 200,
      body_encoding: "json" as const,
      headers: {},
      body: { total_count: 2500, workflow_runs: [{ id: 1, head_branch: "main" }] },
    };
    expect(runListSupersetUnderfilled(response, view)).toBe(true);
    expect(projectLargerRunListPage(response)).toBeUndefined();
  });

  it("rejects incomplete job-group JSON and aggregates only complete pages", () => {
    expect(parseActionsJobGroupsJSON(firstBatch, "openclaw", "openclaw", runID)).toBeUndefined();
    const combined = { ...lastBatch, jobGroups: [...firstBatch.jobGroups, ...lastBatch.jobGroups] };
    expect(
      parseActionsJobGroupsJSON(combined, "openclaw", "openclaw", runID)?.map((job) => job.id),
    ).toEqual([106218103310, 106218103534]);
    expect(
      parseActionsJobGroupsJSON(
        { ...combined, jobGroups: [firstBatch.jobGroups[0], firstBatch.jobGroups[0]] },
        "openclaw",
        "openclaw",
        runID,
      ),
    ).toBeUndefined();
  });

  it("owns skipped-job identity and returns unavailable timestamps without guessing", () => {
    expect(parseActionsJobHTML(skippedHTML, firstJob, "openclaw", "openclaw")).toEqual({
      id: firstJob.id,
      name: "resolve",
      status: "completed",
      conclusion: "skipped",
      started_at: null,
      completed_at: null,
      html_url: `https://github.com${firstJob.href}`,
      steps: [],
    });
    expect(
      parseActionsJobHTML(
        skippedHTML.replace(/"selectedJobId":\s*106218103310/, '"selectedJobId":1'),
        firstJob,
        "openclaw",
        "openclaw",
      ),
    ).toBeUndefined();
    expect(
      parseActionsJobHTML(
        skippedHTML.replace("This job was skipped", "This job failed"),
        firstJob,
        "openclaw",
        "openclaw",
      ),
    ).toBeUndefined();
  });

  it("reads completed steps from the live job's owned regions", () => {
    const result = parseActionsJobHTML(
      fixture("completed-job.html.txt"),
      {
        id: 106220362714,
        name: "preflight",
        status: "completed",
        conclusion: "success",
        href: "/openclaw/openclaw/actions/runs/35563377671/job/106220362714",
      },
      "openclaw",
      "openclaw",
    );
    expect(result).toMatchObject({
      id: 106220362714,
      started_at: "2026-09-21T05:15:48Z",
      steps: expect.arrayContaining([
        expect.objectContaining({ name: "Set up job", number: 1, conclusion: "success" }),
      ]),
    });
  });

  it("follows deterministic batches, owns both jobs and drops first-page validators", async () => {
    const upstream = vi.fn(async (url: string) => {
      if (url.includes("batch=0"))
        return Response.json(firstBatch, { headers: { etag: '"first-batch"' } });
      if (url.includes("batch=1")) return Response.json(lastBatch);
      return new Response(
        url.endsWith("/106218103310")
          ? skippedHTML
          : skippedHTML.replaceAll("106218103310", "106218103534"),
      );
    });
    vi.stubGlobal("fetch", upstream);
    const response = await readWeb(`${path}/attempts/1/jobs`, { per_page: "100" });
    expect(response).toMatchObject({
      backend: "web",
      body: {
        total_count: 2,
        jobs: [
          { id: 106218103310, steps: [] },
          { id: 106218103534, steps: [] },
        ],
      },
    });
    expect(response?.headers.etag).toBeUndefined();
    expect(upstream.mock.calls.map(([url]) => url)).toEqual([
      `https://github.com/openclaw/openclaw/actions/runs/${runID}/job_groups_batch?attempt=1&batch=0&size=1`,
      `https://github.com/openclaw/openclaw/actions/runs/${runID}/job_groups_batch?attempt=1&batch=1&size=1`,
      `https://github.com${firstJob.href}`,
      `https://github.com/openclaw/openclaw/actions/runs/${runID}/job/106218103534`,
    ]);
  });

  it.each(["duplicate", "changed count", "early end", "missing batch", "too many groups"])(
    "refuses %s without a partial job result",
    async (kind) => {
      const first = structuredClone(firstBatch);
      const second = structuredClone(lastBatch);
      if (kind === "duplicate") second.jobGroups = first.jobGroups;
      if (kind === "changed count") second.totalCount = 3;
      if (kind === "early end") first.hasMore = false;
      if (kind === "too many groups") first.totalCount = 26;
      const upstream = vi.fn(async (url: string) => {
        if (url.startsWith("https://api.github.com/")) return Response.json({ exact: true });
        if (url.includes("batch=0")) return Response.json(first);
        if (url.includes("batch=1"))
          return kind === "missing batch"
            ? new Response("", { status: 503 })
            : Response.json(second);
        throw new Error("must not fetch job pages for an incomplete group set");
      });
      vi.stubGlobal("fetch", upstream);
      expect(await readWeb(`${path}/attempts/1/jobs`)).toMatchObject({
        backend: "github",
        body: { exact: true },
      });
    },
  );
});
