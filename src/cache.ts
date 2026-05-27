import { hashToken } from "./auth";
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
    query: stableRecord(request.query ?? {}),
    headers: stableRecord(cacheVaryHeaders(request.headers)),
    route_key: route.routeKey,
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
  const row = await env.DB.prepare(
    `SELECT status, response_headers_json, body_json, body_encoding, identity_id, identity_kind, created_at
     FROM github_cache_entries
     WHERE cache_key = ?1
       AND expires_at > CURRENT_TIMESTAMP`,
  )
    .bind(cacheKey)
    .first<CacheRow>();
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
  const ttlSeconds = cacheTTLSeconds(route);
  const expiresAt = sqliteTimestamp(new Date(Date.now() + ttlSeconds * 1000));
  await env.DB.prepare(
    `INSERT INTO github_cache_entries
       (cache_key, pool_id, method, path, query_json, headers_json, route_key, route_kind,
        status, response_headers_json, body_json, body_encoding, identity_id, identity_kind, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
     ON CONFLICT(cache_key) DO UPDATE SET
       status = excluded.status,
       response_headers_json = excluded.response_headers_json,
       body_json = excluded.body_json,
       body_encoding = excluded.body_encoding,
       identity_id = excluded.identity_id,
       identity_kind = excluded.identity_kind,
       created_at = CURRENT_TIMESTAMP,
       expires_at = excluded.expires_at`,
  )
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

function cacheTTLSeconds(route: RouteInfo): number {
  switch (route.kind) {
    case "repo_view":
    case "workflow_list":
    case "workflow_view":
      return 300;
    case "pr_view":
    case "pr_list":
    case "issue_view":
    case "issue_list":
    case "branch_view":
      return 30;
    case "commit_list":
    case "commit_view":
      return 120;
    case "run_view":
    case "run_list":
    case "workflow_run_list":
    case "run_jobs":
    case "commit_check_runs":
    case "commit_status":
      return 15;
    default:
      return 60;
  }
}

function cacheVaryHeaders(headers: RelayRequest["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  const accept = headers?.accept;
  const version = headers?.["x-github-api-version"];
  if (accept !== undefined) {
    out.accept = accept;
  }
  if (version !== undefined) {
    out["x-github-api-version"] = version;
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
      out[key] = Array.isArray(value) ? [...value].sort() : value;
    }
  }
  return out;
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
