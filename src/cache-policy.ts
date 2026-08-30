import type { RouteKind } from "./route-manifest";

export type CacheFreshStrategy =
  | { kind: "static"; seconds: number }
  | { kind: "pr" }
  | { kind: "issue" }
  | { kind: "run" }
  | { kind: "run_list" }
  | { kind: "jobs" }
  | { kind: "checks" }
  | { kind: "check_suites" }
  | { kind: "status" }
  | { kind: "status_list" }
  | { kind: "job" }
  | { kind: "pr_state" };

export type RouteCachePolicy = {
  fresh: CacheFreshStrategy;
  freshCapSeconds?: number;
  staleSeconds: number;
  terminalStaleSeconds?: number;
};

export function cachePolicyForRouteKind(kind: RouteKind): RouteCachePolicy {
  return {
    fresh: freshCacheStrategy(kind),
    ...(refNamedCommitRoute(kind) ? { freshCapSeconds: 120 } : {}),
    staleSeconds: staleCacheSeconds(kind),
    ...(terminalCIRoute(kind) ? { terminalStaleSeconds: 86_400 } : {}),
  };
}

export function isStateAwarePRRoute(kind: RouteKind): boolean {
  return cachePolicyForRouteKind(kind).fresh.kind === "pr_state";
}

function freshCacheStrategy(kind: RouteKind): CacheFreshStrategy {
  switch (kind) {
    case "user_view":
      return staticCache(3_600);
    case "repo_view":
    case "org_repo_list":
    case "user_repo_list":
      return staticCache(600);
    case "user_org_list":
    case "user_gist_list":
    case "user_follower_list":
    case "user_following_list":
    case "user_event_list":
    case "user_received_event_list":
    case "user_key_list":
    case "user_gpg_key_list":
    case "org_event_list":
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
    case "contents":
    case "release_view":
    case "workflow_list":
    case "workflow_view":
    case "tag_list":
    case "repo_languages":
    case "repo_contributors":
    case "repo_license":
    case "repo_topics":
    case "community_profile":
    case "fork_list":
    case "stargazer_list":
    case "subscriber_list":
    case "repo_event_list":
    case "network_event_list":
    case "deployment_list":
    case "release_assets":
    case "release_asset":
    case "repo_stats_contributors":
    case "repo_stats_commit_activity":
    case "repo_stats_code_frequency":
    case "repo_stats_participation":
    case "repo_stats_punch_card":
      return staticCache(3_600);
    case "commit_list":
    case "commit_pulls":
    case "commit_branches_where_head":
    case "compare":
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
    case "issue_comments":
    case "issue_comment_list":
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
      return staticCache(300);
    case "commit_view":
    case "git_blob":
    case "git_commit":
    case "git_tag":
    case "git_tree":
      return staticCache(86_400);
    case "release_latest":
    case "release_list":
      return staticCache(300);
    case "pr_view":
      return { kind: "pr" };
    case "pr_list":
    case "issue_list":
      return staticCache(60);
    case "issue_view":
      return { kind: "issue" };
    case "branch_list":
    case "branch_view":
    case "commit_view_ref":
    case "git_ref":
    case "git_matching_refs":
      return staticCache(120);
    case "run_view":
      return { kind: "run" };
    case "run_list":
    case "workflow_run_list":
      return { kind: "run_list" };
    case "run_jobs":
      return { kind: "jobs" };
    case "commit_check_runs":
    case "commit_check_runs_ref":
      return { kind: "checks" };
    case "commit_check_suites":
    case "commit_check_suites_ref":
      return { kind: "check_suites" };
    case "commit_status":
    case "commit_status_ref":
      return { kind: "status" };
    case "commit_statuses":
    case "commit_statuses_ref":
    case "ref_statuses":
      return { kind: "status_list" };
    case "job_view":
      return { kind: "job" };
    case "pr_files":
      return { kind: "pr_state" };
    case "search_issues":
    case "search_code":
    case "search_commits":
    case "search_repositories":
      return staticCache(120);
    case "run_artifacts":
    case "job_logs":
    case "check_run_annotations":
    case "rate_limit":
      return staticCache(60);
    case "branch_protection":
    case "repo_ruleset_list":
    case "repo_ruleset_view":
    case "branch_rules":
      return staticCache(0);
    default:
      return assertNever(kind);
  }
}

