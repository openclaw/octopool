import { isLandingGraphQLRoute } from "./github-public-shapes";
import { isRecord } from "./object";
import { parseSQLiteTimestamp } from "./sqlite-time";
import type { GitHubRelayResponse, RouteInfo } from "./types";
import type { RouteKind } from "./route-manifest";

export const SWR_WINDOW_SECONDS = 60;

const TERMINAL_CI_TTL_SECONDS = 21_600;
const TERMINAL_CI_TTL_DETECTION_SECONDS = 1_800;

export function cacheResponseEligible(kind: RouteKind, status: number): boolean {
  if (status < 200 || status >= 300) return false;
  if (status !== 202) return true;
  switch (kind) {
    case "repo_stats_contributors":
    case "repo_stats_commit_activity":
    case "repo_stats_code_frequency":
    case "repo_stats_participation":
    case "repo_stats_punch_card":
      return false;
    default:
      return true;
  }
}

type CacheFreshStrategy =
  | { kind: "static"; seconds: number }
  | { kind: "pr" }
  | { kind: "issue" }
  | { kind: "run" }
  | { kind: "run_list" }
  | { kind: "jobs" }
  | { kind: "mutable_ci" }
  | { kind: "job" }
  | { kind: "pr_state" };

type RouteCachePolicy = {
  fresh: CacheFreshStrategy;
  freshCapSeconds?: number;
  staleSeconds: number;
  terminalStaleSeconds?: number;
};

export function cachePolicyForRouteKind(kind: RouteKind): RouteCachePolicy {
  const { swr: _swr, ...policy } = routeCachePolicy(kind);
  return policy;
}

export function supportsStaleWhileRevalidate(kind: RouteKind): boolean {
  return routeCachePolicy(kind).swr === true;
}

export function withinSWRWindow(expiresAt: string): boolean {
  const expiredFor = Date.now() - parseSQLiteTimestamp(expiresAt);
  return expiredFor >= 0 && expiredFor < SWR_WINDOW_SECONDS * 1000;
}

export function isStateAwarePRRoute(kind: RouteKind): boolean {
  return cachePolicyForRouteKind(kind).fresh.kind === "pr_state";
}

export function isMutableCIRoute(kind: RouteKind): boolean {
  return routeCachePolicy(kind).fresh.kind === "mutable_ci";
}

