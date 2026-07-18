import { hashToken } from "./auth";
import {
  type CacheFreshStrategy,
  cachePolicyForRouteKind,
  isStateAwarePRRoute,
} from "./cache-policy";
import { deleteEdgeJSON, readEdgeJSON, writeEdgeJSON } from "./edge-cache";
import { queries } from "./generated/sql";
import { defaultGitHubJSONAccept } from "./github-response";
import { PUBLIC_SHAPES } from "./github-public-shapes";
import { isRecord } from "./object";
import { parseSQLiteTimestamp, sqliteTimestamp } from "./sqlite-time";
import type { GitHubRelayResponse, Identity, RelayRequest, RouteInfo } from "./types";

const TERMINAL_CI_TTL_SECONDS = 3_600;
const TERMINAL_CI_TTL_DETECTION_SECONDS = 1_800;
const EDGE_CACHE_NAMESPACE = "github-v1";

type CacheRow = {
  status: number;
  response_headers_json: string;
  body_json: string;
  body_encoding: "json" | "text" | "base64";
  identity_id: string | null;
  identity_kind: "pat" | "github_app" | null;
  created_at: string;
  expires_at: string;
  stale_expires_at?: string;
};

export type CachedGitHubResponse = GitHubRelayResponse & {
  identity?: Pick<Identity, "id" | "kind">;
  created_at: string;
  expires_at: string;
};

export function githubCacheRevalidationHeaders(
  cached: CachedGitHubResponse,
): Record<string, string> | undefined {
  if (cached.identity === undefined && cached.headers["x-ratelimit-resource"] === undefined) {
    return undefined;
  }
  const etag = cached.headers.etag;
  if (etag !== undefined) {
    return { "if-none-match": etag };
  }
  const lastModified = cached.headers["last-modified"];
  return lastModified === undefined ? undefined : { "if-modified-since": lastModified };
}

export async function githubCacheKey(
  pool: string,
  request: RelayRequest,
  route: RouteInfo,
  identity?: Pick<Identity, "id" | "kind">,
): Promise<string> {
  const stable = {
    pool,
    method: request.method,
    path: request.path,
    query: normalizedCacheQuery(request.query ?? {}),
    headers: stableRecord(cacheVaryHeaders(request.headers)),
    route_key: route.routeKey,
    state: cacheStateDiscriminator(route),
    ...(identity === undefined ? {} : { identity: `${identity.kind}:${identity.id}` }),
  };
  return hashToken(JSON.stringify(stable));
}

export function shouldUseGitHubCache(request: RelayRequest, route: RouteInfo): boolean {
  if (!route.cacheable || route.logs || route.largePayload) {
    return false;
  }
  const headers = request.headers ?? {};
  return headers["if-none-match"] === undefined && headers["if-modified-since"] === undefined;
}

export function requestCacheMaxAgeSeconds(request: RelayRequest): number | undefined {
  const cacheControl = request.headers?.["cache-control"];
  if (cacheControl === undefined) {
    return undefined;
  }
  const match = /(?:^|[,\s])max-age=(\d{1,9})(?:[,\s]|$)/i.exec(cacheControl);
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
}

export async function readGitHubCache(
  env: Env,
  cacheKey: string,
  ctx?: ExecutionContext,
  maxAgeSeconds?: number,
): Promise<CachedGitHubResponse | undefined> {
  const edge = await readEdgeJSON<CachedGitHubResponse>(EDGE_CACHE_NAMESPACE, cacheKey);
  if (edge !== undefined) {
    if (freshCachedResponse(edge)) {
      if (withinRequestedMaxAge(edge, maxAgeSeconds)) {
        return edge;
      }
      // Keep the still-fresh edge copy; another data center may have refilled
      // D1 more recently, so fall through instead of evicting.
    } else {
      await deleteEdgeJSON(EDGE_CACHE_NAMESPACE, cacheKey);
    }
  }
  const row = await env.DB.prepare(queries.readGitHubCache).bind(cacheKey).first<CacheRow>();
  const cached = cacheRowResponse(row);
  if (cached === undefined || !withinRequestedMaxAge(cached, maxAgeSeconds)) {
    return undefined;
  }
  if (ctx !== undefined) {
    ctx.waitUntil(writeEdgeCachedResponse(cacheKey, cached));
  }
  return cached;
}

