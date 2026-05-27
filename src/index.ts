import {
  authenticateAdmin,
  authenticateCaller,
  githubUserByLogin,
  githubUserFromToken,
  hashToken,
  newToken,
  verifyGitHubOrgMember,
  verifyGitHubOrgMemberWithToken,
} from "./auth";
import { githubCacheKey, readGitHubCache, shouldUseGitHubCache, writeGitHubCache } from "./cache";
import { dashboardResponse } from "./dashboard";
import { ensurePool, insertAudit, loadIdentities, loadPoolPolicy } from "./db";
import { callGitHub, rateFromHeaders } from "./github";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  parseJsonObject,
  requireString,
  routeParam,
} from "./http";
import { rootResponse } from "./landing";
import { classifyRoute, normalizeRouteKey, validateRelayRequest } from "./policy";
import { PoolCoordinator } from "./pool-coordinator";
import { ensurePublicGitHubRepo } from "./public-repos";
import {
  finishGitHubWebLogin,
  logoutWebSession,
  requireDashboardAdmin,
  startGitHubWebLogin,
  webLoginRedirect,
  webMeResponse,
} from "./web-session";
import { shouldUseWebError, webErrorResponse } from "./web-error";
import type { GitHubRelayResponse, Identity, RouteInfo, SelectionRequest } from "./types";

export { PoolCoordinator };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      return await routeRequest(request, env, ctx, requestId);
    } catch (error) {
      if (shouldUseWebError(request)) {
        return webErrorResponse(error, requestId);
      }
      return errorResponse(error, requestId);
    }
  },
};

async function routeRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") {
    return rootResponse(request, requestId);
  }
  if (request.method === "GET" && url.pathname === "/login/github") {
    return startGitHubWebLogin(env, url);
  }
  if (request.method === "GET" && url.pathname === "/login/github/callback") {
    return finishGitHubWebLogin(request, env, url);
  }
  if (request.method === "GET" && url.pathname === "/logout") {
    return logoutWebSession(request, env);
  }
  if (request.method === "GET" && url.pathname === "/dashboard") {
    try {
      await requireDashboardAdmin(request, env, loginPool(env, undefined));
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        return webLoginRedirect(request);
      }
      throw error;
    }
    return dashboardResponse();
  }
  if (request.method === "GET" && url.pathname === "/v1/me") {
    const session = await requireDashboardAdmin(request, env, loginPool(env, undefined));
    return webMeResponse(session);
  }
  if (request.method === "GET" && url.pathname === "/v1/dashboard") {
    return dashboardData(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/login/github-cli") {
    return loginGitHubCLI(request, env);
  }
  if (request.method === "GET" && /^\/v1\/pools\/[^/]+\/health$/.test(url.pathname)) {
    const pool = routeParam(url.pathname, /^\/v1\/pools\/(?<pool>[^/]+)\/health$/, "pool");
    await authenticateCaller(request, env, pool);
    return poolHealth(env, pool);
  }
  if (request.method === "POST" && url.pathname === "/v1/github/request") {
    return relayGitHub(request, env, ctx, requestId);
  }
  if (request.method === "POST" && url.pathname === "/v1/admin/callers") {
    await authenticateAdmin(request, env);
    return createCaller(request, env);
  }
  if (request.method === "POST" && /^\/v1\/admin\/pools\/[^/]+\/identities$/.test(url.pathname)) {
    await authenticateAdmin(request, env);
    const pool = routeParam(
      url.pathname,
      /^\/v1\/admin\/pools\/(?<pool>[^/]+)\/identities$/,
      "pool",
    );
    return upsertIdentity(request, env, pool);
  }
  throw new HttpError(404, "not_found", "Route not found");
}