function routeCachePolicy(kind: RouteKind): RouteCachePolicy & { swr?: true } {
  switch (kind) {
    case "user_view":
    case "user_org_list":
    case "user_gist_list":
    case "user_follower_list":
    case "user_following_list":
    case "user_event_list":
    case "user_received_event_list":
    case "user_key_list":
    case "user_gpg_key_list":
    case "org_public_member_list":
    case "org_public_member_view":
    case "gist_view":
    case "emoji_list":
    case "github_meta":
    case "license_list":
    case "license_view":
    case "gitignore_template_list":
    case "gitignore_template_view":
    case "repo_readme":
    case "release_view":
    case "tag_list":
    case "repo_languages":
    case "repo_contributors":
    case "repo_license":
    case "repo_topics":
    case "community_profile":
    case "fork_list":
    case "stargazer_list":
    case "subscriber_list":
    case "release_assets":
    case "release_asset":
    case "repo_stats_contributors":
    case "repo_stats_commit_activity":
    case "repo_stats_code_frequency":
    case "repo_stats_participation":
    case "repo_stats_punch_card":
      return { fresh: staticCache(3_600), staleSeconds: 7_200 };
    case "contents":
      return { fresh: staticCache(3_600), staleSeconds: 7_200, swr: true };
    case "repo_view":
      return { fresh: staticCache(600), staleSeconds: 7_200 };
    case "org_repo_list":
    case "user_repo_list":
      return { fresh: staticCache(600), staleSeconds: 600 };
    case "org_event_list":
    case "repo_event_list":
    case "network_event_list":
    case "deployment_list":
      return { fresh: staticCache(3_600), staleSeconds: 3_600 };
    case "workflow_list":
    case "workflow_view":
      return { fresh: staticCache(3_600), staleSeconds: 1_800 };
    case "commit_list":
    case "compare":
    case "release_latest":
    case "release_list":
      return { fresh: staticCache(300), staleSeconds: 7_200 };
    case "commit_pulls":
    case "commit_branches_where_head":
    case "pr_commits":
    case "pr_review_comments":
    case "pr_review_comment_list":
    case "pr_review_comment_view":
    case "pr_reviews":
    case "pr_review_view":
    case "pr_review_comments_for_review":
    case "pr_requested_reviewers":
    case "commit_comments":
    case "repo_comment":
    case "issue_comment_view":
    case "issue_events":
    case "issue_event_list":
    case "issue_event_view":
    case "issue_labels":
    case "issue_timeline":
    case "label_list":
    case "label_view":
    case "milestone_list":
    case "milestone_view":
    case "issue_reactions":
    case "issue_comment_reactions":
    case "pr_review_comment_reactions":
    case "assignee_list":
    case "assignee_view":
      return { fresh: staticCache(300), staleSeconds: 3_600 };
    case "issue_comments":
    case "issue_comment_list":
      return { fresh: staticCache(300), staleSeconds: 3_600, swr: true };
    case "commit_view":
    case "git_blob":
    case "git_commit":
    case "git_tag":
    case "git_tree":
      return { fresh: staticCache(86_400), staleSeconds: 86_400 };
    case "pr_view":
      return { fresh: { kind: "pr" }, staleSeconds: 3_600, swr: true };
    case "pr_list":
    case "issue_list":
      return { fresh: staticCache(60), staleSeconds: 600 };
    case "issue_view":
      return { fresh: { kind: "issue" }, staleSeconds: 3_600 };
    case "branch_list":
    case "branch_view":
      return { fresh: staticCache(120), staleSeconds: 7_200 };
    // Ref-named commits re-resolve when refs move; cap freshness and omit terminal stale reuse.
    case "commit_view_ref":
      return { fresh: staticCache(120), staleSeconds: 300, freshCapSeconds: 120 };
    case "git_ref":
    case "git_matching_refs":
      return { fresh: staticCache(120), staleSeconds: 300 };
    case "run_view":
      return { fresh: { kind: "run" }, staleSeconds: 300, terminalStaleSeconds: 86_400, swr: true };
    case "run_list":
    case "workflow_run_list":
      return { fresh: { kind: "run_list" }, staleSeconds: 300, swr: true };
    case "run_jobs":
      return {
        fresh: { kind: "jobs" },
        staleSeconds: 300,
        terminalStaleSeconds: 86_400,
        swr: true,
      };
    case "commit_check_runs":
    case "commit_check_suites":
    case "check_suite_view":
    case "check_suite_check_runs":
    case "commit_status":
    case "commit_statuses":
      return { fresh: { kind: "mutable_ci" }, staleSeconds: 300, swr: true };
    case "commit_check_runs_ref":
    case "commit_check_suites_ref":
    case "commit_status_ref":
    case "commit_statuses_ref":
      return { fresh: { kind: "mutable_ci" }, staleSeconds: 300, freshCapSeconds: 120, swr: true };
    case "ref_statuses":
      return { fresh: { kind: "mutable_ci" }, staleSeconds: 300 };
    case "job_view":
      return { fresh: { kind: "job" }, staleSeconds: 300, terminalStaleSeconds: 86_400, swr: true };
    case "pr_files":
      return { fresh: { kind: "pr_state" }, staleSeconds: 3_600, swr: true };
    case "search_issues":
    case "search_code":
    case "search_commits":
    case "search_repositories":
      return { fresh: staticCache(120), staleSeconds: 1_800 };
    case "run_artifacts":
    case "job_logs":
    case "check_run_annotations":
    case "rate_limit":
      return { fresh: staticCache(60), staleSeconds: 1_800 };
    case "graphql_read":
      return { fresh: staticCache(60), staleSeconds: 0 };
    case "branch_protection":
    case "repo_ruleset_list":
    case "repo_ruleset_view":
    case "branch_rules":
      return { fresh: staticCache(0), staleSeconds: 0 };
    default:
      return assertNever(kind);
  }
}

function staticCache(seconds: number): CacheFreshStrategy {
  return { kind: "static", seconds };
}

function assertNever(value: never): never {
  throw new Error(`Missing cache policy for route kind: ${String(value)}`);
}

export function cacheTTLSeconds(route: RouteInfo, response?: GitHubRelayResponse): number {
  if (isLandingGraphQLRoute(route)) return 60;
  const policy = cachePolicyForRouteKind(route.kind);
  const seconds = freshTTLSeconds(policy.fresh, route, response);
  return policy.freshCapSeconds === undefined ? seconds : Math.min(policy.freshCapSeconds, seconds);
}

