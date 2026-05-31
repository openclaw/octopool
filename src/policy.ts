import { HttpError, isObject } from "./http";
import type { PoolPolicy, RelayRequest, RouteInfo } from "./types";

const owner = "(?<owner>[A-Za-z0-9_.-]+)";
const repo = "(?<repo>[A-Za-z0-9_.-]+)";
const number = "[0-9]+";
const sha = "[0-9A-Fa-f]{7,64}";
const id = "[0-9]+";
const tag = "(?<tag>[^/?#]+)";

type RouteRule = {
  pattern: RegExp;
  kind: string;
  resource: string;
  cacheable: boolean;
  largePayload?: boolean;
  search?: boolean;
  logs?: boolean;
};

const rules: RouteRule[] = [
  route(`/repos/${owner}/${repo}`, "repo_view", "core"),
  route(`/repos/${owner}/${repo}/commits`, "commit_list", "core"),
  route(`/repos/${owner}/${repo}/commits/${sha}`, "commit_view", "core"),
  route(`/repos/${owner}/${repo}/compare/(?<compare>[^/?#]+)`, "compare", "core"),
  route(`/repos/${owner}/${repo}/contents/(?<contentPath>.+)`, "contents", "core"),
  route(`/repos/${owner}/${repo}/pulls/${number}`, "pr_view", "core"),
  route(`/repos/${owner}/${repo}/pulls`, "pr_list", "core"),
  route(`/repos/${owner}/${repo}/pulls/${number}/files`, "pr_files", "core"),
  route(`/repos/${owner}/${repo}/pulls/${number}/commits`, "pr_commits", "core"),
  route(`/repos/${owner}/${repo}/pulls/${number}/comments`, "pr_review_comments", "core"),
  route(`/repos/${owner}/${repo}/pulls/${number}/reviews`, "pr_reviews", "core"),
  route(`/repos/${owner}/${repo}/commits/${sha}/check-runs`, "commit_check_runs", "core"),
  route(`/repos/${owner}/${repo}/commits/${sha}/status`, "commit_status", "core"),
  route(`/repos/${owner}/${repo}/actions/runs`, "run_list", "core"),
  route(`/repos/${owner}/${repo}/actions/runs/${id}`, "run_view", "core"),
  route(`/repos/${owner}/${repo}/actions/runs/${id}/jobs`, "run_jobs", "core"),
  route(`/repos/${owner}/${repo}/actions/runs/${id}/artifacts`, "run_artifacts", "core"),
  route(`/repos/${owner}/${repo}/actions/jobs/${id}`, "job_view", "core"),
  route(`/repos/${owner}/${repo}/actions/jobs/${id}/logs`, "job_logs", "core", {
    largePayload: true,
    logs: true,
  }),
  route(`/repos/${owner}/${repo}/check-runs/${id}/annotations`, "check_run_annotations", "core"),
  route(`/repos/${owner}/${repo}/issues/${number}`, "issue_view", "core"),
  route(`/repos/${owner}/${repo}/issues`, "issue_list", "core"),
  route(`/repos/${owner}/${repo}/issues/${number}/comments`, "issue_comments", "core"),
  route(`/repos/${owner}/${repo}/issues/${number}/events`, "issue_events", "core"),
  route(`/repos/${owner}/${repo}/issues/${number}/timeline`, "issue_timeline", "core"),
  route(`/repos/${owner}/${repo}/branches/(?<branch>[^/?#]+)`, "branch_view", "core"),
  route(`/repos/${owner}/${repo}/actions/workflows`, "workflow_list", "core"),
  route(`/repos/${owner}/${repo}/actions/workflows/(?<workflow>[^/?#]+)`, "workflow_view", "core"),
  route(
    `/repos/${owner}/${repo}/actions/workflows/(?<workflow>[^/?#]+)/runs`,
    "workflow_run_list",
    "core",
  ),
  route(`/repos/${owner}/${repo}/releases`, "release_list", "core"),
  route(`/repos/${owner}/${repo}/releases/latest`, "release_latest", "core"),
  route(`/repos/${owner}/${repo}/releases/tags/${tag}`, "release_view", "core"),
  route(`/repos/${owner}/${repo}/releases/${id}`, "release_view", "core"),
  route("/search/issues", "search_issues", "search", { search: true }),
  route("/search/code", "search_code", "search", { search: true }),
  route("/search/commits", "search_commits", "search", { search: true }),
  route("/rate_limit", "rate_limit", "core"),
];