async function dashboardData(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pool = url.searchParams.get("pool")?.trim() || "maintainers";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(pool)) {
    throw new HttpError(400, "pool_invalid", "Pool id is invalid");
  }
  const operator = await requireDashboardAdmin(request, env, pool);
  const coordinator = env.POOL_COORDINATOR.getByName(`pool:${pool}`);
  const [
    identities,
    cache,
    usage,
    users,
    recent,
    routeUsage,
    identityUsage,
    publicRepos,
    coordinatorSnapshot,
  ] = await Promise.all([
    dashboardIdentities(env, pool),
    dashboardCache(env, pool),
    dashboardUsage(env, pool),
    dashboardUsers(env, pool),
    dashboardRecent(env, pool),
    dashboardRouteUsage(env, pool),
    dashboardIdentityUsage(env, pool),
    dashboardPublicRepos(env),
    coordinator.snapshot(),
  ]);
  return jsonResponse({
    generated_at: new Date().toISOString(),
    pool,
    operator: {
      kind: "web",
      github_login: operator.github_login,
      dashboard_role: operator.dashboard_role,
    },
    identities: {
      total: identities.length,
      active: identities.filter((identity) => identity.status === "active").length,
      items: identities,
    },
    cache,
    usage,
    users,
    recent,
    route_usage: routeUsage,
    identity_usage: identityUsage,
    public_repos: publicRepos,
    coordinator: coordinatorSnapshot,
  });
}

async function dashboardUsage(env: Env, pool: string) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS requests_24h,
       SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors_24h,
       AVG(duration_ms) AS avg_duration_ms_24h,
       MAX(created_at) AS latest_seen_at
     FROM audit_events
     WHERE pool_id = ?1
       AND created_at >= datetime('now', '-24 hours')`,
  )
    .bind(pool)
    .first<{
      requests_24h: number;
      errors_24h: number | null;
      avg_duration_ms_24h: number | null;
      latest_seen_at: string | null;
    }>();
  return {
    requests_24h: row?.requests_24h ?? 0,
    errors_24h: row?.errors_24h ?? 0,
    avg_duration_ms_24h: row?.avg_duration_ms_24h ?? null,
    latest_seen_at: row?.latest_seen_at ?? null,
  };
}

async function dashboardIdentities(env: Env, pool: string) {
  const rows = await env.DB.prepare(
    `SELECT id, kind, login, installation_id, status, weight, updated_at
     FROM identities
     WHERE pool_id = ?1
     ORDER BY status = 'active' DESC, weight DESC, id`,
  )
    .bind(pool)
    .all<{
      id: string;
      kind: string;
      login: string;
      installation_id: number | null;
      status: string;
      weight: number;
      updated_at: string;
    }>();
  return rows.results;
}

async function dashboardCache(env: Env, pool: string) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total_entries,
       SUM(CASE WHEN expires_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS fresh_entries,
       SUM(CASE WHEN expires_at <= CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS expired_entries,
       COALESCE(SUM(length(body_json)), 0) AS body_bytes,
       MIN(created_at) AS oldest_created_at,
       MAX(created_at) AS newest_created_at
     FROM github_cache_entries
     WHERE pool_id = ?1`,
  )
    .bind(pool)
    .first<{
      total_entries: number;
      fresh_entries: number | null;
      expired_entries: number | null;
      body_bytes: number | null;
      oldest_created_at: string | null;
      newest_created_at: string | null;
    }>();
  return {
    total_entries: row?.total_entries ?? 0,
    fresh_entries: row?.fresh_entries ?? 0,
    expired_entries: row?.expired_entries ?? 0,
    body_bytes: row?.body_bytes ?? 0,
    oldest_created_at: row?.oldest_created_at ?? null,
    newest_created_at: row?.newest_created_at ?? null,
    routes: await dashboardCacheRoutes(env, pool),
  };
}

async function dashboardCacheRoutes(env: Env, pool: string) {
  const rows = await env.DB.prepare(
    `SELECT
       route_kind,
       COUNT(*) AS entries,
       SUM(CASE WHEN expires_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS fresh_entries,
       MAX(created_at) AS latest_created_at
     FROM github_cache_entries
     WHERE pool_id = ?1
     GROUP BY route_kind
     ORDER BY entries DESC, route_kind
     LIMIT 12`,
  )
    .bind(pool)
    .all<{
      route_kind: string;
      entries: number;
      fresh_entries: number | null;
      latest_created_at: string | null;
    }>();
  return rows.results.map((row) => ({
    ...row,
    fresh_entries: row.fresh_entries ?? 0,
  }));
}