function freshTTLSeconds(
  strategy: CacheFreshStrategy,
  route: RouteInfo,
  response?: GitHubRelayResponse,
): number {
  switch (strategy.kind) {
    case "static":
      return strategy.seconds;
    case "pr":
      if (isRecord(response?.body) && typeof response.body.merged_at === "string") return 3_600;
      return ageScaledTTLSeconds(
        response,
        120,
        isRecord(response?.body) && response.body.state === "closed" ? 3_600 : 300,
      );
    case "issue":
      return closedIssue(response) ? 3_600 : 300;
    case "run":
      if (!completedResponse(response)) return 60;
      return route.run_attempt !== undefined
        ? TERMINAL_CI_TTL_SECONDS
        : ageScaledTTLSeconds(response, 60, 600);
    case "run_list":
      return completedCollection(response, "workflow_runs") ? 120 : 60;
    case "jobs":
      return route.run_attempt_completed === true && completedCollection(response, "jobs")
        ? TERMINAL_CI_TTL_SECONDS
        : 60;
    case "mutable_ci":
      return settledCITTLSeconds(route, response);
    case "job":
      return completedResponse(response) ? TERMINAL_CI_TTL_SECONDS : 60;
    case "pr_state":
      return stateAwarePRSubresource(route, response) ? 300 : 60;
  }
}

export function staleCacheSeconds(route: RouteInfo, freshTtlSeconds?: number): number {
  if (isLandingGraphQLRoute(route)) return 0;
  const policy = cachePolicyForRouteKind(route.kind);
  if (
    policy.terminalStaleSeconds !== undefined &&
    freshTtlSeconds !== undefined &&
    freshTtlSeconds >= TERMINAL_CI_TTL_DETECTION_SECONDS
  ) {
    return policy.terminalStaleSeconds;
  }
  return policy.staleSeconds;
}

function ageScaledTTLSeconds(
  response: GitHubRelayResponse | undefined,
  minimum: number,
  maximum: number,
): number {
  const updatedAt = isRecord(response?.body) ? response.body.updated_at : undefined;
  return ageScaledTimestampTTLSeconds(updatedAt, minimum, maximum);
}

function ageScaledTimestampTTLSeconds(
  updatedAt: unknown,
  minimum: number,
  maximum: number,
): number {
  const updatedAtMs = typeof updatedAt === "string" ? Date.parse(updatedAt) : NaN;
  if (!Number.isFinite(updatedAtMs)) return minimum;
  // Re-runs, reopened PRs, and new edits remain possible; cap reuse even for old objects.
  const ageSeconds = (Date.now() - updatedAtMs) / 1_000;
  return Math.max(minimum, Math.min(maximum, Math.floor(ageSeconds * 0.1)));
}

function settledCITTLSeconds(route: RouteInfo, response?: GitHubRelayResponse): number {
  const body = response?.body;
  let items: unknown;
  let checks = false;
  switch (route.kind) {
    case "commit_check_runs":
    case "commit_check_runs_ref":
    case "check_suite_check_runs":
      items = isRecord(body) ? body.check_runs : undefined;
      checks = true;
      break;
    case "commit_check_suites":
    case "commit_check_suites_ref":
      items = isRecord(body) ? body.check_suites : undefined;
      checks = true;
      break;
    case "check_suite_view":
      items = [body];
      checks = true;
      break;
    case "commit_status":
    case "commit_status_ref":
      if (!isRecord(body) || !settledStatus(body.state)) return 60;
      items = body.statuses;
      break;
    default:
      items = body;
  }
  if (!Array.isArray(items) || items.length === 0) return 60;
  let newest = -Infinity;
  for (const item of items) {
    if (!isRecord(item) || (checks ? item.status !== "completed" : !settledStatus(item.state)))
      return 60;
    const timestamps = [item.completed_at, item.updated_at].filter(
      (value) => value !== undefined && value !== null,
    );
    if (timestamps.length === 0) return 60;
    for (const timestamp of timestamps) {
      const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
      if (!Number.isFinite(parsed)) return 60;
      newest = Math.max(newest, parsed);
    }
  }
  // New checks and reruns remain possible for the same SHA or suite after completion.
  return ageScaledTimestampTTLSeconds(new Date(newest).toISOString(), 60, 300);
}

function settledStatus(state: unknown): boolean {
  return state === "success" || state === "failure" || state === "error";
}

function closedIssue(response?: GitHubRelayResponse): boolean {
  return (
    isRecord(response?.body) &&
    (response.body.state === "closed" || response.body.state === "CLOSED")
  );
}

function completedResponse(response?: GitHubRelayResponse): boolean {
  return isRecord(response?.body) && response.body.status === "completed";
}

function completedCollection(response: GitHubRelayResponse | undefined, key: string): boolean {
  if (!isRecord(response?.body) || !Array.isArray(response.body[key])) {
    return false;
  }
  const items = response.body[key];
  return items.length > 0 && items.every((item) => isRecord(item) && item.status === "completed");
}

function stateAwarePRSubresource(route: RouteInfo, response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body) && !Array.isArray(response?.body)) {
    return false;
  }
  return route.state_hint !== undefined && route.state_hint_source === "live";
}
