type RouteResource = "core" | "search";

type RouteOptions = {
  cacheable?: boolean;
  largePayload?: boolean;
  search?: boolean;
  logs?: boolean;
  publicApi?: boolean;
  fallback?: RouteFallback;
};

export type RouteFallback = "pool" | "github_public" | "local";

export type RouteCapabilities = {
  publicApi: boolean;
  fallback: RouteFallback;
  anonymousRepoProof: boolean;
};

type RouteRule<Kind extends string> = {
  id: string;
  template: string;
  routeKeyTemplate: string;
  example: string;
  pattern: RegExp;
  kind: Kind;
  resource: RouteResource;
  cacheable: boolean;
  largePayload: boolean;
  search: boolean;
  logs: boolean;
  capabilities: RouteCapabilities;
};

const routeParameters = {
  owner: "[A-Za-z0-9_.-]+",
  repo: "[A-Za-z0-9_.-]+",
  org: "[A-Za-z0-9_.-]+",
  login: "[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\\[bot\\]|%5[Bb]bot%5[Dd])?",
  number: "[0-9]+",
  sha: "[0-9A-Fa-f]{7,64}",
  // Branch/tag names for commit endpoints that also accept refs upstream. Kept
  // disjoint from sha without lookaheads (the Go allowlist uses RE2): all-hex
  // values of SHA length stay on the sha routes and their long TTLs.
  commitRef: "(?:[0-9A-Fa-f]{1,6}|[0-9A-Fa-f]{65,}|[^/?#]*[^/?#0-9A-Fa-f][^/?#]*)",
  id: "[0-9]+",
  attempt: "[0-9]+",
  tag: "[^/?#]+",
  gistId: "[0-9A-Fa-f]+",
  slug: "[A-Za-z0-9_.-]+",
  template: "[^/?#]+",
  compare: "[^/?#]+",
  contentPath: ".+",
  readmeDir: ".+",
  label: "[^/?#]+",
  branch: "[^/?#]+",
  gitRef: ".+",
  workflow: "[^/?#]+",
} as const;

const routeParameterExamples: Record<RouteParameter, string> = {
  owner: "openclaw",
  repo: "octopool",
  org: "openclaw",
  login: "octocat",
  number: "42",
  sha: "0123456789abcdef0123456789abcdef01234567",
  commitRef: "main",
  id: "42",
  attempt: "2",
  tag: "v1.2.3",
  gistId: "abc123",
  slug: "mit",
  template: "Go",
  compare: "main...feature",
  contentPath: "src/index.ts",
  readmeDir: "docs",
  label: "bug",
  branch: "main",
  gitRef: "heads/main",
  workflow: "ci.yml",
};

type RouteParameter = keyof typeof routeParameters;

function route<const Kind extends string>(
  template: string,
  kind: Kind,
  resource: RouteResource = "core",
  options: RouteOptions = {},
): RouteRule<Kind> {
  return {
    id: `${kind}:${template}`,
    template,
    routeKeyTemplate: normalizeRouteKeyTemplate(template),
    example: routeExample(template),
    pattern: compileRoutePattern(template),
    kind,
    resource,
    cacheable: options.cacheable ?? true,
    largePayload: options.largePayload ?? false,
    search: options.search ?? false,
    logs: options.logs ?? false,
    capabilities: {
      publicApi: options.publicApi ?? true,
      fallback: options.fallback ?? "pool",
      anonymousRepoProof:
        template.includes("{owner}") && template.includes("{repo}") && resource !== "search",
    },
  };
}

function localRoute<const Kind extends string>(
  template: string,
  kind: Kind,
  resource: RouteResource = "core",
  options: RouteOptions = {},
): RouteRule<Kind> {
  return route(template, kind, resource, { ...options, fallback: "local" });
}

// These exact reads retain the caller's GitHub permissions and response shape.
// Unlike localRoute, they must never try an anonymous backend or shared cache.
function nativeReadRoute<const Kind extends string>(template: string, kind: Kind): RouteRule<Kind> {
  return route(template, kind, "core", {
    publicApi: false,
    fallback: "local",
    cacheable: false,
  });
}

