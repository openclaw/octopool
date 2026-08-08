import { afterEach, describe, expect, it, vi } from "vitest";
import { callGitHubWeb } from "../src/github-web";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";

describe("github web provider", () => {
  const policy = defaultPolicy("openclaw");

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps custom-media PR diffs on their single public candidate", async () => {
    const fetchMock = vi.fn(async () => new Response("diff --git a/README.md b/README.md\n"));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/pulls/12",
      headers: { accept: "application/vnd.github.v3.diff" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(response).toMatchObject({
      status: 200,
      body: "diff --git a/README.md b/README.md\n",
      body_encoding: "text",
      backend: "web",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/openclaw/octopool/pull/12.diff",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
  });

  it("follows GitHub public diff redirects to the patch host", async () => {
    const cancel = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), {
          status: 302,
          headers: {
            location: "https://patch-diff.githubusercontent.com/raw/openclaw/octopool/pull/12.diff",
          },
        }),
      )
      .mockResolvedValueOnce(new Response("diff --git a/README.md b/README.md\n"));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/pulls/12",
      headers: { accept: "application/vnd.github.v3.diff" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(response).toMatchObject({ status: 200, backend: "web" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://patch-diff.githubusercontent.com/raw/openclaw/octopool/pull/12.diff",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
  });

  it("prefers raw content before the anonymous contents API", async () => {
    const fetchMock = vi.fn(async () => new Response("hello\n"));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      query: { ref: "main" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/openclaw/octopool/main/README.md",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
    expect(response?.body).toMatchObject({
      type: "file",
      encoding: "base64",
      name: "README.md",
      path: "README.md",
      content: "aGVsbG8K",
    });
  });

  it("falls back to the anonymous contents API when raw content is unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({
          type: "file",
          encoding: "base64",
          name: "My File.md",
          path: "docs/My File.md",
          content: "aGVsbG8K",
          download_url:
            "https://raw.githubusercontent.com/openclaw/octopool/main/docs/My%20File.md",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/docs/My%20File.md",
      query: { ref: "main" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/openclaw/octopool/contents/docs/My%20File.md?ref=main",
      expect.any(Object),
    );
    expect(response?.body).toMatchObject({
      name: "My File.md",
      path: "docs/My File.md",
      download_url: "https://raw.githubusercontent.com/openclaw/octopool/main/docs/My%20File.md",
    });
  });

  it("encodes decoded compare refs exactly once for web diffs", async () => {
    const fetchMock = vi.fn(async () => new Response("diff --git a/README.md b/README.md\n"));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/compare/main...feature%2Ffoo",
      headers: { accept: "application/vnd.github.v3.diff" },
    });

    await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/openclaw/octopool/compare/main...feature%2Ffoo.diff",
      expect.any(Object),
    );
  });

  it("fetches releases through unauthenticated GitHub API reads", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([{ tag_name: "v0.2.5", draft: false }]), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/releases",
      query: { per_page: "10" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/openclaw/octopool/releases?per_page=10",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
    expect(response).toMatchObject({
      status: 200,
      body: [{ tag_name: "v0.2.5", draft: false }],
      backend: "github",
    });
  });

  it("prefers public HTML for common Actions run lists", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(`
          <strong>1 workflow run result</strong>
          <div class="Box-row js-socket-channel js-updatable-content">
            <a href="/openclaw/octopool/actions/runs/27328786454" aria-label="completed successfully: Run 79 of CI. fix: harden setup">
              <span class="h4 markdown-title">fix: harden setup</span>
            </a>
            <span class="text-bold">CI</span> #79:
            Commit <a href="/openclaw/octopool/commit/1e6a563d13924ba423febe3a4cb47eeb9d594322">1e6a563</a>
            pushed
            <relative-time datetime="2026-06-11T06:38:49Z"></relative-time>
            <a class="branch-name" title="main" href="/openclaw/octopool/tree/refs/heads/main">main</a>
            <svg aria-label="Run duration"></svg><span>2m 49s</span>
          </div>
          <div class="paginate-container"></div>
        `),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
      query: { per_page: "20" },
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://github.com/openclaw/octopool/actions",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
    expect(response?.body).toMatchObject({
      total_count: 1,
      workflow_runs: [
        {
          id: 27328786454,
          name: "CI",
          display_title: "fix: harden setup",
          status: "completed",
          conclusion: "success",
          head_branch: "main",
          head_sha: "1e6a563d13924ba423febe3a4cb47eeb9d594322",
          event: "push",
          created_at: "2026-06-11T06:38:49Z",
          updated_at: "2026-06-11T06:41:38Z",
        },
      ],
    });
  });

  it("keeps filtered startup-failure reads on exact anonymous API JSON", async () => {
    const exact = {
      total_count: 1,
      workflow_runs: [{ id: 27328786455, status: "completed", conclusion: "startup_failure" }],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(exact));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
      query: { per_page: "20", status: "startup_failure" },
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(response).toMatchObject({ body: exact, backend: "github" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/openclaw/octopool/actions/runs?per_page=20&status=startup_failure",
      expect.any(Object),
    );
  });

  it("persists anonymous API quota after an Actions HTML parser miss", async () => {
    const bound: unknown[][] = [];
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn((...values: unknown[]) => {
          bound.push(values);
          return {
            first: vi.fn(async () => null),
            run: vi.fn(async () => ({})),
          };
        }),
      })),
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("<html>unexpected</html>"))
        .mockResolvedValueOnce(
          Response.json(
            { total_count: 0, workflow_runs: [] },
            {
              headers: {
                "x-ratelimit-limit": "60",
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "4102444800",
              },
            },
          ),
        ),
    );
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });
    const route = classifyRoute(request, policy);

    await callGitHubWeb({ ...env(), DB: database } as unknown as Env, request, route);

    expect(bound).toContainEqual([route.resource, 60, 0, 4102444800]);
  });

  it("falls back to 25 public Actions runs when per_page is omitted", async () => {
    const cards = Array.from(
      { length: 30 },
      (_, index) => `
        <div class="js-updatable-content extra-class Box-row js-socket-channel">
          <a href="/openclaw/octopool/actions/runs/${index + 1}" aria-label="completed successfully: Run ${index + 1} of CI. run ${index + 1}">
            <span class="h4 markdown-title">run ${index + 1}</span>
          </a>
          <span class="text-bold">CI</span> #${index + 1}:
          Commit <a href="/openclaw/octopool/commit/1e6a563d13924ba423febe3a4cb47eeb9d594322">1e6a563</a>
          pushed
          <relative-time datetime="2026-06-11T06:38:49Z"></relative-time>
          <a class="branch-name" title="main" href="/openclaw/octopool/tree/refs/heads/main">main</a>
        </div>
      `,
    ).join("");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response(`<strong>30 workflow runs</strong>${cards}`)),
    );
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(response?.body).toMatchObject({ total_count: 30 });
    const body = response?.body as { workflow_runs: unknown[] } | undefined;
    expect(body?.workflow_runs).toHaveLength(25);
  });

  it("falls back to a public workflow page for workflow-scoped run lists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(`
          <strong>1 workflow run result</strong>
          <div class="Box-row js-socket-channel js-updatable-content">
            <a href="/openclaw/octopool/actions/runs/26906919053" aria-label="completed successfully: Run 65 of CI. workflow-filtered">
              <span class="h4 markdown-title">workflow-filtered</span>
            </a>
            <span class="text-bold">CI</span> #65:
            pull request
            <relative-time datetime="2026-06-03T18:14:57Z"></relative-time>
          </div>
        `),
      )
      .mockResolvedValueOnce(
        new Response(`
          <meta name="twitter:title" content="workflow-filtered &#183; openclaw/octopool@ef53e13">
          <span class="PageHeader-parentLink-label"> CI</span>
          <span class="actions-workflow-runs-status"><svg aria-label="completed successfully: "></svg></span>
          <h1 class="PageHeader-title"><span class="markdown-title">workflow-filtered</span><span>#65</span></h1>
          <span>Triggered via pull request <relative-time datetime="2026-06-03T18:14:57Z"></relative-time></span>
          <a class="branch-name" title="RomneyDa:fix/login-provisioning-guidance" href="/RomneyDa/octopool/tree/refs/heads/fix/login-provisioning-guidance">fix/login-provisioning-guidance</a>
          <span>Total duration</span><a class="h4 color-fg-default">19s</a>
        `),
      )
      .mockResolvedValueOnce(
        new Response("From ef53e13233adb1af0730f8239d87149d60cb42ac Mon Sep 17 00:00:00 2001\n"),
      );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/workflows/ci.yml/runs",
      query: { per_page: "20" },
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://github.com/openclaw/octopool/actions/workflows/ci.yml",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://github.com/openclaw/octopool/actions/runs/26906919053",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://github.com/openclaw/octopool/commit/ef53e13.patch",
      expect.objectContaining({ headers: expect.objectContaining({ accept: "text/plain" }) }),
    );
    expect(response?.body).toMatchObject({
      workflow_runs: [
        {
          display_title: "workflow-filtered",
          head_branch: "fix/login-provisioning-guidance",
          head_sha: "ef53e13233adb1af0730f8239d87149d60cb42ac",
          updated_at: "2026-06-03T18:15:16Z",
        },
      ],
    });
  });

  it("does not drop repeated Actions list filters in the exact API fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("rate limited", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
      query: { per_page: "10", branch: ["main", "release"] },
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to exact anonymous Actions JSON when the public parser misses", async () => {
    const exact = {
      total_count: 1,
      workflow_runs: [{ id: 27328786454, unexpected_exact_field: "kept" }],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>unexpected</html>"))
      .mockResolvedValueOnce(Response.json(exact));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
      query: { per_page: "20" },
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({
      body: exact,
      backend: "github",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://github.com/openclaw/octopool/actions",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/openclaw/octopool/actions/runs?per_page=20",
      expect.any(Object),
    );
  });

  it("routes filtered Actions reads directly to exact anonymous API JSON", async () => {
    const exact = {
      total_count: 11,
      workflow_runs: Array.from({ length: 11 }, (_, index) => ({
        id: index + 1,
        status: "completed",
        conclusion: "failure",
      })),
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(exact));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
      query: { per_page: "20", status: "failure" },
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({ body: exact, backend: "github" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/openclaw/octopool/actions/runs?per_page=20&status=failure",
      expect.any(Object),
    );
  });

  it("prefers Actions HTML without consulting a stored API rate snapshot", async () => {
    const prepare = vi.fn(() => {
      throw new Error("stored API rate should not be read");
    });
    const fetchMock = vi.fn(async () => new Response(actionsListHTML("web first")));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
      query: { per_page: "20" },
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });

    const response = await callGitHubWeb(
      { ...env(), DB: { prepare } } as unknown as Env,
      request,
      classifyRoute(request, policy),
    );

    expect(prepare).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/openclaw/octopool/actions",
      expect.any(Object),
    );
    expect(response?.body).toMatchObject({
      workflow_runs: [{ display_title: "web first" }],
    });
  });

  it("prefers public HTML for Actions run views", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(`
            <span class="PageHeader-parentLink-label"> CI</span>
            <span class="actions-workflow-runs-status"><svg aria-label="completed successfully: "></svg></span>
            <h1 class="PageHeader-title"><span class="markdown-title">fix: harden setup</span><span>#79</span></h1>
            <span>Triggered via pull request <relative-time datetime="2026-06-11T06:38:49Z"></relative-time></span>
            <a href="/openclaw/octopool/commit/1e6a563d13924ba423febe3a4cb47eeb9d594322">1e6a563</a>
            <a class="branch-name" title="main" href="/openclaw/octopool/tree/refs/heads/main">main</a>
            <div data-job-groups-fetch-url="/openclaw/octopool/actions/runs/27328786454/job_groups_batch?attempt=2"></div>
            <span>Total duration</span><a class="h4 color-fg-default">2m 49s</a>
          `),
      ),
    );
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs/27328786454",
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({
      body: {
        id: 27328786454,
        name: "CI",
        display_title: "fix: harden setup",
        status: "completed",
        conclusion: "success",
        run_attempt: 2,
        event: "pull_request",
      },
      backend: "web",
    });
  });

  it("prefers public job metadata for shaped Actions job lists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          jobGroups: [
            {
              name: "Check",
              nonNested: {
                jobs: [
                  {
                    id: 80970314592,
                    displayName: "Check",
                    status: "completed",
                    conclusion: "success",
                    href: "/openclaw/octopool/actions/runs/27398328238/job/80970314592",
                  },
                ],
              },
            },
          ],
          totalCount: 1,
          hasMore: false,
        }),
      )
      .mockResolvedValueOnce(
        new Response(`
          <span data-url="/openclaw/octopool/runs/80970314592/header">
            succeeded
            <relative-time datetime="2026-06-12T06:17:55Z"></relative-time>
          </span>
          <check-steps data-job-status="completed">
            <check-step
              data-name="Check out"
              data-number="2"
              data-conclusion="success"
              data-started-at="2026-06-12T06:15:23Z"
              data-completed-at="2026-06-12T06:15:26Z">
            </check-step>
          </check-steps>
        `),
      );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs/27398328238/attempts/2/jobs",
      query: { per_page: "100" },
      headers: { "x-octopool-public-shape": "actions-jobs-v1" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://github.com/openclaw/octopool/actions/runs/27398328238/job_groups_batch?attempt=2",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-requested-with": "XMLHttpRequest" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://github.com/openclaw/octopool/actions/runs/27398328238/job/80970314592",
      expect.any(Object),
    );
    expect(response?.body).toEqual({
      total_count: 1,
      jobs: [
        {
          id: 80970314592,
          name: "Check",
          status: "completed",
          conclusion: "success",
          started_at: "2026-06-12T06:15:23Z",
          completed_at: "2026-06-12T06:17:55Z",
          html_url: "https://github.com/openclaw/octopool/actions/runs/27398328238/job/80970314592",
          steps: [
            {
              name: "Check out",
              number: 2,
              status: "completed",
              conclusion: "success",
              started_at: "2026-06-12T06:15:23Z",
              completed_at: "2026-06-12T06:15:26Z",
            },
          ],
        },
      ],
    });
  });

  it("keeps raw Actions job list requests on exact API responses", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("rate limited", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs/27398328238/jobs",
      query: { per_page: "100" },
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("prefers release HTML for shaped release summaries", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(`
          <nav><li class="breadcrumb-item-selected">v0.8.0</li></nav>
          <h1>0.8.0</h1>
          released this <relative-time datetime="2026-06-10T07:55:39Z"></relative-time>
          <div data-test-selector="body-content" class="markdown-body"><h2>Fixed</h2><ul><li>Use public HTML.</li></ul></div>
          </div>
          <div class="Box-footer"></div>
        `),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/releases/tags/v0.8.0",
      headers: { "x-octopool-public-shape": "release-summary-v1" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://github.com/openclaw/octopool/releases/tag/v0.8.0",
      expect.any(Object),
    );
    expect(response?.body).toMatchObject({
      tag_name: "v0.8.0",
      name: "0.8.0",
      draft: false,
      prerelease: false,
      published_at: "2026-06-10T07:55:39Z",
      body: "Fixed\n\n- Use public HTML.",
    });
  });

  it("follows relative latest-release redirects for summary HTML", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/openclaw/octopool/releases/tag/v0.8.0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(`
          <nav><li class="breadcrumb-item-selected">v0.8.0</li></nav>
          <h1>0.8.0</h1>
          released this <relative-time datetime="2026-06-10T07:55:39Z"></relative-time>
          <div data-test-selector="body-content" class="markdown-body"></div>
          </div>
          <div class="Box-footer"></div>
        `),
      );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/releases/latest",
      headers: { "x-octopool-public-shape": "release-summary-v1" },
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({
      body: { tag_name: "v0.8.0" },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://github.com/openclaw/octopool/releases/tag/v0.8.0",
      expect.any(Object),
    );
  });

  it("prefers embedded issue data for shaped issue views", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        embeddedPage("IssueViewerViewQuery", {
          issue: {
            __typename: "Issue",
            number: 5,
            title: "Sign in fails",
            body: "Public body",
            state: "CLOSED",
            url: "https://github.com/openclaw/octopool/issues/5",
            createdAt: "2026-05-27T23:17:12Z",
            updatedAt: "2026-05-27T23:19:04Z",
            author: actor("phoward38", "Patrick Howard"),
            labels: connection([]),
            assignedActors: { nodes: [] },
            milestone: null,
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/issues/5",
      headers: { "x-octopool-public-shape": "issue-summary-v1" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://github.com/openclaw/octopool/issues/5",
      expect.any(Object),
    );
    expect(response?.body).toEqual({
      number: 5,
      title: "Sign in fails",
      body: "Public body",
      state: "CLOSED",
      html_url: "https://github.com/openclaw/octopool/issues/5",
      user: {
        id: "user-phoward38",
        login: "phoward38",
        name: "Patrick Howard",
        is_bot: false,
      },
      created_at: "2026-05-27T23:17:12Z",
      updated_at: "2026-05-27T23:19:04Z",
      labels: [],
      assignees: [],
      milestone: null,
    });
  });

  it("prefers embedded PR data for shaped PR views", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        pullRequestPage({
          author: { login: "RomneyDa" },
          baseBranch: "main",
          closedTime: "2026-06-10T00:52:44Z",
          createdTime: "2026-06-03T18:13:12Z",
          headBranch: "fix/login-provisioning-guidance",
          headSha: "ef53e13233adb1af0730f8239d87149d60cb42ac",
          mergedTime: "2026-06-10T00:52:44Z",
          number: 11,
          relayId: "PR_kwDOSoyMq87iWrbq",
          state: "MERGED",
          title: "Clarify login access provisioning failures",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/pulls/11",
      headers: { "x-octopool-public-shape": "pr-summary-v1" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(response?.body).toEqual({
      number: 11,
      node_id: "PR_kwDOSoyMq87iWrbq",
      title: "Clarify login access provisioning failures",
      state: "MERGED",
      html_url: "https://github.com/openclaw/octopool/pull/11",
      created_at: "2026-06-03T18:13:12Z",
      closed_at: "2026-06-10T00:52:44Z",
      merged_at: "2026-06-10T00:52:44Z",
      head: {
        ref: "fix/login-provisioning-guidance",
        sha: "ef53e13233adb1af0730f8239d87149d60cb42ac",
      },
      base: { ref: "main" },
    });
  });

  it("prefers embedded issue and PR lists when the whole result fits", async () => {
    const issueNode = {
      __typename: "Issue",
      number: 5,
      titleHtml: "Sign in <code>fails</code>",
      state: "CLOSED",
      createdAt: "2026-05-27T23:17:12Z",
      updatedAt: "2026-05-27T23:19:04Z",
      closedAt: "2026-05-27T23:19:04Z",
      author: actor("phoward38", "Patrick Howard"),
      labels: connection([]),
      assignedActors: connection([]),
      milestone: null,
    };
    const prNode = {
      __typename: "PullRequest",
      number: 11,
      titleHTML: "Clarify login",
      pullRequestState: "MERGED",
      isDraft: false,
      createdAt: "2026-06-03T18:13:12Z",
      updatedAt: "2026-06-10T00:52:44Z",
      closedAt: "2026-06-10T00:52:44Z",
      author: actor("RomneyDa", "Dallin Romney"),
      labels: connection([]),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(issueListPage([issueNode])))
      .mockResolvedValueOnce(new Response(issueListPage([prNode])));
    vi.stubGlobal("fetch", fetchMock);
    const issueRequest = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/issues",
      query: {
        per_page: "30",
        page: "1",
        state: "all",
        creator: "phoward38",
        assignee: "steipete",
      },
      headers: { "x-octopool-public-shape": "issue-list-v1" },
    });
    const prRequest = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/pulls",
      query: { per_page: "30", state: "all" },
      headers: { "x-octopool-public-shape": "pr-list-v1" },
    });

    const issueResponse = await callGitHubWeb(
      env(),
      issueRequest,
      classifyRoute(issueRequest, policy),
    );
    const prResponse = await callGitHubWeb(env(), prRequest, classifyRoute(prRequest, policy));

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://github.com/openclaw/octopool/issues?q=is%3Aissue+author%3A%22phoward38%22+assignee%3A%22steipete%22",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://github.com/openclaw/octopool/issues?q=is%3Apr",
      expect.any(Object),
    );
    expect(issueResponse?.body).toMatchObject([
      { number: 5, title: "Sign in fails", state: "CLOSED" },
    ]);
    expect(prResponse?.body).toMatchObject([
      {
        number: 11,
        state: "MERGED",
        merged_at: "2026-06-10T00:52:44Z",
      },
    ]);
  });

  it("prefers embedded labels with GraphQL IDs and URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        embeddedPage("RepositoryLabelIndexPageQuery", {
          labels: {
            totalCount: 1,
            edges: [
              {
                node: {
                  id: "LA_bug",
                  name: "good first issue",
                  color: "7057ff",
                  description: "Good for newcomers",
                },
              },
            ],
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/labels",
      query: { per_page: "100" },
      headers: { "x-octopool-public-shape": "label-list-v1" },
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({
      body: [
        {
          id: "LA_bug",
          name: "good first issue",
          url: "https://github.com/openclaw/octopool/labels/good%20first%20issue",
        },
      ],
    });
  });

  it("paginates token-free workflow HTML and preserves workflow state/order", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          workflowPage(
            [
              [284355045, "CI", "ci.yml"],
              [283839619, "pages-build-deployment", "pages/pages-build-deployment"],
              [231435713, "Disabled", "disabled.yml", true],
            ],
            2,
          ),
        ),
      )
      .mockResolvedValueOnce(new Response(workflowPage([[284355048, "release", "release.yml"]])));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/workflows",
      query: { per_page: "100", page: "1" },
      headers: { "x-octopool-public-shape": "workflow-list-v1" },
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://github.com/openclaw/octopool/actions/workflows_partial?query=&page=2",
      expect.any(Object),
    );
    expect(response?.body).toEqual({
      total_count: 4,
      workflows: [
        { id: 284355045, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
        {
          id: 231435713,
          name: "Disabled",
          path: ".github/workflows/disabled.yml",
          state: "disabled_manually",
        },
        {
          id: 284355048,
          name: "release",
          path: ".github/workflows/release.yml",
          state: "active",
        },
        {
          id: 283839619,
          name: "pages-build-deployment",
          path: "dynamic/pages/pages-build-deployment",
          state: "active",
        },
      ],
    });
  });

  it("prefers the complete workflow list for shaped workflow views", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        workflowPage(
          [
            [284355045, "CI", "ci.yml"],
            [284355048, "release", "release.yml"],
          ],
          1,
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/workflows/ci.yml",
      headers: { "x-octopool-public-shape": "workflow-view-v1" },
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({
      body: {
        id: 284355045,
        name: "CI",
        path: ".github/workflows/ci.yml",
        state: "active",
      },
    });
  });

  it("prefers exact branch refs from Git smart HTTP", async () => {
    const sha = "e05a16c766609e722571a448f606f6820a0bf249";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(gitAdvertisement([[sha, "refs/heads/main"]]), {
          headers: { "content-type": "application/x-git-upload-pack-advertisement" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(embeddedPage("IssueIndexPageQuery", { id: "R_kgDOSoyMqw" })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/ref/heads/main",
    });

    const response = await callGitHubWeb(env(), request, classifyRoute(request, policy));

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://github.com/openclaw/octopool.git/info/refs?service=git-upload-pack",
      expect.any(Object),
    );
    expect(response?.body).toEqual({
      ref: "refs/heads/main",
      node_id: "REF_kwDOSoyMq69yZWZzL2hlYWRzL21haW4",
      url: "https://api.github.com/repos/openclaw/octopool/git/refs/heads/main",
      object: {
        sha,
        type: "commit",
        url: `https://api.github.com/repos/openclaw/octopool/git/commits/${sha}`,
      },
    });
  });

  it("falls back to the exact API response for ambiguous lightweight tags", async () => {
    const apiBody = {
      ref: "refs/tags/v1.0.0",
      node_id: "REF_exact",
      object: { sha: "0123456789012345678901234567890123456789", type: "commit" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          gitAdvertisement([["0123456789012345678901234567890123456789", "refs/tags/v1.0.0"]]),
          { headers: { "content-type": "application/x-git-upload-pack-advertisement" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(embeddedPage("IssueIndexPageQuery", { id: "R_kgDOSoyMqw" })),
      )
      .mockResolvedValueOnce(
        Response.json(apiBody, {
          headers: {
            "x-ratelimit-limit": "60",
            "x-ratelimit-remaining": "29",
            "x-ratelimit-reset": "2000000000",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/git/ref/tags/v1.0.0",
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({ body: apiBody });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://github.com/openclaw/octopool.git/info/refs?service=git-upload-pack",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.github.com/repos/openclaw/octopool/git/ref/tags/v1.0.0",
      expect.any(Object),
    );
  });

  it("rejects workflow HTML without pagination completeness proof", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(workflowPage([[284355045, "CI", "ci.yml"]])))
        .mockResolvedValueOnce(new Response("rate limited", { status: 403 })),
    );
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/workflows",
      query: { per_page: "50", page: "1" },
      headers: { "x-octopool-public-shape": "workflow-list-v1" },
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toBeUndefined();
  });

  it("does not synthesize shaped page objects for raw API requests", async () => {
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const requests = [
      "/repos/openclaw/octopool/actions/runs",
      "/repos/openclaw/octopool/releases/tags/v0.8.0",
      "/repos/openclaw/octopool/issues/5",
      "/repos/openclaw/octopool/pulls/11",
      "/repos/openclaw/octopool/issues",
      "/repos/openclaw/octopool/pulls",
      "/repos/openclaw/octopool/labels",
      "/repos/openclaw/octopool/actions/workflows",
      "/repos/openclaw/octopool/actions/workflows/ci.yml",
    ].map((path) =>
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path,
      }),
    );

    for (const request of requests) {
      await expect(
        callGitHubWeb(env(), request, classifyRoute(request, policy)),
      ).resolves.toBeUndefined();
    }
    expect(fetchMock).toHaveBeenCalledTimes(requests.length);
  });

  it("drops draft releases from web-origin release responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              { tag_name: "v0.2.5", draft: false },
              { tag_name: "draft", draft: true },
            ]),
          ),
      ),
    );
    const list = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/releases",
    });
    await expect(callGitHubWeb(env(), list, classifyRoute(list, policy))).resolves.toMatchObject({
      body: [{ tag_name: "v0.2.5", draft: false }],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ draft: true }))),
    );
    const view = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/releases/tags/draft",
    });
    await expect(callGitHubWeb(env(), view, classifyRoute(view, policy))).resolves.toBe(undefined);
  });

  it("fetches content reads without an explicit ref through the public contents API", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ name: "README.md" })));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({ body: { name: "README.md" }, backend: "github" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/openclaw/octopool/contents/README.md",
      expect.any(Object),
    );
  });

  it("uses the public contents API but skips raw extraction for unsafe refs", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ name: "README.md" })));
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      query: { ref: "../../steipete/ReleaseBar/main" },
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({ body: { name: "README.md" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls through for non-default content media accepts", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contents/README.md",
      query: { ref: "main" },
      headers: { accept: "application/vnd.github.raw" },
    });

    await expect(callGitHubWeb(env(), request, classifyRoute(request, policy))).resolves.toBe(
      undefined,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches repo metadata and branch lists through unauthenticated GitHub API reads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ full_name: "openclaw/octopool" })))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ name: "main" }])));
    vi.stubGlobal("fetch", fetchMock);
    const repo = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool",
    });
    const branches = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/branches",
      query: { per_page: "10" },
    });

    await expect(callGitHubWeb(env(), repo, classifyRoute(repo, policy))).resolves.toMatchObject({
      body: { full_name: "openclaw/octopool" },
      backend: "github",
    });
    await expect(
      callGitHubWeb(env(), branches, classifyRoute(branches, policy)),
    ).resolves.toMatchObject({
      body: [{ name: "main" }],
      backend: "github",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/openclaw/octopool/branches?per_page=10",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
  });

  it("fetches public org, user collection, gist, and repository search reads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ full_name: "openclaw/octopool" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ full_name: "openclaw/octopool" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "abc123", public: true })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ full_name: "openclaw/octopool" }] })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const searchPolicy = { ...policy, allow_search: true };
    const org = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/orgs/openclaw/repos",
      query: { type: "public", per_page: "1" },
    });
    const userRepos = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/users/openperf/repos",
      query: { per_page: "1" },
    });
    const gist = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/gists/abc123",
    });
    const search = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/search/repositories",
      query: { q: "octopool relay" },
    });

    await expect(callGitHubWeb(env(), org, classifyRoute(org, policy))).resolves.toMatchObject({
      body: [{ full_name: "openclaw/octopool" }],
    });
    await expect(
      callGitHubWeb(env(), userRepos, classifyRoute(userRepos, policy)),
    ).resolves.toMatchObject({
      body: [{ full_name: "openclaw/octopool" }],
    });
    await expect(callGitHubWeb(env(), gist, classifyRoute(gist, policy))).resolves.toMatchObject({
      body: { id: "abc123", public: true },
    });
    await expect(
      callGitHubWeb(env(), search, classifyRoute(search, searchPolicy)),
    ).resolves.toMatchObject({
      body: { items: [{ full_name: "openclaw/octopool" }] },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://api.github.com/search/repositories?q=octopool+relay",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
  });

  it("fetches additional public user and repository collection reads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ login: "steipete" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "event-1" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1, body: "comment" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 2, event: "closed" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify({ total_count: 0, check_suites: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify([[1682899200, 12]])))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ verifiable_password_authentication: true })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([{ key: "mit", name: "MIT License" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ login: "steipete" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify({ total_count: 0, users: [], teams: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ state: "success" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 123, body: "review" })));
    vi.stubGlobal("fetch", fetchMock);
    const requests = [
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/users/openperf/followers",
        query: { per_page: "1" },
      }),
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/users/openperf/events",
        query: { per_page: "1" },
      }),
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/octopool/issues/comments",
        query: { per_page: "1" },
      }),
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/networks/openclaw/octopool/events",
        query: { per_page: "1" },
      }),
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/octopool/commits/ac49d8e2295a093f168baa45312e1e29238c0351/check-suites",
      }),
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/octopool/stats/code_frequency",
      }),
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/meta",
      }),
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/licenses",
      }),
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/orgs/openclaw/public_members",
        query: { per_page: "1" },
      }),
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/octopool/pulls/12/requested_reviewers",
      }),
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/octopool/statuses/ac49d8e2295a093f168baa45312e1e29238c0351",
      }),
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/octopool/pulls/comments/123",
      }),
    ];

    for (const request of requests) {
      await expect(
        callGitHubWeb(env(), request, classifyRoute(request, policy)),
      ).resolves.toMatchObject({
        backend: "github",
      });
    }
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://api.github.com/networks/openclaw/octopool/events?per_page=1",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
  });

  it("does not serve secret gist bodies through the public web fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "abc123", public: false }))),
    );
    const gist = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/gists/abc123",
    });

    await expect(callGitHubWeb(env(), gist, classifyRoute(gist, policy))).resolves.toBe(undefined);
  });

  it("preserves GitHub pagination and rate headers on public API reads", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([{ name: "main" }]), {
          headers: {
            link: '<https://api.github.com/repositories/1/branches?page=2>; rel="next"',
            "x-ratelimit-remaining": "59",
            "x-github-request-id": "req-1",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/branches",
      query: { per_page: "1" },
      headers: { "x-github-api-version": "2024-01-01" },
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({
      headers: {
        link: '<https://api.github.com/repositories/1/branches?page=2>; rel="next"',
        "x-ratelimit-remaining": "59",
        "x-github-request-id": "req-1",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/openclaw/octopool/branches?per_page=1",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-github-api-version": "2024-01-01" }),
      }),
    );
  });

  it("returns empty successful public API responses without falling through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/contributors",
    });

    await expect(
      callGitHubWeb(env(), request, classifyRoute(request, policy)),
    ).resolves.toMatchObject({
      status: 204,
      body: null,
      body_encoding: "text",
      backend: "github",
    });
  });

  it("falls through on oversized web bodies while streaming", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(2_097_153));
                controller.close();
              },
            }),
          ),
      ),
    );
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/pulls/12",
      headers: { accept: "application/vnd.github.v3.diff" },
    });

    await expect(callGitHubWeb(env(), request, classifyRoute(request, policy))).resolves.toBe(
      undefined,
    );
  });

  it("honors the configured response cap for web reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("diff --git a/README.md b/README.md\n")),
    );
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/pulls/12",
      headers: { accept: "application/vnd.github.v3.diff" },
    });

    await expect(
      callGitHubWeb(env({ MAX_RESPONSE_BYTES: "8" }), request, classifyRoute(request, policy)),
    ).resolves.toBe(undefined);
  });
});

