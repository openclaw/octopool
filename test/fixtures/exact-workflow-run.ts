// Same field set as the REST workflow-run schema and the equal list/view objects
// checked in docs/cache.md. Keep nullable/optional REST fields explicit.
export function exactWorkflowRun(id = 42, repo = "openclaw/run-view-fixture") {
  const url = `https://api.github.com/repos/${repo}/actions/runs/${id}`;
  const repository = {
    id: 1,
    full_name: repo,
    html_url: `https://github.com/${repo}`,
    private: false,
  };
  const actor = { id: 2, login: "fixture-user" };
  return {
    id,
    node_id: `WFR_${id}`,
    name: "CI",
    head_branch: "main",
    head_sha: "a".repeat(40),
    path: ".github/workflows/ci.yml",
    display_title: "Synthetic test run",
    run_number: 10,
    event: "push",
    status: "in_progress",
    conclusion: null,
    workflow_id: 12,
    check_suite_id: 13,
    check_suite_node_id: "CS_13",
    url,
    html_url: `https://github.com/${repo}/actions/runs/${id}`,
    pull_requests: [],
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    actor,
    run_attempt: 2,
    referenced_workflows: [
      { path: "fixture/build.yml@main", sha: "b".repeat(40), ref: "refs/heads/main" },
    ],
    run_started_at: "2026-09-01T00:00:00Z",
    triggering_actor: actor,
    jobs_url: `${url}/jobs`,
    logs_url: `${url}/logs`,
    check_suite_url: `https://api.github.com/repos/${repo}/check-suites/13`,
    artifacts_url: `${url}/artifacts`,
    cancel_url: `${url}/cancel`,
    rerun_url: `${url}/rerun`,
    previous_attempt_url: `${url}/attempts/1`,
    workflow_url: `https://api.github.com/repos/${repo}/actions/workflows/12`,
    head_commit: { id: "a".repeat(40), message: "Synthetic commit" },
    repository,
    head_repository: repository,
  };
}