export function isNativeReadRoute(route: { capabilities: RouteCapabilities }): boolean {
  return !route.capabilities.publicApi && route.capabilities.fallback === "local";
}

// These responses can include cross-repository references visible only to a token.
export function isIssueEventRoute(kind: RouteKind): boolean {
  return ["issue_timeline", "issue_events", "issue_event_list", "issue_event_view"].includes(kind);
}

function normalizeRouteKeyTemplate(template: string): string {
  return template
    .replace(/^\/users\/\{login\}/, "/users/:login")
    .replace(/^\/orgs\/\{org\}/, "/orgs/:org")
    .replace(/\/gists\/\{gistId\}/g, "/gists/:id")
    .replace(/\/pulls\/\{number\}/g, "/pulls/:number")
    .replace(/\/issues\/\{number\}/g, "/issues/:number")
    .replace(/\/comments\/\{id\}/g, "/comments/:id")
    .replace(/\/commits\/\{sha\}/g, "/commits/:sha")
    .replace(/\/commits\/\{commitRef\}/g, "/commits/:ref")
    .replace(/\/actions\/runs\/\{id\}/g, "/actions/runs/:id")
    .replace(/\/attempts\/\{attempt\}/g, "/attempts/:attempt")
    .replace(/\/actions\/jobs\/\{id\}/g, "/actions/jobs/:id")
    .replace(/\/check-runs\/\{id\}/g, "/check-runs/:id")
    .replace(/\/milestones\/\{id\}/g, "/milestones/:id")
    .replace(/\/git\/(blobs|commits|tags|trees)\/\{sha\}/g, "/git/$1/:sha")
    .replace(/\/git\/ref\/\{gitRef\}/g, "/git/ref/:ref")
    .replace(/\/git\/matching-refs\/\{gitRef\}/g, "/git/matching-refs/:ref")
    .replace(/\/actions\/workflows\/\{workflow\}\/runs/g, "/actions/workflows/:workflow/runs")
    .replace(/\/actions\/workflows\/\{workflow\}/g, "/actions/workflows/:workflow")
    .replace(/\/releases\/assets\/\{id\}/g, "/releases/assets/:id")
    .replace(/\/releases\/\{id\}/g, "/releases/:id");
}

export function routeKeyForMatch(
  method: string,
  route: RouteManifestEntry,
  match: RegExpExecArray,
): string {
  const path = route.routeKeyTemplate.replace(
    /\{([A-Za-z][A-Za-z0-9]*)\}/g,
    (_token, name: string) => {
      const value = match.groups?.[name];
      if (value === undefined) {
        throw new Error(`Missing ${name} route parameter for ${route.id}`);
      }
      return value;
    },
  );
  return `${method.toUpperCase()} ${path}`;
}

function routeExample(template: string): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_token, rawName: string) => {
    const example = routeParameterExamples[rawName as RouteParameter];
    if (example === undefined) {
      throw new Error(`Unknown route parameter: ${rawName}`);
    }
    return example;
  });
}

function compileRoutePattern(template: string): RegExp {
  const source = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_token, rawName: string) => {
    const name = rawName as RouteParameter;
    const pattern = routeParameters[name];
    if (pattern === undefined) {
      throw new Error(`Unknown route parameter: ${rawName}`);
    }
    return `(?<${name}>${pattern})`;
  });
  if (/\{[A-Za-z]/.test(source)) {
    throw new Error(`Invalid route template: ${template}`);
  }
  return new RegExp(`^${source}$`);
}

