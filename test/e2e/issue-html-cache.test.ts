import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, rateHeaders, relay, seedPool } from "./harness";

const repositoryURL = "https://github.com/openclaw/octopool";
const issue = {
  __typename: "Issue",
  number: 7,
  title: "Public issue",
  titleHtml: "Public issue",
  body: "# Raw Markdown\r\n\r\n- tight\r\n- list\r\n\r\n[reference]: /public\r\n",
  state: "OPEN",
  url: `${repositoryURL}/issues/7`,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z",
  closedAt: null,
  author: { __typename: "User", id: "U_public", login: "public", name: "Public" },
  labels: { nodes: [], pageInfo: { hasNextPage: false } },
  assignedActors: { nodes: [] },
};

describe.each([
  { name: "view", path: "/repos/openclaw/octopool/issues/7", shape: "issue-summary-v1" },
  { name: "list", path: "/repos/openclaw/octopool/issues", shape: "issue-list-v1" },
])("public issue $name HTML", ({ name, path, shape }) => {
  beforeEach(async () => {
    await seedPool();
    await env.DB.prepare("UPDATE identities SET status = 'disabled'").run();
  });

  it("serves and refreshes its documented fields when APIs are depleted", async () => {
    let title = issue.title;
    let pageReads = 0;
    const requests: Request[] = [];
    mockGitHub(() => {
      pageReads++;
      return issuePage(name, { ...issue, title, titleHtml: title });
    }, requests);
    const headers = { "x-octopool-public-shape": shape };
    const first = await relay(path, undefined, { headers });
    expect(first.status).toBe(200);
    const envelope = await first.json<{ body: unknown; relay: { cache: string } }>();
    const firstIssue = Array.isArray(envelope.body) ? envelope.body[0] : envelope.body;
    expect(firstIssue).toMatchObject({ number: 7, title, labels: [], state: "OPEN" });
    if (name === "view") expect(firstIssue).toHaveProperty("body", issue.body);
    expect(firstIssue).not.toHaveProperty("assignees");
    expect(firstIssue).not.toHaveProperty("milestone");
    expect(envelope.relay.cache).toBe("miss");
    const cached = await (await relay(path, undefined, { headers })).json();
    expect(cached).toMatchObject({ body: envelope.body, relay: { cache: "hit" } });
    expect(pageReads).toBe(1);

    title = "Updated public issue";
    const fresh = await (
      await relay(path, undefined, { headers: { ...headers, "cache-control": "max-age=0" } })
    ).json<{ body: unknown; relay: { cache: string } }>();
    expect(Array.isArray(fresh.body) ? fresh.body[0] : fresh.body).toMatchObject({ title });
    expect(fresh.relay.cache).not.toBe("hit");
    expect(pageReads).toBe(2);
    expect(
      requests
        .filter((request) => request.url.startsWith("https://github.com/"))
        .every((request) => !request.headers.has("authorization")),
    ).toBe(true);
    expect(
      requests.filter(
        (request) =>
          request.url.startsWith("https://api.github.com/") &&
          new URL(request.url).pathname !== "/repos/openclaw/octopool",
      ),
    ).toEqual([]);
  });

  it.each([undefined, { hasNextPage: true }])(
    "still refuses labels whose completeness is unproven (%j)",
    async (pageInfo) => {
      mockGitHub(() => issuePage(name, { ...issue, labels: { nodes: [], pageInfo } }));
      const response = await relay(path, undefined, {
        headers: { "x-octopool-public-shape": shape },
      });
      expect(response.ok).toBe(false);
      expect(
        await env.DB.prepare("SELECT count(*) AS n FROM github_cache_entries").first(),
      ).toEqual({ n: 0 });
    },
  );

  it("does not substitute the summary for an unshaped REST request", async () => {
    mockGitHub(() => issuePage(name, issue));
    expect((await relay(path)).ok).toBe(false);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM github_cache_entries").first()).toEqual({
      n: 0,
    });
  });
});

function issuePage(kind: string, node: Record<string, unknown>): string {
  const queryName = kind === "view" ? "IssueViewerViewQuery" : "IssueIndexPageQuery";
  const repository =
    kind === "view"
      ? { issue: node }
      : {
          search: { edges: [{ node }], issueCount: 1, pageInfo: { hasNextPage: false } },
        };
  return `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({
    payload: { preloadedQueries: [{ queryName, result: { data: { repository } } }] },
  })}</script>`;
}

function mockGitHub(page: () => string, requests: Request[] = []): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.hostname === "api.github.com") {
        return jsonResponse(
          { message: "API rate limit exceeded" },
          429,
          rateHeaders({ remaining: 0, retryAfter: 60 }),
        );
      }
      expect(url.origin).toBe("https://github.com");
      if (url.pathname === "/openclaw/octopool") {
        return new Response('<meta name="octolytics-dimension-repository_public" content="true">');
      }
      expect(url.pathname).toMatch(/^\/openclaw\/octopool\/issues(?:\/7)?$/);
      return new Response(page());
    }),
  );
}
