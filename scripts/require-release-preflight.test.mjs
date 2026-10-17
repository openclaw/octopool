import assert from "node:assert/strict";
import test from "node:test";
import { requireReleasePreflight } from "./require-release-preflight.mjs";

function fixture() {
  const context = {
    repo: { owner: "example", repo: "cli" },
    payload: { repository: { default_branch: "main" } },
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    sha: "a".repeat(40),
  };
  const run = {
    id: 42,
    head_sha: context.sha,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
  };
  const smoke = { name: "CLI to Worker release smoke", conclusion: "success" };
  const jobs = [{ name: "Worker checks", conclusion: "success", steps: [smoke] }];
  const github = {
    rest: {
      actions: {
        listWorkflowRuns: async (query) => {
          assert.equal(query.event, "workflow_dispatch");
          assert.equal(query.workflow_id, "ci.yml");
          return { data: { workflow_runs: [run] } };
        },
        listJobsForWorkflowRun: async () => ({ data: { total_count: 1, jobs } }),
      },
      git: {
        getRef: async () => ({ data: { object: { type: "tag", sha: "b".repeat(40) } } }),
        getTag: async () => ({ data: { object: { type: "commit", sha: "a".repeat(40) } } }),
      },
    },
  };
  return { context, github, run, smoke, version: "1.2.3", dryRun: true };
}

test("accepts exact-main manual CI with a successful networked smoke", async () => {
  assert.equal(await requireReleasePreflight(fixture()), 42);
});
test("rejects a push-only success without manual release CI", async () => {
  const input = fixture();
  input.github.rest.actions.listWorkflowRuns = async () => ({ data: { workflow_runs: [] } });
  await assert.rejects(requireReleasePreflight(input), /Successful manual CI/);
});
test("rejects a skipped smoke even when the workflow is green", async () => {
  const input = fixture();
  input.smoke.conclusion = "skipped";
  await assert.rejects(requireReleasePreflight(input), /smoke must pass/);
});
test("rejects manual CI from a different source commit", async () => {
  const input = fixture();
  input.run.head_sha = "c".repeat(40);
  await assert.rejects(requireReleasePreflight(input), /Successful manual CI/);
});
test("resolves an annotated tag to the exact preflight commit", async () => {
  const input = fixture();
  input.context.eventName = "push";
  input.context.ref = "refs/tags/v1.2.3";
  input.context.sha = "b".repeat(40);
  assert.equal(await requireReleasePreflight(input), 42);
});
test("live dispatch checks the existing tag instead of newer main", async () => {
  const input = fixture();
  input.dryRun = false;
  input.context.sha = "c".repeat(40);
  assert.equal(await requireReleasePreflight(input), 42);
  input.run.head_sha = input.context.sha;
  await assert.rejects(requireReleasePreflight(input), /Successful manual CI/);
});
test("rehearsal checks main without resolving a historical tag", async () => {
  const input = fixture();
  input.github.rest.git.getRef = async () => {
    throw new Error("must not resolve a tag");
  };
  assert.equal(await requireReleasePreflight(input), 42);
});
test("live dispatch without a tag checks the current main commit", async () => {
  const input = fixture();
  input.dryRun = false;
  input.github.rest.git.getRef = async () => {
    throw Object.assign(new Error("missing"), { status: 404 });
  };
  assert.equal(await requireReleasePreflight(input), 42);
});