function env(overrides: Record<string, string> = {}): Env {
  return { REQUEST_TIMEOUT_MS: "15000", ...overrides } as unknown as Env;
}

function actionsListHTML(title: string): string {
  return `
    <strong>1 workflow run result</strong>
    <div class="Box-row js-socket-channel js-updatable-content">
      <a href="/openclaw/octopool/actions/runs/27328786454" aria-label="completed successfully: Run 79 of CI. ${title}">
        <span class="h4 markdown-title">${title}</span>
      </a>
      <span class="text-bold">CI</span> #79:
      Commit <a href="/openclaw/octopool/commit/1e6a563d13924ba423febe3a4cb47eeb9d594322">1e6a563</a>
      pushed
      <relative-time datetime="2026-06-11T06:38:49Z"></relative-time>
      <a class="branch-name" title="main" href="/openclaw/octopool/tree/refs/heads/main">main</a>
    </div>
  `;
}

function embeddedPage(queryName: string, repository: Record<string, unknown>): string {
  return `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({
    payload: {
      preloadedQueries: [{ queryName, result: { data: { repository } } }],
    },
  })}</script>`;
}

function issueListPage(nodes: Record<string, unknown>[]): string {
  return embeddedPage("IssueIndexPageQuery", {
    search: {
      edges: nodes.map((node) => ({ node })),
      issueCount: nodes.length,
      pageInfo: { hasNextPage: false },
    },
  });
}