function route(
  path: string,
  kind: string,
  resource: string,
  extra: Partial<RouteRule> = {},
): RouteRule {
  return {
    pattern: new RegExp(`^${path}$`),
    kind,
    resource,
    cacheable: true,
    ...extra,
  };
}

export function defaultPolicy(owners: string): PoolPolicy {
  return {
    allowed_owners: owners
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item !== ""),
    allow_public_repos: true,
    allow_search: false,
    allow_logs: true,
  };
}

export function parsePolicy(raw: string, fallbackOwners: string): PoolPolicy {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isObject(value)) {
      return defaultPolicy(fallbackOwners);
    }
    const fallback = defaultPolicy(fallbackOwners);
    return {
      allowed_owners: Array.isArray(value.allowed_owners)
        ? value.allowed_owners
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.toLowerCase())
        : fallback.allowed_owners,
      allow_public_repos:
        typeof value.allow_public_repos === "boolean"
          ? value.allow_public_repos
          : fallback.allow_public_repos,
      allow_search:
        typeof value.allow_search === "boolean" ? value.allow_search : fallback.allow_search,
      allow_logs: typeof value.allow_logs === "boolean" ? value.allow_logs : fallback.allow_logs,
    };
  } catch {
    return defaultPolicy(fallbackOwners);
  }
}

export function validateRelayRequest(value: unknown): RelayRequest {
  if (!isObject(value)) {
    throw new HttpError(400, "invalid_request", "Request body must be an object");
  }
  const pool = requireText(value.pool, "pool");
  const method = requireText(value.method, "method").toUpperCase();
  const path = requireText(value.path, "path");
  const lowerPath = path.toLowerCase();
  if (
    !path.startsWith("/") ||
    path.includes("://") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    /(^|\/)\.{1,2}(\/|$)/.test(path) ||
    lowerPath.includes("%2e") ||
    lowerPath.includes("%5c")
  ) {
    throw new HttpError(400, "invalid_path", "Path must be an absolute GitHub API path");
  }
  if (method !== "GET") {
    throw new HttpError(403, "method_denied", "Only GET routes are enabled");
  }
  const query = normalizeQuery(value.query);
  const headers = normalizeHeaders(value.headers);
  return {
    pool,
    method,
    path,
    ...(query === undefined ? {} : { query }),
    ...(headers === undefined ? {} : { headers }),
    ...(isObject(value.route_hint) ? { route_hint: normalizeRouteHint(value.route_hint) } : {}),
    ...(typeof value.cache_key === "string" ? { cache_key: value.cache_key } : {}),
    ...(typeof value.idempotency_key === "string"
      ? { idempotency_key: value.idempotency_key }
      : {}),
  };
}

export function classifyRoute(request: RelayRequest, policy: PoolPolicy): RouteInfo {
  for (const rule of rules) {
    const match = rule.pattern.exec(request.path);
    if (match === null) {
      continue;
    }
    if (rule.search === true && !policy.allow_search) {
      throw new HttpError(403, "search_denied", "Search routes are disabled for this pool");
    }
    if (rule.logs === true && !policy.allow_logs) {
      throw new HttpError(403, "logs_denied", "Log routes are disabled for this pool");
    }
    if (rule.kind === "compare") {
      const compareRef = match.groups?.compare;
      let decodedCompareRef = compareRef;
      try {
        decodedCompareRef = compareRef === undefined ? undefined : decodeURIComponent(compareRef);
      } catch {
        throw new HttpError(400, "invalid_path", "Path must be a valid GitHub API path");
      }
      if (decodedCompareRef?.includes(":") === true) {
        throw new HttpError(403, "route_denied", "Cross-repository compare routes are not enabled");
      }
    }
    const searchRepo = rule.search === true ? repoFromSearchQuery(request.query) : undefined;
    const routeOwner = (match.groups?.owner ?? searchRepo?.owner)?.toLowerCase();
    const allowedOwner = routeOwner === undefined || policy.allowed_owners.includes(routeOwner);
    if (routeOwner !== undefined && !allowedOwner && !policy.allow_public_repos) {
      throw new HttpError(403, "owner_denied", `Owner ${routeOwner} is not allowed for this pool`);
    }
    const routeRepo = match.groups?.repo ?? searchRepo?.repo;
    const info: RouteInfo = {
      kind: rule.kind,
      resource: rule.resource,
      routeKey: normalizeRouteKey(request.method, request.path),
      publicOnly: !allowedOwner,
      cacheable: rule.cacheable,
      largePayload: rule.largePayload === true,
      logs: rule.logs === true,
    };
    if (routeOwner !== undefined) {
      info.owner = routeOwner;
    }
    if (routeRepo !== undefined) {
      info.repo = routeRepo;
    }
    return info;
  }
  throw new HttpError(403, "route_denied", "Route is not enabled");
}

