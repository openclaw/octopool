import { isRecord } from "./object";
import type { GitHubRelayResponse, RouteInfo } from "./types";

export function sanitizeGitHubResponse(
  route: RouteInfo,
  response: GitHubRelayResponse,
): GitHubRelayResponse {
  if (route.kind === "repo_view" && isRecord(response.body)) {
    return { ...response, body: sanitizeRepoView(response.body) };
  }
  if (route.kind === "user_view" && isRecord(response.body)) {
    return { ...response, body: sanitizeUserView(response.body) };
  }
  return { ...response, body: stripTokenScopedGitHubFields(response.body) };
}

function sanitizeRepoView(input: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set([
    "id",
    "node_id",
    "name",
    "full_name",
    "owner",
    "private",
    "html_url",
    "description",
    "fork",
    "url",
    "homepage",
    "language",
    "forks_count",
    "stargazers_count",
    "watchers_count",
    "size",
    "default_branch",
    "open_issues_count",
    "is_template",
    "topics",
    "visibility",
    "archived",
    "disabled",
    "license",
    "pushed_at",
    "created_at",
    "updated_at",
    "clone_url",
    "ssh_url",
    "git_url",
    "svn_url",
    "mirror_url",
    "has_issues",
    "has_projects",
    "has_downloads",
    "has_wiki",
    "has_pages",
    "has_discussions",
    "network_count",
    "subscribers_count",
    "organization",
  ]);
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (allowed.has(key)) {
      body[key] = stripTokenScopedGitHubFields(value);
    }
  }
  return body;
}

function sanitizeUserView(input: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set([
    "login",
    "id",
    "node_id",
    "avatar_url",
    "gravatar_id",
    "url",
    "html_url",
    "followers_url",
    "following_url",
    "gists_url",
    "starred_url",
    "subscriptions_url",
    "organizations_url",
    "repos_url",
    "events_url",
    "received_events_url",
    "type",
    "site_admin",
    "name",
    "company",
    "blog",
    "location",
    "email",
    "hireable",
    "bio",
    "twitter_username",
    "public_repos",
    "public_gists",
    "followers",
    "following",
    "created_at",
    "updated_at",
  ]);
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (allowed.has(key)) {
      body[key] = stripTokenScopedGitHubFields(value);
    }
  }
  return body;
}

function stripTokenScopedGitHubFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripTokenScopedGitHubFields);
  }
  if (!isRecord(value)) {
    return value;
  }
  const repoObject = isGitHubRepoObject(value);
  if (repoObject && value.private !== false) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (tokenScopedGitHubField(key, repoObject)) {
      continue;
    }
    out[key] = stripTokenScopedGitHubFields(item);
  }
  return out;
}

function isGitHubRepoObject(value: Record<string, unknown>): boolean {
  return (
    typeof value.full_name === "string" &&
    typeof value.html_url === "string" &&
    typeof value.private === "boolean"
  );
}

function tokenScopedGitHubField(key: string, repoObject: boolean): boolean {
  return (
    key === "temp_clone_token" || (repoObject && (key === "permissions" || key === "role_name"))
  );
}
