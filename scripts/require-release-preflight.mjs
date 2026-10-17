export async function requireReleasePreflight({ github, context, version, dryRun }) {
  const repository = context.repo;
  const defaultBranch = context.payload.repository.default_branch;
  let target = context.sha;
  const tagPush = context.eventName === "push";
  if (tagPush && !context.ref.startsWith("refs/tags/v")) throw new Error("Expected a version tag");
  if (!tagPush && context.ref !== `refs/heads/${defaultBranch}`) {
    throw new Error("Releases must dispatch from the default branch");
  }
  if (tagPush || !dryRun) {
    if (!tagPush && !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
      throw new Error("Expected a release version");
    }
    const tagRef = tagPush
      ? context.ref.slice("refs/".length)
      : `tags/v${version.replace(/^v/, "")}`;
    let ref;
    try {
      ({ data: ref } = await github.rest.git.getRef({ ...repository, ref: tagRef }));
    } catch (error) {
      if (tagPush || error.status !== 404) throw error;
    }
    if (ref) {
      if (ref.object.type !== "tag") throw new Error("Release tag must be annotated");
      const { data: tag } = await github.rest.git.getTag({
        ...repository,
        tag_sha: ref.object.sha,
      });
      if (tag.object.type !== "commit")
        throw new Error("Release tag must point directly to a commit");
      target = tag.object.sha;
      if (tagPush && ![target, ref.object.sha].includes(context.sha))
        throw new Error("Release tag moved");
    }
  }
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...repository,
    workflow_id: "ci.yml",
    event: "workflow_dispatch",
    head_sha: target,
    per_page: 100,
  });
  const run = data.workflow_runs.find(
    (candidate) => candidate.head_sha === target && candidate.head_branch === defaultBranch,
  );
  if (!run || run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(`Successful manual CI is required on ${target}`);
  }
  const { data: jobs } = await github.rest.actions.listJobsForWorkflowRun({
    ...repository,
    run_id: run.id,
    filter: "latest",
    per_page: 100,
  });
  if (jobs.total_count > jobs.jobs.length) throw new Error("Incomplete CI job inventory");
  const worker = jobs.jobs.find((job) => job.name === "Worker checks");
  const smoke = worker?.steps.find((step) => step.name === "CLI to Worker release smoke");
  if (worker?.conclusion !== "success" || smoke?.conclusion !== "success") {
    throw new Error("Manual CLI to Worker release smoke must pass");
  }
  return run.id;
}
