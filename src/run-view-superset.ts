import { defaultGitHubJSONAccept, transformedGitHubHeaders } from "./github-response";
import { isRecord } from "./object";
import type { CachedGitHubResponse } from "./cache";
import type { RelayRequest, RouteInfo } from "./types";

// The shared REST workflow-run schema plus the optional fields present in exact
// run views. Incomplete list examples and public-page summaries cannot supply it.
const RUN_FIELDS = [
  "id",
  "node_id",
  "name",
  "head_branch",
  "head_sha",
  "path",
  "display_title",
  "run_number",
  "event",
  "status",
  "conclusion",
  "workflow_id",
  "check_suite_id",
  "check_suite_node_id",
  "url",
  "html_url",
  "pull_requests",
  "created_at",
  "updated_at",
  "actor",
  "run_attempt",
  "referenced_workflows",
  "run_started_at",
  "triggering_actor",
  "jobs_url",
  "logs_url",
  "check_suite_url",
  "artifacts_url",
  "cancel_url",
  "rerun_url",
  "previous_attempt_url",
  "workflow_url",
  "head_commit",
  "repository",
  "head_repository",
] as const;

const LIST_FILTERS = new Set([
  "actor",
  "branch",
  "event",
  "status",
  "page",
  "per_page",
  "created",
  "check_suite_id",
  "head_sha",
]);

export function exactRunListQuery(json: string): boolean {
  let query: unknown;
  try {
    query = JSON.parse(json);
  } catch {
    return false;
  }
  return (
    isRecord(query) &&
    Object.entries(query).every(
      ([key, value]) =>
        typeof value === "string" &&
        value !== "" &&
        (LIST_FILTERS.has(key) || (key === "exclude_pull_requests" && value === "false")),
    )
  );
}

export function runViewListLookup(request: RelayRequest, route: RouteInfo) {
  if (
    route.kind !== "run_view" ||
    route.run_attempt !== undefined ||
    Object.keys(request.query ?? {}).length !== 0 ||
    request.headers?.["x-octopool-public-shape"] !== undefined ||
    !defaultGitHubJSONAccept(request.headers?.accept)
  )
    return undefined;
  const match = /^(\/repos\/[^/]+\/[^/]+)\/actions\/runs\/([1-9][0-9]*)$/.exec(request.path);
  if (match === null || !Number.isSafeInteger(Number(match[2]))) return undefined;
  return { repoPath: match[1]!.toLowerCase(), runId: Number(match[2]) };
}

export function projectRunListItem(
  cached: CachedGitHubResponse,
  path: string,
  runId: number,
): CachedGitHubResponse | undefined {
  if (
    cached.status !== 200 ||
    cached.body_encoding !== "json" ||
    !isRecord(cached.body) ||
    !Array.isArray(cached.body.workflow_runs) ||
    cached.body.workflow_runs.length > 100
  )
    return undefined;
  const matches = cached.body.workflow_runs.filter((run) => isRecord(run) && run.id === runId);
  const run = matches[0];
  if (
    matches.length !== 1 ||
    !isRecord(run) ||
    !RUN_FIELDS.every((field) => Object.hasOwn(run, field)) ||
    typeof run.url !== "string" ||
    run.url.toLowerCase() !== `https://api.github.com${path}`.toLowerCase() ||
    !Array.isArray(run.referenced_workflows)
  )
    return undefined;
  return { ...cached, body: run, headers: transformedGitHubHeaders(cached.headers) };
}