async function dashboardUsers(env: Env, pool: string) {
  const rows = await env.DB.prepare(
    `SELECT
       callers.id,
       callers.name,
       callers.github_login,
       COUNT(*) AS requests,
       SUM(CASE WHEN audit_events.status >= 400 THEN 1 ELSE 0 END) AS errors,
       AVG(audit_events.duration_ms) AS avg_duration_ms,
       MAX(audit_events.created_at) AS last_seen
     FROM audit_events
     JOIN callers ON callers.id = audit_events.caller_id
     WHERE audit_events.pool_id = ?1
       AND audit_events.created_at >= datetime('now', '-7 days')
     GROUP BY callers.id, callers.name, callers.github_login
     ORDER BY requests DESC, last_seen DESC
     LIMIT 20`,
  )
    .bind(pool)
    .all<{
      id: string;
      name: string;
      github_login: string;
      requests: number;
      errors: number | null;
      avg_duration_ms: number | null;
      last_seen: string | null;
    }>();
  return rows.results.map((row) => ({ ...row, errors: row.errors ?? 0 }));
}

async function dashboardRecent(env: Env, pool: string) {
  const rows = await env.DB.prepare(
    `SELECT
       audit_events.created_at,
       callers.github_login,
       audit_events.route_kind,
       audit_events.route_key,
       audit_events.identity_id,
       audit_events.status,
       audit_events.error_code,
       audit_events.duration_ms
     FROM audit_events
     JOIN callers ON callers.id = audit_events.caller_id
     WHERE audit_events.pool_id = ?1
     ORDER BY audit_events.created_at DESC
     LIMIT 20`,
  )
    .bind(pool)
    .all<{
      created_at: string;
      github_login: string;
      route_kind: string;
      route_key: string;
      identity_id: string | null;
      status: number;
      error_code: string | null;
      duration_ms: number;
    }>();
  return rows.results;
}

async function dashboardRouteUsage(env: Env, pool: string) {
  const rows = await env.DB.prepare(
    `SELECT route_kind, COUNT(*) AS requests, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
     FROM audit_events
     WHERE pool_id = ?1
       AND created_at >= datetime('now', '-24 hours')
     GROUP BY route_kind
     ORDER BY requests DESC
     LIMIT 12`,
  )
    .bind(pool)
    .all<{ route_kind: string; requests: number; errors: number | null }>();
  return rows.results.map((row) => ({ ...row, errors: row.errors ?? 0 }));
}

async function dashboardIdentityUsage(env: Env, pool: string) {
  const rows = await env.DB.prepare(
    `SELECT identity_id, COUNT(*) AS requests, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
     FROM audit_events
     WHERE pool_id = ?1
       AND created_at >= datetime('now', '-24 hours')
       AND identity_id IS NOT NULL
     GROUP BY identity_id
     ORDER BY requests DESC
     LIMIT 20`,
  )
    .bind(pool)
    .all<{ identity_id: string; requests: number; errors: number | null }>();
  return rows.results.map((row) => ({ ...row, errors: row.errors ?? 0 }));
}