function staleCacheSeconds(kind: RouteKind): number {
  switch (kind) {
    case "run_view":
    case "run_list":
    case "workflow_run_list":
    case "run_jobs":
    case "commit_check_runs":
    case "commit_check_runs_ref":
    case "commit_check_suites":
    case "commit_check_suites_ref":
    case "commit_status":
    case "commit_status_ref":
    case "commit_statuses":
    case "commit_statuses_ref":
    case "commit_view_ref":
    case "ref_statuses":
    case "job_view":
    case "git_ref":
    case "git_matching_refs":
      return 300;
    case "pr_list":
    case "issue_list":
    case "org_repo_list":
    case "user_repo_list":
      return 600;
    case "pr_view":
    case "issue_view":
    case "pr_files":
    case "pr_commits":
    case "pr_review_comments":
    case "pr_review_comment_list":
    case "pr_review_comment_view":
    case "pr_reviews":
    case "pr_review_view":
    case "pr_review_comments_for_review":
    case "pr_requested_reviewers":
    case "commit_comments":
    case "commit_pulls":
    case "commit_branches_where_head":
    case "repo_comment":
    case "issue_comments":
    case "issue_comment_list":
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
    case "repo_event_list":
    case "network_event_list":
    case "org_event_list":
    case "deployment_list":
      return 3_600;
    case "repo_view":
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
    case "branch_list":
    case "branch_view":
    case "tag_list":
    case "repo_languages":
    case "repo_contributors":
    case "repo_license":
    case "repo_topics":
    case "community_profile":
    case "fork_list":
    case "stargazer_list":
    case "subscriber_list":
    case "commit_list":
    case "compare":
    case "contents":
    case "release_list":
    case "release_view":
    case "release_latest":
    case "release_assets":
    case "release_asset":
    case "repo_stats_contributors":
    case "repo_stats_commit_activity":
    case "repo_stats_code_frequency":
    case "repo_stats_participation":
    case "repo_stats_punch_card":
      return 7_200;
    case "commit_view":
    case "git_blob":
    case "git_commit":
    case "git_tag":
    case "git_tree":
      return 86_400;
    case "run_artifacts":
    case "job_logs":
    case "check_run_annotations":
    case "workflow_list":
    case "workflow_view":
    case "search_issues":
    case "search_code":
    case "search_commits":
    case "search_repositories":
    case "rate_limit":
      return 1_800;
    case "branch_protection":
    case "repo_ruleset_list":
    case "repo_ruleset_view":
    case "branch_rules":
      return 0;
    default:
      return assertNever(kind);
  }
}

// Ref-named commit routes re-resolve to a new SHA whenever the ref moves, so
// even "completed" CI payloads stay fresh for at most two minutes and never
// earn the terminal long-stale window.
function refNamedCommitRoute(kind: RouteKind): boolean {
  switch (kind) {
    case "commit_view_ref":
    case "commit_check_runs_ref":
    case "commit_check_suites_ref":
    case "commit_status_ref":
    case "commit_statuses_ref":
      return true;
    default:
      return false;
  }
}

function terminalCIRoute(kind: RouteKind): boolean {
  switch (kind) {
    case "run_view":
    case "run_jobs":
    case "commit_check_runs":
    case "commit_check_suites":
    case "commit_status":
    case "commit_statuses":
    case "ref_statuses":
    case "job_view":
      return true;
    default:
      return false;
  }
}

function staticCache(seconds: number): CacheFreshStrategy {
  return { kind: "static", seconds };
}

function assertNever(value: never): never {
  throw new Error(`Missing cache policy for route kind: ${String(value)}`);
}