function repoFromSearchQuery(query: Record<string, string | string[]> | undefined): {
  owner: string;
  repo: string;
} {
  const q = query?.q;
  if (typeof q !== "string") {
    throw new HttpError(403, "search_denied", "Search routes require a repo-scoped q query");
  }
  const tokens = q.trim().split(/\s+/).filter(Boolean);
  const matches = tokens
    .map((token) => /^repo:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(token))
    .filter((match): match is RegExpExecArray => match !== null);
  if (matches.length !== 1 || matches[0]?.[1] === undefined || matches[0]?.[2] === undefined) {
    throw new HttpError(403, "search_denied", "Search routes require exactly one repo qualifier");
  }
  for (const token of tokens) {
    if (token.startsWith("repo:")) {
      continue;
    }
    if (/^type:(issue|pr)$/.test(token) || /^state:(open|closed)$/.test(token)) {
      continue;
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(token) || token.toUpperCase() === "OR") {
      throw new HttpError(403, "search_denied", "Search routes only allow plain repo-scoped terms");
    }
  }
  return { owner: matches[0][1], repo: matches[0][2] };
}

export function normalizeRouteKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path
    .replace(/\/pulls\/[0-9]+/g, "/pulls/:number")
    .replace(/\/issues\/[0-9]+/g, "/issues/:number")
    .replace(/\/comments\/[0-9]+/g, "/comments/:id")
    .replace(/\/commits\/[0-9A-Fa-f]{7,64}/g, "/commits/:sha")
    .replace(/\/actions\/runs\/[0-9]+/g, "/actions/runs/:id")
    .replace(/\/actions\/jobs\/[0-9]+/g, "/actions/jobs/:id")
    .replace(/\/check-runs\/[0-9]+/g, "/check-runs/:id")
    .replace(/\/actions\/workflows\/[^/]+\/runs/g, "/actions/workflows/:workflow/runs")
    .replace(/\/actions\/workflows\/[^/]+/g, "/actions/workflows/:workflow")}`;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "invalid_request", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeQuery(value: unknown): Record<string, string | string[]> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new HttpError(400, "invalid_query", "query must be an object");
  }
  const out: Record<string, string | string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!safeQueryKey(key)) {
      throw new HttpError(400, "invalid_query", `query key ${key} is not allowed`);
    }
    if (typeof raw === "string") {
      out[key] = raw;
    } else if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
      out[key] = raw;
    } else {
      throw new HttpError(
        400,
        "invalid_query",
        `query value ${key} must be a string or string array`,
      );
    }
  }
  return out;
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new HttpError(400, "invalid_headers", "headers must be an object");
  }
  const allowed = new Set(["accept", "x-github-api-version", "if-none-match", "if-modified-since"]);
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (!allowed.has(lower)) {
      continue;
    }
    if (typeof raw === "string" && raw.length <= 512) {
      out[lower] = raw;
    }
  }
  return out;
}

function normalizeRouteHint(
  value: Record<string, unknown>,
): NonNullable<RelayRequest["route_hint"]> {
  const hint: NonNullable<RelayRequest["route_hint"]> = {};
  if (typeof value.owner === "string") {
    hint.owner = value.owner;
  }
  if (typeof value.repo === "string") {
    hint.repo = value.repo;
  }
  if (typeof value.kind === "string") {
    hint.kind = value.kind;
  }
  if (typeof value.pr_head_sha === "string" && /^[0-9a-fA-F]{40}$/.test(value.pr_head_sha)) {
    hint.pr_head_sha = value.pr_head_sha.toLowerCase();
  }
  if (typeof value.pr_state === "string" && /^(open|closed|merged)$/i.test(value.pr_state)) {
    hint.pr_state = value.pr_state.toLowerCase();
  }
  return hint;
}

function safeQueryKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    /^[a-z0-9_.-]+$/.test(lower) &&
    !lower.includes("token") &&
    !lower.includes("secret") &&
    !lower.includes("password") &&
    !lower.includes("passwd") &&
    !lower.includes("api_key") &&
    !lower.includes("apikey") &&
    !lower.includes("access_key") &&
    !lower.includes("private_key")
  );
}