async function dashboardPublicRepos(env: Env) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total_entries,
       SUM(CASE WHEN expires_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS fresh_entries,
       MAX(checked_at) AS newest_checked_at
     FROM github_public_repos`,
  ).first<{
    total_entries: number;
    fresh_entries: number | null;
    newest_checked_at: string | null;
  }>();
  return {
    total_entries: row?.total_entries ?? 0,
    fresh_entries: row?.fresh_entries ?? 0,
    newest_checked_at: row?.newest_checked_at ?? null,
  };
}

function sanitizeGitHubResponse(
  route: RouteInfo,
  response: GitHubRelayResponse,
): GitHubRelayResponse {
  if (route.kind !== "repo_view" || !isRecord(response.body)) {
    return response;
  }
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
  for (const [key, value] of Object.entries(response.body)) {
    if (allowed.has(key)) {
      body[key] = value;
    }
  }
  return { ...response, body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function relayGitHub(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  const started = Date.now();
  const body = await parseJsonObject(request);
  const relayRequest = validateRelayRequest(body);
  const caller = await authenticateCaller(request, env, relayRequest.pool);
  const policy = await loadPoolPolicy(env, relayRequest.pool);
  if (policy === null) {
    throw new HttpError(404, "pool_not_found", "Pool not found");
  }
  let route: ReturnType<typeof classifyRoute> | undefined;
  let identity: Identity | undefined;
  try {
    route = classifyRoute(relayRequest, policy);
    const cacheEnabled = shouldUseGitHubCache(relayRequest, route);
    const cacheKey = cacheEnabled
      ? await githubCacheKey(relayRequest.pool, relayRequest, route)
      : undefined;
    if (cacheKey !== undefined) {
      const cached = await readGitHubCache(env, cacheKey);
      if (cached !== undefined) {
        const activeIdentities = await loadIdentities(env, relayRequest.pool, route);
        if (activeIdentities.length === 0) {
          throw new HttpError(503, "no_identity", "No active identity can serve this route");
        }
        const cachedIdentity =
          cached.identity === undefined
            ? undefined
            : activeIdentities.find((candidate) => candidate.id === cached.identity?.id);
        if (cached.identity !== undefined && cachedIdentity !== undefined) {
          await ensurePublicGitHubRepo(env, route, cached.created_at);
          ctx.waitUntil(
            insertAudit(env, {
              requestId,
              callerId: caller.id,
              pool: relayRequest.pool,
              routeKey: route.routeKey,
              routeKind: route.kind,
              status: cached.status,
              durationMs: Date.now() - started,
              identityId: cached.identity.id,
            }),
          );
          return jsonResponse({
            status: cached.status,
            headers: cached.headers,
            body: cached.body,
            body_encoding: cached.body_encoding,
            identity: cached.identity,
            relay: {
              pool: relayRequest.pool,
              request_id: requestId,
              cacheable: route.cacheable,
              cache: "hit",
              stale_ok: false,
              route_kind: route.kind,
            },
          });
        }
      }
    }
    const identities = await loadIdentities(env, relayRequest.pool, route);
    if (identities.length === 0) {
      throw new HttpError(503, "no_identity", "No active identity can serve this route");
    }
    const selectionRequest: SelectionRequest = {
      pool: relayRequest.pool,
      routeKey: route.routeKey,
      resource: route.resource,
      candidates: identities.map((candidate) => ({ id: candidate.id, weight: candidate.weight })),
    };
    const coordinator = env.POOL_COORDINATOR.getByName(`pool:${relayRequest.pool}`);
    const selection = await selectIdentity(coordinator, selectionRequest);
    identity = findIdentity(identities, selection.identityId);
    await ensurePublicGitHubRepo(env, route);
    const rawGitHub = await callGitHub(env, identity, relayRequest, route);
    const github = sanitizeGitHubResponse(route, rawGitHub);
    const rate = rateFromHeaders(github.headers);
    ctx.waitUntil(
      Promise.all([
        coordinator.recordResult({
          identityId: identity.id,
          routeKey: route.routeKey,
          resource: route.resource,
          status: github.status,
          rate,
        }),
        insertAudit(env, {
          requestId,
          callerId: caller.id,
          pool: relayRequest.pool,
          routeKey: route.routeKey,
          routeKind: route.kind,
          identityId: identity.id,
          status: github.status,
          durationMs: Date.now() - started,
        }),
        ...(cacheKey === undefined
          ? []
          : [writeGitHubCache(env, cacheKey, relayRequest, route, github, identity)]),
      ]),
    );
    return jsonResponse({
      status: github.status,
      headers: github.headers,
      body: github.body,
      body_encoding: github.body_encoding,
      identity: {
        id: identity.id,
        kind: identity.kind,
      },
      relay: {
        pool: relayRequest.pool,
        request_id: requestId,
        cacheable: route.cacheable,
        cache: cacheKey === undefined ? "bypass" : "miss",
        stale_ok: false,
        route_kind: route.kind,
        lease_reason: selection.reason,
      },
    });
  } catch (error) {
    const audit = auditError(error);
    ctx.waitUntil(
      insertAudit(env, {
        requestId,
        callerId: caller.id,
        pool: relayRequest.pool,
        routeKey: route?.routeKey ?? normalizeRouteKey(relayRequest.method, relayRequest.path),
        routeKind: route?.kind ?? "denied",
        status: audit.status,
        errorCode: audit.code,
        durationMs: Date.now() - started,
        ...(identity === undefined ? {} : { identityId: identity.id }),
      }),
    );
    throw error;
  }
}

function auditError(error: unknown): { status: number; code: string } {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code };
  }
  return { status: 500, code: "internal_error" };
}

async function selectIdentity(
  coordinator: DurableObjectStub<PoolCoordinator>,
  request: SelectionRequest,
) {
  try {
    return await coordinator.selectIdentity(request);
  } catch (error) {
    if (error instanceof Error && error.message.includes("all_identity_candidates_cooling_down")) {
      throw new HttpError(
        503,
        "identities_cooling_down",
        "All identity candidates are cooling down",
      );
    }
    throw error;
  }
}

async function poolHealth(env: Env, pool: string): Promise<Response> {
  const identities = await env.DB.prepare(
    `SELECT
       COUNT(*) AS identities_total,
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS identities_healthy
     FROM identities
     WHERE pool_id = ?1`,
  )
    .bind(pool)
    .first<{ identities_total: number; identities_healthy: number | null }>();
  if (identities === null) {
    throw new HttpError(404, "pool_not_found", "Pool not found");
  }
  return jsonResponse({
    pool,
    identities_total: identities.identities_total,
    identities_healthy: identities.identities_healthy ?? 0,
    policy_version: 1,
  });
}

async function loginGitHubCLI(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonObject(request);
  const githubToken = requireString(body.github_token, "github_token");
  const pool = loginPool(env, body.pool);
  const user = await githubUserFromToken(githubToken);
  const verifiedAt = await verifyGitHubOrgMemberWithToken(env, githubToken, user.login);
  await ensurePool(env, pool);
  const token = newToken("op");
  const existing = await env.DB.prepare(
    `SELECT callers.id
     FROM callers
     JOIN caller_pools ON caller_pools.caller_id = callers.id
     WHERE callers.github_user_id = ?1
       AND callers.org_login = ?2
       AND callers.status = 'active'
       AND caller_pools.pool_id = ?3
     LIMIT 1`,
  )
    .bind(user.id, env.ALLOWED_GITHUB_ORG, pool)
    .first<{ id: string }>();
  if (existing === null) {
    throw new HttpError(403, "caller_not_provisioned", "Caller is not provisioned for this pool");
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE callers
       SET name = ?1,
           token_hash = ?2,
           github_login = ?3,
           github_user_id = ?4,
           org_verified_at = ?5,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?6`,
    ).bind(
      user.name ?? user.login,
      await hashToken(token),
      user.login,
      user.id,
      verifiedAt,
      existing.id,
    ),
  ]);
  return jsonResponse(
    {
      caller: {
        id: existing.id,
        name: user.name ?? user.login,
        github_login: user.login,
        org_login: env.ALLOWED_GITHUB_ORG,
        pool,
      },
      token,
    },
    201,
  );
}

