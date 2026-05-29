import { hashToken } from "./auth";
import { queries } from "./generated/sql";
import type { GitHubRelayResponse, Identity, RelayRequest, RouteInfo } from "./types";

type CacheRow = {
  status: number;
  response_headers_json: string;
  body_json: string;
  body_encoding: "json" | "text" | "base64";
  identity_id: string | null;
  identity_kind: "pat" | "github_app" | null;
  created_at: string;
};

export type CachedGitHubResponse = GitHubRelayResponse & {
  identity?: Pick<Identity, "id" | "kind">;
  created_at: string;
};

export async function githubCacheKey(
  pool: string,
  request: RelayRequest,
  route: RouteInfo,
): Promise<string> {
  const stable = {
    pool,
    method: request.method,
    path: request.path,
    query: normalizedCacheQuery(request.query ?? {}),
    headers: stableRecord(cacheVaryHeaders(request.headers)),
    route_key: route.routeKey,
    state: cacheStateDiscriminator(route),
  };
  return hashToken(JSON.stringify(stable));
}

export function shouldUseGitHubCache(request: RelayRequest, route: RouteInfo): boolean {
  if (!route.cacheable || route.logs || route.largePayload || route.kind === "rate_limit") {
    return false;
  }
  const headers = request.headers ?? {};
  return headers["if-none-match"] === undefined && headers["if-modified-since"] === undefined;
}

export async function readGitHubCache(
  env: Env,
  cacheKey: string,
): Promise<CachedGitHubResponse | undefined> {
  const row = await env.DB.prepare(queries.readGitHubCache).bind(cacheKey).first<CacheRow>();
  if (row === null) {
    return undefined;
  }
  return {
    status: row.status,
    headers: parseJSONRecord(row.response_headers_json),
    body: JSON.parse(row.body_json) as unknown,
    body_encoding: row.body_encoding,
    created_at: row.created_at,
    ...(row.identity_id === null || row.identity_kind === null
      ? {}
      : { identity: { id: row.identity_id, kind: row.identity_kind } }),
  };
}

export async function writeGitHubCache(
  env: Env,
  cacheKey: string,
  request: RelayRequest,
  route: RouteInfo,
  response: GitHubRelayResponse,
  identity: Identity,
): Promise<void> {
  if (response.status !== 200) {
    return;
  }
  const ttlSeconds = cacheTTLSeconds(route, response);
  const expiresAt = sqliteTimestamp(new Date(Date.now() + ttlSeconds * 1000));
  await env.DB.prepare(queries.writeGitHubCache)
    .bind(
      cacheKey,
      request.pool,
      request.method,
      request.path,
      JSON.stringify(stableRecord(request.query ?? {})),
      JSON.stringify(stableRecord(cacheVaryHeaders(request.headers))),
      route.routeKey,
      route.kind,
      response.status,
      JSON.stringify(response.headers),
      JSON.stringify(response.body),
      response.body_encoding ?? "json",
      identity.id,
      identity.kind,
      expiresAt,
    )
    .run();
}

export function cacheTTLSeconds(route: RouteInfo, response?: GitHubRelayResponse): number {
  switch (route.kind) {
    case "repo_view":
      return 600;
    case "commit_list":
      return 300;
    case "commit_view":
      return 86_400;
    case "workflow_list":
    case "workflow_view":
      return 3_600;
    case "pr_view":
      return closedPR(response) ? 3_600 : 120;
    case "pr_list":
      return 60;
    case "issue_view":
      return closedIssue(response) ? 3_600 : 300;
    case "issue_list":
      return 60;
    case "branch_view":
      return 120;
    case "run_view":
    case "run_list":
    case "workflow_run_list":
    case "run_jobs":
    case "commit_check_runs":
    case "commit_status":
    case "job_view":
      return 15;
    case "pr_files":
      return stateAwarePRSubresource(route, response) ? 300 : 60;
    default:
      return 60;
  }
}

function cacheVaryHeaders(headers: RelayRequest["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  const accept = headers?.accept;
  const version = headers?.["x-github-api-version"];
  if (accept !== undefined && !defaultJSONAccept(accept)) {
    out.accept = accept.toLowerCase();
  }
  if (version !== undefined) {
    out["x-github-api-version"] = version;
  }
  return out;
}

function normalizedCacheQuery(
  input: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (value === undefined || defaultQueryValue(key, value)) {
      continue;
    }
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

function stableRecord(
  input: Record<string, string | string[]> | Record<string, string>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (value !== undefined) {
      out[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return out;
}

function defaultQueryValue(key: string, value: string | string[]): boolean {
  if (Array.isArray(value)) {
    return false;
  }
  return (key === "page" && value === "1") || (key === "per_page" && value === "30");
}

function defaultJSONAccept(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === "application/vnd.github+json" ||
    normalized === "application/json" ||
    normalized === "application/vnd.github.v3+json"
  );
}

function closedPR(response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body)) {
    return false;
  }
  return response.body.state === "closed" || typeof response.body.merged_at === "string";
}

function closedIssue(response?: GitHubRelayResponse): boolean {
  return isRecord(response?.body) && response.body.state === "closed";
}

function stateAwarePRSubresource(route: RouteInfo, response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body) && !Array.isArray(response?.body)) {
    return false;
  }
  return routeStateHint(route) !== undefined && route.state_hint_source === "live";
}

function cacheStateDiscriminator(route: RouteInfo): string | undefined {
  if (!stateAwarePRRoute(route)) {
    return undefined;
  }
  return routeStateHint(route);
}

function routeStateHint(route: RouteInfo): string | undefined {
  return route.state_hint;
}

function stateAwarePRRoute(route: RouteInfo): boolean {
  return route.kind === "pr_files";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJSONRecord(raw: string): Record<string, string> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return out;
}

function sqliteTimestamp(value: Date): string {
  return value
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}