function pullRequestPage(pullRequest: Record<string, unknown>): string {
  return `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({
    payload: {
      pullRequestsLayoutRoute: {
        pullRequest,
        repository: { ownerLogin: "openclaw", name: "octopool" },
      },
    },
  })}</script>`;
}

function gitAdvertisement(lines: [string, string][]): Uint8Array {
  const packet = (value: string): string =>
    (new TextEncoder().encode(value).byteLength + 4).toString(16).padStart(4, "0") + value;
  return new TextEncoder().encode(
    [
      packet("# service=git-upload-pack\n"),
      "0000",
      packet(`${lines[0]![0]} HEAD\0multi_ack thin-pack symref=HEAD:${lines[0]![1]}\n`),
      ...lines.map(([sha, ref]) => packet(`${sha} ${ref}\n`)),
      "0000",
    ].join(""),
  );
}

function actor(login: string, name: string): Record<string, unknown> {
  return { __typename: "User", id: `user-${login}`, login, name };
}

function connection(nodes: Record<string, unknown>[]): Record<string, unknown> {
  return {
    edges: nodes.map((node) => ({ node })),
    pageInfo: { hasNextPage: false },
  };
}

function workflowPage(
  workflows: [number, string, string, boolean?][],
  totalPages?: number,
): string {
  return `${workflows
    .map(
      ([id, name, ref, disabled]) => `
        <li data-test-selector="workflow-rendered" data-item-id="${id}">
          <tool-tip>${name}</tool-tip>
          <a href="/openclaw/octopool/actions/workflows/${ref}">${name}</a>
          ${disabled === true ? '<span class="color-fg-muted text-small">Disabled</span>' : ""}
        </li>`,
    )
    .join("")}${totalPages === undefined ? "" : `<div data-total-pages="${totalPages}"></div>`}`;
}
