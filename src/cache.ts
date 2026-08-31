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
import type { CacheFillOutcome } from "./cache-fill";
import type { GitHubRelayResponse, Identity, RelayRequest, RouteInfo } from "./types";

const TERMINAL_CI_TTL_SECONDS = 3_600;
const TERMINAL_CI_TTL_DETECTION_SECONDS = 1_800;
const EDGE_CACHE_NAMESPACE = "github-v1";
// Megabyte-class bodies (paged run lists, check-run sweeps) are the dominant D1
// write cost and the trigger for "D1 DB is overloaded" queueing under bursts.
// The per-colo edge cache still serves the hot same-client repoll pattern, so
// oversized bodies stay edge-only; they lose cross-colo sharing and D1 stale
// fallback, which is the accepted tradeoff for keeping the primary responsive.
const MAX_D1_CACHE_BODY_BYTES = 262_144;

type CacheRow = {
  status: number;
  response_headers_json: unknown;
  body_json: unknown;
  body_encoding: unknown;
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

export type GitHubCacheRead = {
  cached: CachedGitHubResponse;
  source: "edge" | "shared";
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
    // Retire contaminated page shapes for existing clients in every cache/fill path.
    ...(request.headers?.["x-octopool-public-shape"] === PUBLIC_SHAPES.actionsSummary &&
    ["run_view", "run_list", "workflow_run_list"].includes(route.kind)
      ? { representation: "actions-summary-owned-v2" }
      : {}),
    ...(request.headers?.["x-octopool-public-shape"] === PUBLIC_SHAPES.releaseSummary &&
    ["release_view", "release_latest"].includes(route.kind)
      ? { representation: "release-summary-raw-v2" }
      : {}),
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
  return (await readGitHubCacheWithSource(env, cacheKey, ctx, maxAgeSeconds))?.cached;
}

export async function readGitHubCacheWithSource(
  env: Env,
  cacheKey: string,
  ctx?: ExecutionContext,
  maxAgeSeconds?: number,
): Promise<GitHubCacheRead | undefined> {
  const edge = await readEdgeGitHubCache(cacheKey, maxAgeSeconds);
  if (edge !== undefined) {
    return { cached: edge, source: "edge" };
  }
  const row = await env.DB.prepare(queries.readGitHubCache).bind(cacheKey).first<CacheRow>();
  const cached = cacheRowResponse(row);
  if (cached === undefined || !withinRequestedMaxAge(cached, maxAgeSeconds)) {
    return undefined;
  }
  if (ctx !== undefined) {
    ctx.waitUntil(writeEdgeCachedResponse(cacheKey, cached));
  }
  return { cached, source: "shared" };
}

export async function readEdgeGitHubCache(
  cacheKey: string,
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
  return undefined;
}

function withinRequestedMaxAge(cached: CachedGitHubResponse, maxAgeSeconds?: number): boolean {
  if (maxAgeSeconds === undefined) {
    return true;
  }
  // A live read must revalidate even a same-time or future-dated cache entry.
  if (maxAgeSeconds === 0) {
    return false;
  }
  const createdAt = parseSQLiteTimestamp(cached.created_at);
  return Number.isFinite(createdAt) && Date.now() - createdAt <= maxAgeSeconds * 1000;
}

export async function readStaleGitHubCache(
  env: Env,
  cacheKey: string,
  route: RouteInfo,
  maxAgeSeconds?: number,
): Promise<CachedGitHubResponse | undefined> {
  const row = await env.DB.prepare(queries.readGitHubCacheAny).bind(cacheKey).first<CacheRow>();
  if (row === null || !staleCacheAllowed(row, route)) {
    return undefined;
  }
  const cached = cacheRowResponse(row);
  return cached !== undefined && withinRequestedMaxAge(cached, maxAgeSeconds) ? cached : undefined;
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
  if (
    row === null ||
    typeof row.response_headers_json !== "string" ||
    typeof row.body_json !== "string" ||
    !validBodyEncoding(row.body_encoding)
  ) {
    return undefined;
  }
  let headers: Record<string, string> | undefined;
  let body: unknown;
  try {
    headers = parseJSONRecord(row.response_headers_json);
    body = JSON.parse(row.body_json) as unknown;
  } catch {
    return undefined;
  }
  if (headers === undefined || !validCachedBody(body, row.body_encoding)) {
    return undefined;
  }
  return {
    status: row.status,
    headers,
    body,
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
): Promise<CacheFillOutcome> {
  if (response.status < 200 || response.status >= 300) {
    return "failed";
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
  const bodyJson = JSON.stringify(response.body);
  const edgeWrite = writeEdgeCachedResponse(cacheKey, cached);
  let sharedWrite = Promise.resolve(false);
  // UTF-8 bytes, not String.length: UTF-16 code units undercount multibyte
  // content by up to 3x, which would let Unicode-heavy rows past the cap.
  if (new TextEncoder().encode(bodyJson).byteLength <= MAX_D1_CACHE_BODY_BYTES) {
    sharedWrite = env.DB.prepare(queries.writeGitHubCache)
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
        bodyJson,
        response.body_encoding ?? "json",
        identity?.id ?? null,
        identity?.kind ?? null,
        expiresAt,
        staleExpiresAt,
      )
      .run()
      .then(() => true)
      .catch((error: unknown) => {
        console.error("github shared cache write failed", error);
        return false;
      });
  }
  const [edgePublished, sharedPublished] = await Promise.all([edgeWrite, sharedWrite]);
  if (sharedPublished) {
    return "shared";
  }
  return edgePublished ? "edge_only" : "failed";
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

function writeEdgeCachedResponse(cacheKey: string, cached: CachedGitHubResponse): Promise<boolean> {
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
      return route.run_attempt !== undefined && completedRun(response)
        ? TERMINAL_CI_TTL_SECONDS
        : 60;
    case "run_list":
      return completedRunList(response) ? 120 : 60;
    case "jobs":
      return route.run_attempt_completed === true && completedJobs(response)
        ? TERMINAL_CI_TTL_SECONDS
        : 60;
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
  return typeof response.body.merged_at === "string";
}

function closedIssue(response?: GitHubRelayResponse): boolean {
  return (
    isRecord(response?.body) &&
    (response.body.state === "closed" || response.body.state === "CLOSED")
  );
}

function completedRun(response?: GitHubRelayResponse): boolean {
  return isRecord(response?.body) && response.body.status === "completed";
}

function completedRunList(response?: GitHubRelayResponse): boolean {
  return completedCollection(response, "workflow_runs");
}

function completedJobs(response?: GitHubRelayResponse): boolean {
  return completedCollection(response, "jobs");
}

function completedJob(response?: GitHubRelayResponse): boolean {
  return isRecord(response?.body) && response.body.status === "completed";
}

function completedChecks(response?: GitHubRelayResponse): boolean {
  return completedCollection(response, "check_runs");
}

function completedCheckSuites(response?: GitHubRelayResponse): boolean {
  return completedCollection(response, "check_suites");
}

function completedCollection(response: GitHubRelayResponse | undefined, key: string): boolean {
  if (!isRecord(response?.body) || !Array.isArray(response.body[key])) {
    return false;
  }
  const items = response.body[key];
  return items.length > 0 && items.every((item) => isRecord(item) && item.status === "completed");
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

function parseJSONRecord(raw: string): Record<string, string> | undefined {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    return undefined;
  }
  return value as Record<string, string>;
}

function validBodyEncoding(value: unknown): value is "json" | "text" | "base64" {
  return value === "json" || value === "text" || value === "base64";
}

function validCachedBody(body: unknown, encoding: "json" | "text" | "base64"): boolean {
  if (encoding === "json") {
    return true;
  }
  return typeof body === "string" || (encoding === "text" && body === null);
}