function loginPool(env: Env, requested: unknown): string {
  const configured = (env as unknown as Record<string, string | undefined>).DEFAULT_LOGIN_POOL;
  const allowed =
    configured === undefined || configured.trim() === "" ? "maintainers" : configured.trim();
  if (requested === undefined || requested === null || requested === "") {
    return allowed;
  }
  if (typeof requested !== "string" || requested.trim() !== allowed) {
    throw new HttpError(403, "pool_denied", "CLI login cannot self-grant this pool");
  }
  return allowed;
}

async function createCaller(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonObject(request);
  const pool = requireString(body.pool, "pool");
  const githubLogin = requireString(body.github_login, "github_login");
  const name =
    typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : githubLogin;
  await ensurePool(env, pool);
  const verifiedAt = await verifyGitHubOrgMember(env, githubLogin);
  const githubUser = await githubUserByLogin(githubLogin);
  const token = newToken("op");
  const callerId = `caller_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO callers (id, name, token_hash, github_login, github_user_id, org_login, org_verified_at, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active')`,
  )
    .bind(
      callerId,
      name,
      await hashToken(token),
      githubUser.login,
      githubUser.id,
      env.ALLOWED_GITHUB_ORG,
      verifiedAt,
    )
    .run();
  await env.DB.prepare("INSERT INTO caller_pools (caller_id, pool_id) VALUES (?1, ?2)")
    .bind(callerId, pool)
    .run();
  return jsonResponse(
    {
      caller: {
        id: callerId,
        name,
        github_login: githubLogin,
        org_login: env.ALLOWED_GITHUB_ORG,
        pool,
      },
      token,
    },
    201,
  );
}

