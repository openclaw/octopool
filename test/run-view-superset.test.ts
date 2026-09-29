import { expect, it } from "vitest";
import { exactRunListQuery, projectRunListItem, runViewListLookup } from "../src/run-view-superset";
import { classifyRoute, defaultPolicy } from "../src/policy";
import { sanitizeGitHubResponse } from "../src/github-sanitize";
import type { CachedGitHubResponse } from "../src/cache";
import type { RelayRequest } from "../src/types";
import { exactWorkflowRun } from "./fixtures/exact-workflow-run";

const run = exactWorkflowRun();
const path = "/repos/openclaw/run-view-fixture/actions/runs/42";
const request: RelayRequest = { pool: "maintainers", method: "GET", path };
const route = classifyRoute(request, defaultPolicy("openclaw"));
const cached: CachedGitHubResponse = {
  status: 200,
  body_encoding: "json",
  body: { total_count: 1, workflow_runs: [run] },
  headers: {
    etag: '"list"',
    link: "next",
    "content-length": "100",
    "last-modified": "old",
    "content-type": "application/json",
  },
  created_at: "2026-09-29 00:00:00",
  expires_at: "2026-09-29 00:01:00",
};

it("allows only scalar list filters that preserve individual run objects", () => {
  expect(
    exactRunListQuery(
      JSON.stringify({
        branch: "main",
        event: "push",
        status: "completed",
        head_sha: run.head_sha,
        exclude_pull_requests: "false",
      }),
    ),
  ).toBe(true);
  for (const query of [
    { exclude_pull_requests: "true" },
    { unknown: "true" },
    { branch: ["main"] },
    { page: 1 },
    [],
  ])
    expect(exactRunListQuery(JSON.stringify(query))).toBe(false);
  expect(exactRunListQuery("invalid")).toBe(false);
});

it("projects the whole sanitized REST object without reconstructing or discarding fields", () => {
  const body = { ...run, extra_future_field: { keep: true }, head_repository_id: 9 };
  const list = sanitizeGitHubResponse(
    { ...route, kind: "run_list" },
    { ...cached, body: { workflow_runs: [body] } },
  );
  const projected = projectRunListItem({ ...cached, ...list }, path, 42);
  expect(projected).toEqual({
    ...cached,
    body: sanitizeGitHubResponse(route, { ...cached, body }).body,
    headers: { "content-type": "application/json" },
  });
});

it.each(Object.keys(run))("refuses incomplete list items missing %s", (field) => {
  const incomplete: Record<string, unknown> = { ...run };
  delete incomplete[field];
  expect(
    projectRunListItem({ ...cached, body: { workflow_runs: [incomplete] } }, path, 42),
  ).toBeUndefined();
});

it.each(
  [
    [],
    [run, run],
    [{ ...run, id: 43 }],
    [{ ...run, url: run.url.replace("openclaw", "other") }],
  ].map((runs) => ({ runs })),
)("rejects missing, duplicate, or mismatched runs $runs", ({ runs }) => {
  expect(
    projectRunListItem({ ...cached, body: { workflow_runs: runs } }, path, 42),
  ).toBeUndefined();
});

it("recognizes only plain exact run views", () => {
  expect(runViewListLookup(request, route)).toEqual({
    repoPath: "/repos/openclaw/run-view-fixture",
    runId: 42,
  });
  for (const changed of [
    { ...request, path: `${path}/attempts/1` },
    { ...request, query: { exclude_pull_requests: "true" } },
    { ...request, headers: { "x-octopool-public-shape": "actions-summary-v1" } },
    { ...request, headers: { accept: "application/vnd.github.raw" } },
    { ...request, path: path.replace("42", "9007199254740992") },
  ])
    expect(
      runViewListLookup(changed, classifyRoute(changed, defaultPolicy("openclaw"))),
    ).toBeUndefined();
});