export const ROUTES = [
  route("/users/{login}", "user_view", "core", {
    publicApi: false,
    fallback: "github_public",
  }),
  localRoute("/users/{login}/repos", "user_repo_list"),
  localRoute("/users/{login}/orgs", "user_org_list"),
  localRoute("/users/{login}/gists", "user_gist_list"),
  localRoute("/users/{login}/followers", "user_follower_list"),
  localRoute("/users/{login}/following", "user_following_list"),
  localRoute("/users/{login}/events", "user_event_list"),
  localRoute("/users/{login}/received_events", "user_received_event_list"),
  localRoute("/users/{login}/keys", "user_key_list"),
  localRoute("/users/{login}/gpg_keys", "user_gpg_key_list"),
  localRoute("/orgs/{org}/repos", "org_repo_list"),
  localRoute("/orgs/{org}/events", "org_event_list"),
  localRoute("/orgs/{org}/public_members", "org_public_member_list"),
  localRoute("/orgs/{org}/public_members/{login}", "org_public_member_view"),
  localRoute("/gists/{gistId}", "gist_view"),
  localRoute("/emojis", "emoji_list"),
  localRoute("/meta", "github_meta"),
  localRoute("/licenses", "license_list"),
  localRoute("/licenses/{slug}", "license_view"),
  localRoute("/gitignore/templates", "gitignore_template_list"),
  localRoute("/gitignore/templates/{template}", "gitignore_template_view"),
  route("/repos/{owner}/{repo}", "repo_view"),
  route("/repos/{owner}/{repo}/commits", "commit_list"),
  route("/repos/{owner}/{repo}/commits/{sha}", "commit_view"),
  route("/repos/{owner}/{repo}/commits/{commitRef}", "commit_view_ref"),
  route("/repos/{owner}/{repo}/commits/{sha}/comments", "commit_comments"),
  route("/repos/{owner}/{repo}/commits/{sha}/pulls", "commit_pulls"),
  route("/repos/{owner}/{repo}/commits/{sha}/branches-where-head", "commit_branches_where_head"),
  route("/repos/{owner}/{repo}/commits/{sha}/statuses", "commit_statuses"),
  route("/repos/{owner}/{repo}/commits/{commitRef}/statuses", "commit_statuses_ref"),
  route("/repos/{owner}/{repo}/comments/{id}", "repo_comment"),
  route("/repos/{owner}/{repo}/compare/{compare}", "compare"),
  route("/repos/{owner}/{repo}/contents/{contentPath}", "contents"),
  route("/repos/{owner}/{repo}/readme", "repo_readme"),
  route("/repos/{owner}/{repo}/readme/{readmeDir}", "repo_readme"),
  route("/repos/{owner}/{repo}/pulls/{number}", "pr_view"),
  route("/repos/{owner}/{repo}/pulls", "pr_list"),
  route("/repos/{owner}/{repo}/pulls/{number}/files", "pr_files"),
  route("/repos/{owner}/{repo}/pulls/{number}/commits", "pr_commits"),
  route("/repos/{owner}/{repo}/pulls/{number}/comments", "pr_review_comments"),
  route("/repos/{owner}/{repo}/pulls/comments", "pr_review_comment_list"),
  route("/repos/{owner}/{repo}/pulls/comments/{id}", "pr_review_comment_view"),
  route("/repos/{owner}/{repo}/pulls/comments/{id}/reactions", "pr_review_comment_reactions"),
  route("/repos/{owner}/{repo}/pulls/{number}/reviews", "pr_reviews"),
  route("/repos/{owner}/{repo}/pulls/{number}/reviews/{id}", "pr_review_view"),
  route(
    "/repos/{owner}/{repo}/pulls/{number}/reviews/{id}/comments",
    "pr_review_comments_for_review",
  ),
  route("/repos/{owner}/{repo}/pulls/{number}/requested_reviewers", "pr_requested_reviewers"),
  route("/repos/{owner}/{repo}/commits/{sha}/check-runs", "commit_check_runs"),
  route("/repos/{owner}/{repo}/commits/{commitRef}/check-runs", "commit_check_runs_ref"),
  route("/repos/{owner}/{repo}/commits/{sha}/check-suites", "commit_check_suites"),
  route("/repos/{owner}/{repo}/commits/{commitRef}/check-suites", "commit_check_suites_ref"),
  route("/repos/{owner}/{repo}/commits/{sha}/status", "commit_status"),
  route("/repos/{owner}/{repo}/commits/{commitRef}/status", "commit_status_ref"),
  route("/repos/{owner}/{repo}/statuses/{sha}", "ref_statuses"),
  route("/repos/{owner}/{repo}/actions/runs", "run_list"),
  route("/repos/{owner}/{repo}/actions/runs/{id}", "run_view"),
  route("/repos/{owner}/{repo}/actions/runs/{id}/attempts/{attempt}", "run_view"),
  route("/repos/{owner}/{repo}/actions/runs/{id}/jobs", "run_jobs"),
  route("/repos/{owner}/{repo}/actions/runs/{id}/attempts/{attempt}/jobs", "run_jobs"),
  route("/repos/{owner}/{repo}/actions/runs/{id}/artifacts", "run_artifacts"),
  route("/repos/{owner}/{repo}/actions/jobs/{id}", "job_view"),
  route("/repos/{owner}/{repo}/actions/jobs/{id}/logs", "job_logs", "core", {
    largePayload: true,
    logs: true,
    publicApi: false,
  }),
  route("/repos/{owner}/{repo}/check-runs/{id}/annotations", "check_run_annotations"),
  route("/repos/{owner}/{repo}/issues/{number}", "issue_view"),
  route("/repos/{owner}/{repo}/issues", "issue_list"),
  route("/repos/{owner}/{repo}/issues/{number}/comments", "issue_comments"),
  route("/repos/{owner}/{repo}/issues/comments", "issue_comment_list"),
  route("/repos/{owner}/{repo}/issues/comments/{id}", "issue_comment_view"),
  route("/repos/{owner}/{repo}/issues/comments/{id}/reactions", "issue_comment_reactions"),
  localRoute("/repos/{owner}/{repo}/issues/{number}/events", "issue_events"),
  localRoute("/repos/{owner}/{repo}/issues/events", "issue_event_list"),
  localRoute("/repos/{owner}/{repo}/issues/events/{id}", "issue_event_view"),
  route("/repos/{owner}/{repo}/issues/{number}/labels", "issue_labels"),
  route("/repos/{owner}/{repo}/issues/{number}/reactions", "issue_reactions"),
  localRoute("/repos/{owner}/{repo}/issues/{number}/timeline", "issue_timeline"),
  route("/repos/{owner}/{repo}/assignees", "assignee_list"),
  route("/repos/{owner}/{repo}/assignees/{login}", "assignee_view"),
  route("/repos/{owner}/{repo}/labels", "label_list"),
  route("/repos/{owner}/{repo}/labels/{label}", "label_view"),
  route("/repos/{owner}/{repo}/milestones", "milestone_list"),
  route("/repos/{owner}/{repo}/milestones/{id}", "milestone_view"),
  route("/repos/{owner}/{repo}/branches", "branch_list"),
  route("/repos/{owner}/{repo}/branches/{branch}", "branch_view"),
  nativeReadRoute("/repos/{owner}/{repo}/branches/{branch}/protection", "branch_protection"),
  nativeReadRoute(
    "/repos/{owner}/{repo}/branches/{branch}/protection/enforce_admins",
    "branch_protection",
  ),
  nativeReadRoute(
    "/repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks",
    "branch_protection",
  ),
  nativeReadRoute(
    "/repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks/contexts",
    "branch_protection",
  ),
  nativeReadRoute(
    "/repos/{owner}/{repo}/branches/{branch}/protection/required_pull_request_reviews",
    "branch_protection",
  ),
  nativeReadRoute(
    "/repos/{owner}/{repo}/branches/{branch}/protection/required_signatures",
    "branch_protection",
  ),
  nativeReadRoute(
    "/repos/{owner}/{repo}/branches/{branch}/protection/restrictions",
    "branch_protection",
  ),
  nativeReadRoute(
    "/repos/{owner}/{repo}/branches/{branch}/protection/restrictions/apps",
    "branch_protection",
  ),
  nativeReadRoute(
    "/repos/{owner}/{repo}/branches/{branch}/protection/restrictions/teams",
    "branch_protection",
  ),
  nativeReadRoute(
    "/repos/{owner}/{repo}/branches/{branch}/protection/restrictions/users",
    "branch_protection",
  ),
  nativeReadRoute("/repos/{owner}/{repo}/rulesets", "repo_ruleset_list"),
  nativeReadRoute("/repos/{owner}/{repo}/rulesets/{id}", "repo_ruleset_view"),
  nativeReadRoute("/repos/{owner}/{repo}/rules/branches/{branch}", "branch_rules"),
  route("/repos/{owner}/{repo}/tags", "tag_list"),
  route("/repos/{owner}/{repo}/languages", "repo_languages"),
  route("/repos/{owner}/{repo}/contributors", "repo_contributors"),
  route("/repos/{owner}/{repo}/license", "repo_license"),
  route("/repos/{owner}/{repo}/topics", "repo_topics"),
  route("/repos/{owner}/{repo}/community/profile", "community_profile"),
  route("/repos/{owner}/{repo}/forks", "fork_list"),
  route("/repos/{owner}/{repo}/stargazers", "stargazer_list"),
  route("/repos/{owner}/{repo}/subscribers", "subscriber_list"),
  route("/repos/{owner}/{repo}/deployments", "deployment_list"),
  route("/repos/{owner}/{repo}/events", "repo_event_list"),
  route("/networks/{owner}/{repo}/events", "network_event_list"),
  route("/repos/{owner}/{repo}/stats/contributors", "repo_stats_contributors"),
  route("/repos/{owner}/{repo}/stats/commit_activity", "repo_stats_commit_activity"),
  route("/repos/{owner}/{repo}/stats/code_frequency", "repo_stats_code_frequency"),
  route("/repos/{owner}/{repo}/stats/participation", "repo_stats_participation"),
  route("/repos/{owner}/{repo}/stats/punch_card", "repo_stats_punch_card"),
  route("/repos/{owner}/{repo}/git/blobs/{sha}", "git_blob"),
  route("/repos/{owner}/{repo}/git/commits/{sha}", "git_commit"),
  route("/repos/{owner}/{repo}/git/tags/{sha}", "git_tag"),
  route("/repos/{owner}/{repo}/git/trees/{sha}", "git_tree"),
  route("/repos/{owner}/{repo}/git/ref/{gitRef}", "git_ref"),
  route("/repos/{owner}/{repo}/git/matching-refs/{gitRef}", "git_matching_refs"),
  route("/repos/{owner}/{repo}/actions/workflows", "workflow_list"),
  route("/repos/{owner}/{repo}/actions/workflows/{workflow}", "workflow_view"),
  route("/repos/{owner}/{repo}/actions/workflows/{workflow}/runs", "workflow_run_list"),
  localRoute("/repos/{owner}/{repo}/releases", "release_list"),
  localRoute("/repos/{owner}/{repo}/releases/latest", "release_latest"),
  localRoute("/repos/{owner}/{repo}/releases/tags/{tag}", "release_view"),
  localRoute("/repos/{owner}/{repo}/releases/{id}", "release_view"),
  localRoute("/repos/{owner}/{repo}/releases/{id}/assets", "release_assets"),
  localRoute("/repos/{owner}/{repo}/releases/assets/{id}", "release_asset"),
  route("/search/issues", "search_issues", "search", { search: true }),
  route("/search/code", "search_code", "search", { search: true, publicApi: false }),
  route("/search/commits", "search_commits", "search", { search: true }),
  localRoute("/search/repositories", "search_repositories", "search", { search: true }),
  route("/rate_limit", "rate_limit", "core", { publicApi: false, cacheable: false }),
] as const;

export type RouteKind = (typeof ROUTES)[number]["kind"];
export type RouteManifestEntry = (typeof ROUTES)[number];

const capabilitiesByKind = new Map<RouteKind, RouteCapabilities>();
for (const route of ROUTES) {
  const existing = capabilitiesByKind.get(route.kind);
  if (existing !== undefined && !sameCapabilities(existing, route.capabilities)) {
    throw new Error(`Inconsistent capabilities for route kind: ${route.kind}`);
  }
  capabilitiesByKind.set(route.kind, route.capabilities);
}

export function capabilitiesForRouteKind(kind: RouteKind): RouteCapabilities {
  const capabilities = capabilitiesByKind.get(kind);
  if (capabilities === undefined) {
    throw new Error(`Unknown route kind: ${kind}`);
  }
  return capabilities;
}

function sameCapabilities(left: RouteCapabilities, right: RouteCapabilities): boolean {
  return (
    left.publicApi === right.publicApi &&
    left.fallback === right.fallback &&
    left.anonymousRepoProof === right.anonymousRepoProof
  );
}