async function upsertIdentity(request: Request, env: Env, pool: string): Promise<Response> {
  const body = await parseJsonObject(request);
  const id = requireString(body.id, "id");
  const login = requireString(body.login, "login");
  const secretRef = requireString(body.secret_ref, "secret_ref");
  if (body.kind !== undefined && body.kind !== "pat" && body.kind !== "github_app") {
    throw new HttpError(
      400,
      "identity_kind_unsupported",
      "Only PAT and GitHub App identities are enabled",
    );
  }
  const kind = body.kind === "github_app" ? "github_app" : "pat";
  const installationId =
    typeof body.installation_id === "number" && Number.isInteger(body.installation_id)
      ? body.installation_id
      : null;
  if (kind === "github_app" && (installationId === null || installationId <= 0)) {
    throw new HttpError(
      400,
      "installation_id_required",
      "GitHub App identities require a positive installation_id",
    );
  }
  const weight =
    typeof body.weight === "number" && Number.isInteger(body.weight) ? body.weight : 100;
  const scopes = parseIdentityScopes(body.scopes);
  await ensurePool(env, pool);
  const existing = await env.DB.prepare("SELECT pool_id, kind FROM identities WHERE id = ?1")
    .bind(id)
    .first<{ pool_id: string; kind: string }>();
  if (existing !== null && (existing.pool_id !== pool || existing.kind !== kind)) {
    throw new HttpError(
      409,
      "identity_conflict",
      "Identity id already exists for a different pool or kind",
    );
  }
  const statements = [
    env.DB.prepare(
      `INSERT INTO identities (id, pool_id, kind, login, secret_ref, installation_id, status, weight)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7)
       ON CONFLICT(id) DO UPDATE SET
         login = excluded.login,
         secret_ref = excluded.secret_ref,
         installation_id = excluded.installation_id,
         status = 'active',
         weight = excluded.weight,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(id, pool, kind, login, secretRef, installationId, weight),
    env.DB.prepare("DELETE FROM identity_scopes WHERE identity_id = ?1").bind(id),
    ...scopes.map((scope) =>
      env.DB.prepare(
        `INSERT INTO identity_scopes (identity_id, owner, repo, permission, allow_private)
         VALUES (?1, ?2, ?3, 'read', ?4)`,
      ).bind(id, scope.owner, scope.repo, scope.allowPrivate),
    ),
  ];
  await env.DB.batch(statements);
  return jsonResponse(
    {
      identity: {
        id,
        pool,
        kind,
        login,
        secret_ref: secretRef,
        installation_id: installationId,
        weight,
      },
    },
    201,
  );
}

function parseIdentityScopes(rawScopes: unknown): {
  owner: string;
  repo: string | null;
  allowPrivate: number;
}[] {
  const scopes = Array.isArray(rawScopes) ? rawScopes : [];
  const out: { owner: string; repo: string | null; allowPrivate: number }[] = [];
  for (const scope of scopes) {
    if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
      continue;
    }
    const owner = typeof scope.owner === "string" ? scope.owner.trim() : "";
    if (owner === "") {
      continue;
    }
    const repo =
      typeof scope.repo === "string" && scope.repo.trim() !== "" ? scope.repo.trim() : null;
    const allowPrivate = scope.allow_private === true ? 1 : 0;
    out.push({ owner, repo, allowPrivate });
  }
  return out;
}

function findIdentity(identities: Identity[], id: string): Identity {
  const identity = identities.find((candidate) => candidate.id === id);
  if (identity === undefined) {
    throw new HttpError(503, "identity_selection_invalid", "Selected identity is not available");
  }
  return identity;
}