function withinRequestedMaxAge(cached: CachedGitHubResponse, maxAgeSeconds?: number): boolean {
  if (maxAgeSeconds === undefined) {
    return true;
  }
  const createdAt = parseSQLiteTimestamp(cached.created_at);
  return Number.isFinite(createdAt) && Date.now() - createdAt <= maxAgeSeconds * 1000;
}

export async function readStaleGitHubCache(
  env: Env,
  cacheKey: string,
  route: RouteInfo,
): Promise<CachedGitHubResponse | undefined> {
  const row = await env.DB.prepare(queries.readGitHubCacheAny).bind(cacheKey).first<CacheRow>();
  if (row === null) {
    return undefined;
  }
  if (!staleCacheAllowed(row, route)) {
    return undefined;
  }
  return cacheRowResponse(row);
}

export function staleCacheSeconds(route: RouteInfo, freshTtlSeconds?: number): number {
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

function cacheRowResponse(row: CacheRow | null): CachedGitHubResponse | undefined {
  if (row === null) {
    return undefined;
  }
  return {
    status: row.status,
    headers: parseJSONRecord(row.response_headers_json),
    body: JSON.parse(row.body_json) as unknown,
    body_encoding: row.body_encoding,
    created_at: row.created_at,
    expires_at: row.expires_at,
    ...(row.identity_id === null || row.identity_kind === null
      ? {}
      : { identity: { id: row.identity_id, kind: row.identity_kind } }),
  };
}

function staleCacheAllowed(row: CacheRow, route: RouteInfo): boolean {
  const createdAt = Date.parse(`${row.created_at}Z`);
  const expiresAt = Date.parse(`${row.expires_at}Z`);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
    return false;
  }
  if (row.stale_expires_at !== undefined) {
    const staleExpiresAt = Date.parse(`${row.stale_expires_at}Z`);
    if (!Number.isFinite(staleExpiresAt) || staleExpiresAt <= Date.now()) {
      return false;
    }
  }
  const freshTtlSeconds = Math.max(0, (expiresAt - createdAt) / 1000);
  const maxStaleMs = staleCacheSeconds(route, freshTtlSeconds) * 1000;
  return Date.now() - expiresAt <= maxStaleMs;
}

export async function writeGitHubCache(
  env: Env,
  cacheKey: string,
  request: RelayRequest,
  route: RouteInfo,
  response: GitHubRelayResponse,
  identity?: Identity,
): Promise<void> {
  if (response.status < 200 || response.status >= 300) {
    return;
  }
  const ttlSeconds = cacheTTLSeconds(route, response);
  const staleSeconds = staleCacheSeconds(route, ttlSeconds);
  const createdAt = sqliteTimestamp(new Date());
  const expiresAt = sqliteTimestamp(new Date(Date.now() + ttlSeconds * 1000));
  const staleExpiresAt = sqliteTimestamp(new Date(Date.now() + (ttlSeconds + staleSeconds) * 1000));
  const cached: CachedGitHubResponse = {
    ...response,
    body_encoding: response.body_encoding ?? "json",
    created_at: createdAt,
    expires_at: expiresAt,
    ...(identity === undefined ? {} : { identity: { id: identity.id, kind: identity.kind } }),
  };
  await Promise.all([
    env.DB.prepare(queries.writeGitHubCache)
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
        identity?.id ?? null,
        identity?.kind ?? null,
        expiresAt,
        staleExpiresAt,
      )
      .run(),
    writeEdgeCachedResponse(cacheKey, cached),
  ]);
}

