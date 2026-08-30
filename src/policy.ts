import { HttpError } from "./http";
import { isPublicIssueSearchQuery, PUBLIC_SHAPES } from "./github-public-shapes";
import { isRecord } from "./object";
import {
  isNativeReadRoute,
  ROUTES,
  routeKeyForMatch,
  type RouteManifestEntry,
} from "./route-manifest";
import type { PoolPolicy, RelayRequest, RouteInfo } from "./types";

type RouteRule = RouteManifestEntry;

const rules = ROUTES;

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
    if (!isRecord(value)) {
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
  if (!isRecord(value)) {
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
    ...(isRecord(value.route_hint) ? { route_hint: normalizeRouteHint(value.route_hint) } : {}),
  };
}

export function classifyRoute(request: RelayRequest, policy: PoolPolicy): RouteInfo {
  for (const rule of rules) {
    const match = rule.pattern.exec(request.path);
    if (match === null) {
      continue;
    }
    if (isNativeReadRoute(rule) && match.groups?.branch !== undefined) {
      validateNativeReadBranch(match.groups.branch);
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
    const searchRepo = searchRepoForRule(rule, request.query);
    const tokenFreeOnly = !policy.allow_search && tokenFreeSearchRequest(rule, request, searchRepo);
    if (rule.search === true && !policy.allow_search && !tokenFreeOnly) {
      throw new HttpError(403, "search_denied", "Search routes are disabled for this pool");
    }
    if (rule.kind === "search_repositories" && !policy.allow_public_repos) {
      throw new HttpError(
        403,
        "search_denied",
        "Repository search routes require public repository pooling",
      );
    }
    if (rule.kind === "org_repo_list") {
      validateOrgRepoListQuery(request.query);
    } else if (rule.kind === "user_repo_list") {
      validateUserRepoListQuery(request.query);
    }
    const routeOwner = (
      match.groups?.owner ??
      match.groups?.org ??
      (rule.kind === "user_repo_list" ? match.groups?.login : undefined) ??
      searchRepo?.owner
    )?.toLowerCase();
    const allowedOwner = routeOwner === undefined || policy.allowed_owners.includes(routeOwner);
    if (routeOwner !== undefined && !allowedOwner && !policy.allow_public_repos) {
      throw new HttpError(403, "owner_denied", `Owner ${routeOwner} is not allowed for this pool`);
    }
    const routeRepo = match.groups?.repo ?? searchRepo?.repo;
    const rawRunAttempt = match.groups?.attempt;
    const runAttempt = rawRunAttempt === undefined ? undefined : Number(rawRunAttempt);
    const info: RouteInfo = {
      kind: rule.kind,
      resource: rule.resource,
      routeKey: routeKeyForMatch(request.method, rule, match),
      ...(tokenFreeOnly ? { tokenFreeOnly: true } : {}),
      ...(runAttempt !== undefined && Number.isSafeInteger(runAttempt) && runAttempt > 0
        ? { run_attempt: runAttempt }
        : {}),
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

function validateNativeReadBranch(raw: string): void {
  let branch: string;
  try {
    branch = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "invalid_path", "Invalid branch parameter");
  }
  if (
    branch.includes("\0") ||
    /[\\\t\r\n?#%{}:*[\]]/.test(branch) ||
    branch.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new HttpError(400, "invalid_path", "Invalid branch parameter");
  }
}

function tokenFreeSearchRequest(
  rule: RouteRule,
  request: RelayRequest,
  searchRepo: { owner: string; repo: string } | undefined,
): boolean {
  return (
    rule.kind === "search_issues" &&
    request.headers?.["x-octopool-public-shape"] === PUBLIC_SHAPES.issueSearch &&
    searchRepo !== undefined &&
    isPublicIssueSearchQuery(request.query, searchRepo.owner, searchRepo.repo)
  );
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

function searchRepoForRule(
  rule: RouteRule,
  query: Record<string, string | string[]> | undefined,
): { owner: string; repo: string } | undefined {
  if (rule.search !== true) {
    return undefined;
  }
  if (rule.kind === "search_repositories") {
    validateRepositorySearchQuery(query);
    return undefined;
  }
  return repoFromSearchQuery(query);
}

function validateUserRepoListQuery(query: Record<string, string | string[]> | undefined): void {
  const type = query?.type;
  if (type === undefined || type === "owner") {
    return;
  }
  throw new HttpError(403, "route_denied", "User repository lists only allow owner repositories");
}

function validateOrgRepoListQuery(query: Record<string, string | string[]> | undefined): void {
  const type = query?.type;
  if (type === undefined || type === "public") {
    return;
  }
  throw new HttpError(
    403,
    "route_denied",
    "Organization repository lists only allow public repositories",
  );
}

function validateRepositorySearchQuery(query: Record<string, string | string[]> | undefined): void {
  const q = query?.q;
  if (typeof q !== "string") {
    throw new HttpError(403, "search_denied", "Repository search routes require a q query");
  }
  const tokens = q.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new HttpError(403, "search_denied", "Repository search routes require plain terms");
  }
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (
      token.startsWith("-") ||
      !/^[A-Za-z0-9_.-]+$/.test(token) ||
      upper === "OR" ||
      upper === "NOT"
    ) {
      throw new HttpError(403, "search_denied", "Repository search only allows plain terms");
    }
  }
}

export function normalizeRouteKey(method: string, path: string): string {
  for (const route of rules) {
    const match = route.pattern.exec(path);
    if (match !== null) {
      return routeKeyForMatch(method, route, match);
    }
  }
  return `${method.toUpperCase()} ${path}`;
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
  if (!isRecord(value)) {
    throw new HttpError(400, "invalid_query", "query must be an object");
  }
  const out: Record<string, string | string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!safeQueryKey(key)) {
      throw new HttpError(400, "invalid_query", "query key is not allowed");
    }
    if (typeof raw === "string") {
      out[key] = raw;
    } else if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
      out[key] = raw;
    } else {
      throw new HttpError(400, "invalid_query", "query value must be a string or string array");
    }
  }
  return out;
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new HttpError(400, "invalid_headers", "headers must be an object");
  }
  const allowed = new Set([
    "accept",
    "x-github-api-version",
    "if-none-match",
    "if-modified-since",
    "cache-control",
    "x-octopool-public-shape",
  ]);
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