function freshCachedResponse(cached: CachedGitHubResponse): boolean {
  if (
    typeof cached.status !== "number" ||
    typeof cached.headers !== "object" ||
    cached.headers === null ||
    typeof cached.created_at !== "string" ||
    typeof cached.expires_at !== "string"
  ) {
    return false;
  }
  const expiresAt = parseSQLiteTimestamp(cached.expires_at);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function writeEdgeCachedResponse(cacheKey: string, cached: CachedGitHubResponse): Promise<void> {
  const expiresAt = parseSQLiteTimestamp(cached.expires_at);
  const ttlSeconds = Math.floor((expiresAt - Date.now()) / 1000);
  return writeEdgeJSON(EDGE_CACHE_NAMESPACE, cacheKey, cached, ttlSeconds);
}

export function cacheTTLSeconds(route: RouteInfo, response?: GitHubRelayResponse): number {
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
      return closedPR(response) ? 3_600 : 120;
    case "issue":
      return closedIssue(response) ? 3_600 : 300;
    case "run":
      return completedRun(response) ? TERMINAL_CI_TTL_SECONDS : 60;
    case "run_list":
      return completedRunList(response) ? 120 : 60;
    case "jobs":
      return completedJobs(response) ? TERMINAL_CI_TTL_SECONDS : 60;
    case "checks":
      return completedChecks(response) ? TERMINAL_CI_TTL_SECONDS : 60;
    case "check_suites":
      return completedCheckSuites(response) ? TERMINAL_CI_TTL_SECONDS : 60;
    case "status":
      return completedStatus(response) ? TERMINAL_CI_TTL_SECONDS : 60;
    case "status_list":
      return completedStatusList(response) ? TERMINAL_CI_TTL_SECONDS : 60;
    case "job":
      return completedJob(response) ? TERMINAL_CI_TTL_SECONDS : 60;
    case "pr_state":
      return stateAwarePRSubresource(route, response) ? 300 : 60;
  }
}

function cacheVaryHeaders(headers: RelayRequest["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  const accept = headers?.accept;
  const version = headers?.["x-github-api-version"];
  const publicShape = headers?.["x-octopool-public-shape"];
  if (accept !== undefined && !defaultGitHubJSONAccept(accept, false)) {
    out.accept = accept.toLowerCase();
  }
  if (version !== undefined) {
    out["x-github-api-version"] = version;
  }
  if (publicShape !== undefined && publicShape !== PUBLIC_SHAPES.issueSearch) {
    out["x-octopool-public-shape"] = publicShape;
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

function closedPR(response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body)) {
    return false;
  }
  return response.body.state === "closed" || typeof response.body.merged_at === "string";
}

function closedIssue(response?: GitHubRelayResponse): boolean {
  return isRecord(response?.body) && response.body.state === "closed";
}

function completedRun(response?: GitHubRelayResponse): boolean {
  return isRecord(response?.body) && response.body.status === "completed";
}

function completedRunList(response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body) || !Array.isArray(response.body.workflow_runs)) {
    return false;
  }
  return (
    response.body.workflow_runs.length > 0 &&
    response.body.workflow_runs.every((item) => isRecord(item) && item.status === "completed")
  );
}

function completedJobs(response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body) || !Array.isArray(response.body.jobs)) {
    return false;
  }
  return (
    response.body.jobs.length > 0 &&
    response.body.jobs.every((item) => isRecord(item) && item.status === "completed")
  );
}

function completedJob(response?: GitHubRelayResponse): boolean {
  return isRecord(response?.body) && response.body.status === "completed";
}

function completedChecks(response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body) || !Array.isArray(response.body.check_runs)) {
    return false;
  }
  return (
    response.body.check_runs.length > 0 &&
    response.body.check_runs.every((item) => isRecord(item) && item.status === "completed")
  );
}

function completedCheckSuites(response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body) || !Array.isArray(response.body.check_suites)) {
    return false;
  }
  return (
    response.body.check_suites.length > 0 &&
    response.body.check_suites.every((item) => isRecord(item) && item.status === "completed")
  );
}

function completedStatus(response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body) || !Array.isArray(response.body.statuses)) {
    return false;
  }
  return (
    response.body.statuses.length > 0 &&
    response.body.statuses.every((item) => isRecord(item) && item.state !== "pending")
  );
}

function completedStatusList(response?: GitHubRelayResponse): boolean {
  if (!Array.isArray(response?.body)) {
    return false;
  }
  return (
    response.body.length > 0 &&
    response.body.every((item) => isRecord(item) && item.state !== "pending")
  );
}

function stateAwarePRSubresource(route: RouteInfo, response?: GitHubRelayResponse): boolean {
  if (!isRecord(response?.body) && !Array.isArray(response?.body)) {
    return false;
  }
  return routeStateHint(route) !== undefined && route.state_hint_source === "live";
}

function cacheStateDiscriminator(route: RouteInfo): string | undefined {
  if (!isStateAwarePRRoute(route.kind)) {
    return undefined;
  }
  return routeStateHint(route);
}

function routeStateHint(route: RouteInfo): string | undefined {
  return route.state_hint;
}

export async function pruneExpiredGitHubCache(env: Env, limit = 500): Promise<number> {
  const result = await env.DB.prepare(queries.deleteExpiredGitHubCacheBatch).bind(limit).run();
  return result.meta.changes;
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
