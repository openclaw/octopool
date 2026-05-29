-- name: AuthenticateCaller :one
SELECT callers.id, callers.name, callers.github_login, callers.org_login, callers.org_verified_at
FROM callers
JOIN caller_pools ON caller_pools.caller_id = callers.id
WHERE callers.token_hash = ?1
  AND callers.status = 'active'
  AND caller_pools.pool_id = ?2
LIMIT 1;

-- name: UpdateCallerOrgVerifiedAt :exec
UPDATE callers
SET org_verified_at = ?1,
    updated_at = CURRENT_TIMESTAMP
WHERE id = ?2;

-- name: EnsurePool :exec
INSERT INTO pools (id, name, policy_json)
VALUES (?1, ?1, ?2)
ON CONFLICT(id) DO NOTHING;

-- name: GetPoolPolicy :one
SELECT policy_json
FROM pools
WHERE id = ?1;

-- name: ListActiveIdentitiesForPool :many
SELECT id, kind, login, secret_ref, installation_id, weight
FROM identities
WHERE pool_id = ?1
  AND status = 'active';

-- name: ListActiveIdentitiesForRoute :many
SELECT DISTINCT identities.id, identities.kind, identities.login, identities.secret_ref, identities.installation_id, identities.weight
FROM identities
JOIN identity_scopes ON identity_scopes.identity_id = identities.id
WHERE identities.pool_id = ?1
  AND identities.status = 'active'
  AND lower(identity_scopes.owner) = lower(?2)
  AND (
    lower(identity_scopes.repo) = lower(?3)
    OR identity_scopes.repo IS NULL
  );

-- name: InsertAudit :exec
INSERT INTO audit_events
  (request_id, caller_id, pool_id, route_key, route_kind, identity_id, status, error_code, duration_ms, cache_status, cacheable)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);

-- name: ReadGitHubCache :one
SELECT status, response_headers_json, body_json, body_encoding, identity_id, identity_kind, created_at
FROM github_cache_entries
WHERE cache_key = ?1
  AND expires_at > CURRENT_TIMESTAMP;

-- name: WriteGitHubCache :exec
INSERT INTO github_cache_entries
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
  expires_at = excluded.expires_at;

-- name: DashboardUsage :one
SELECT
  COUNT(*) AS requests_24h,
  SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors_24h,
  SUM(CASE WHEN cache_status = 'hit' THEN 1 ELSE 0 END) AS cache_hits_24h,
  SUM(CASE WHEN cache_status = 'miss' THEN 1 ELSE 0 END) AS cache_misses_24h,
  SUM(CASE WHEN cache_status = 'bypass' THEN 1 ELSE 0 END) AS cache_bypass_24h,
  AVG(duration_ms) AS avg_duration_ms_24h,
  MAX(created_at) AS latest_seen_at
FROM audit_events
WHERE pool_id = ?1
  AND created_at >= datetime('now', '-24 hours');

-- name: DashboardIdentities :many
SELECT id, kind, login, installation_id, status, weight, updated_at
FROM identities
WHERE pool_id = ?1
ORDER BY status = 'active' DESC, weight DESC, id;

-- name: DashboardCache :one
SELECT
  COUNT(*) AS total_entries,
  SUM(CASE WHEN expires_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS fresh_entries,
  SUM(CASE WHEN expires_at <= CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS expired_entries,
  COALESCE(SUM(length(body_json)), 0) AS body_bytes,
  MIN(created_at) AS oldest_created_at,
  MAX(created_at) AS newest_created_at
FROM github_cache_entries
WHERE pool_id = ?1;

-- name: DashboardCacheRoutes :many
SELECT
  route_kind,
  COUNT(*) AS entries,
  SUM(CASE WHEN expires_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS fresh_entries,
  MAX(created_at) AS latest_created_at
FROM github_cache_entries
WHERE pool_id = ?1
GROUP BY route_kind
ORDER BY entries DESC, route_kind
LIMIT 12;

-- name: DashboardUsers :many
SELECT
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
LIMIT 20;

-- name: DashboardRecent :many
SELECT
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
LIMIT 20;

-- name: DashboardRouteUsage :many
SELECT
  route_kind,
  COUNT(*) AS requests,
  SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
  SUM(CASE WHEN cache_status = 'hit' THEN 1 ELSE 0 END) AS cache_hits,
  SUM(CASE WHEN cache_status = 'miss' THEN 1 ELSE 0 END) AS cache_misses,
  SUM(CASE WHEN cache_status = 'bypass' THEN 1 ELSE 0 END) AS cache_bypass
FROM audit_events
WHERE pool_id = ?1
  AND created_at >= datetime('now', '-24 hours')
GROUP BY route_kind
ORDER BY requests DESC
LIMIT 12;

-- name: DashboardIdentityUsage :many
SELECT identity_id, COUNT(*) AS requests, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
FROM audit_events
WHERE pool_id = ?1
  AND created_at >= datetime('now', '-24 hours')
  AND identity_id IS NOT NULL
GROUP BY identity_id
ORDER BY requests DESC
LIMIT 20;

-- name: DashboardPublicRepos :one
SELECT
  COUNT(*) AS total_entries,
  SUM(CASE WHEN expires_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS fresh_entries,
  MAX(checked_at) AS newest_checked_at
FROM github_public_repos;

-- name: PoolHealth :one
SELECT
  COUNT(*) AS identities_total,
  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS identities_healthy
FROM identities
WHERE pool_id = ?1;

-- name: LoginExistingCaller :one
SELECT callers.id
FROM callers
JOIN caller_pools ON caller_pools.caller_id = callers.id
WHERE callers.github_user_id = ?1
  AND callers.org_login = ?2
  AND callers.status = 'active'
  AND caller_pools.pool_id = ?3
LIMIT 1;

-- name: UpdateCallerLogin :exec
UPDATE callers
SET name = ?1,
    token_hash = ?2,
    github_login = ?3,
    github_user_id = ?4,
    org_verified_at = ?5,
    updated_at = CURRENT_TIMESTAMP
WHERE id = ?6;

-- name: InsertCaller :exec
INSERT INTO callers (id, name, token_hash, github_login, github_user_id, org_login, org_verified_at, status)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active');

-- name: InsertCallerPool :exec
INSERT INTO caller_pools (caller_id, pool_id)
VALUES (?1, ?2);

-- name: GetIdentityPoolKind :one
SELECT pool_id, kind
FROM identities
WHERE id = ?1;

-- name: UpsertIdentity :exec
INSERT INTO identities (id, pool_id, kind, login, secret_ref, installation_id, status, weight)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7)
ON CONFLICT(id) DO UPDATE SET
  login = excluded.login,
  secret_ref = excluded.secret_ref,
  installation_id = excluded.installation_id,
  status = 'active',
  weight = excluded.weight,
  updated_at = CURRENT_TIMESTAMP;

-- name: DeleteIdentityScopes :exec
DELETE FROM identity_scopes
WHERE identity_id = ?1;

-- name: InsertIdentityScope :exec
INSERT INTO identity_scopes (identity_id, owner, repo, permission, allow_private)
VALUES (?1, ?2, ?3, 'read', ?4);

-- name: WebLoginCaller :one
SELECT callers.id, callers.dashboard_role
FROM callers
JOIN caller_pools ON caller_pools.caller_id = callers.id
WHERE callers.github_user_id = ?1
  AND callers.org_login = ?2
  AND callers.status = 'active'
  AND caller_pools.pool_id = ?3
LIMIT 1;

-- name: UpdateCallerWebLogin :exec
UPDATE callers
SET name = ?1,
    github_login = ?2,
    github_user_id = ?3,
    org_verified_at = ?4,
    updated_at = CURRENT_TIMESTAMP
WHERE id = ?5;

-- name: InsertWebSession :exec
INSERT INTO web_sessions (session_hash, caller_id, expires_at)
VALUES (?1, ?2, ?3);

-- name: DeleteWebSession :exec
DELETE FROM web_sessions
WHERE session_hash = ?1;

-- name: GetWebSession :one
SELECT
  callers.id,
  callers.name,
  callers.github_login,
  callers.org_login,
  callers.org_verified_at,
  callers.dashboard_role,
  web_sessions.expires_at
FROM web_sessions
JOIN callers ON callers.id = web_sessions.caller_id
WHERE web_sessions.session_hash = ?1
  AND web_sessions.expires_at > CURRENT_TIMESTAMP
  AND callers.status = 'active'
  AND callers.org_login = ?2;

-- name: GetCallerPoolGrant :one
SELECT 1
FROM caller_pools
WHERE caller_id = ?1
  AND pool_id = ?2
LIMIT 1;

-- name: TouchWebSession :exec
UPDATE web_sessions
SET last_seen_at = CURRENT_TIMESTAMP
WHERE session_hash = ?1;

-- name: UpsertPublicRepoProof :exec
INSERT INTO github_public_repos (owner, repo, checked_at, expires_at)
VALUES (?1, ?2, CURRENT_TIMESTAMP, datetime(CURRENT_TIMESTAMP, ?3))
ON CONFLICT(owner, repo) DO UPDATE SET
  checked_at = excluded.checked_at,
  expires_at = excluded.expires_at;

-- name: FreshPublicRepoProof :one
SELECT 1
FROM github_public_repos
WHERE lower(owner) = ?1
  AND lower(repo) = ?2
  AND expires_at > CURRENT_TIMESTAMP
LIMIT 1;

-- name: CoveringPublicRepoProof :one
SELECT 1
FROM github_public_repos
WHERE lower(owner) = ?1
  AND lower(repo) = ?2
  AND checked_at >= datetime(?3, '-5 seconds')
LIMIT 1;

-- name: FreshCoveringPublicRepoProof :one
SELECT 1
FROM github_public_repos
WHERE lower(owner) = ?1
  AND lower(repo) = ?2
  AND checked_at >= datetime(?3, '-5 seconds')
  AND expires_at > CURRENT_TIMESTAMP
LIMIT 1;

-- name: FreshPRStateProof :one
SELECT 1
FROM github_pr_state_proofs
WHERE lower(owner) = ?1
  AND lower(repo) = ?2
  AND number = ?3
  AND state_hint = ?4
  AND expires_at > CURRENT_TIMESTAMP
LIMIT 1;

-- name: UpsertPRStateProof :exec
INSERT INTO github_pr_state_proofs (owner, repo, number, state_hint, checked_at, expires_at)
VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, datetime(CURRENT_TIMESTAMP, ?5))
ON CONFLICT(owner, repo, number, state_hint) DO UPDATE SET
  checked_at = excluded.checked_at,
  expires_at = excluded.expires_at;

-- name: StatsAggregatePool :one
SELECT
  COUNT(*) AS requests,
  SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
  AVG(duration_ms) AS avg_duration_ms,
  SUM(CASE WHEN cache_status = 'hit' THEN 1 ELSE 0 END) AS cache_hits,
  SUM(CASE WHEN cache_status = 'miss' THEN 1 ELSE 0 END) AS cache_misses,
  SUM(CASE WHEN cache_status = 'bypass' THEN 1 ELSE 0 END) AS cache_bypass,
  SUM(CASE WHEN cache_status = 'unknown' THEN 1 ELSE 0 END) AS cache_unknown,
  SUM(CASE WHEN cacheable = 1 THEN 1 ELSE 0 END) AS cacheable_requests
FROM audit_events
WHERE pool_id = ?1
  AND created_at >= datetime('now', ?2);

-- name: StatsAggregateCaller :one
SELECT
  COUNT(*) AS requests,
  SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
  AVG(duration_ms) AS avg_duration_ms,
  SUM(CASE WHEN cache_status = 'hit' THEN 1 ELSE 0 END) AS cache_hits,
  SUM(CASE WHEN cache_status = 'miss' THEN 1 ELSE 0 END) AS cache_misses,
  SUM(CASE WHEN cache_status = 'bypass' THEN 1 ELSE 0 END) AS cache_bypass,
  SUM(CASE WHEN cache_status = 'unknown' THEN 1 ELSE 0 END) AS cache_unknown,
  SUM(CASE WHEN cacheable = 1 THEN 1 ELSE 0 END) AS cacheable_requests
FROM audit_events
WHERE pool_id = ?1
  AND created_at >= datetime('now', ?2)
  AND caller_id = ?3;

-- name: StatsRoutesPool :many
SELECT
  route_kind,
  COUNT(*) AS requests,
  SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
  AVG(duration_ms) AS avg_duration_ms,
  SUM(CASE WHEN cache_status = 'hit' THEN 1 ELSE 0 END) AS cache_hits,
  SUM(CASE WHEN cache_status = 'miss' THEN 1 ELSE 0 END) AS cache_misses,
  SUM(CASE WHEN cache_status = 'bypass' THEN 1 ELSE 0 END) AS cache_bypass,
  SUM(CASE WHEN cache_status = 'unknown' THEN 1 ELSE 0 END) AS cache_unknown,
  SUM(CASE WHEN cacheable = 1 THEN 1 ELSE 0 END) AS cacheable_requests,
  MAX(created_at) AS latest_seen_at
FROM audit_events
WHERE pool_id = ?1
  AND created_at >= datetime('now', ?2)
GROUP BY route_kind
ORDER BY requests DESC, route_kind
LIMIT 12;

-- name: StatsRoutesCaller :many
SELECT
  route_kind,
  COUNT(*) AS requests,
  SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
  AVG(duration_ms) AS avg_duration_ms,
  SUM(CASE WHEN cache_status = 'hit' THEN 1 ELSE 0 END) AS cache_hits,
  SUM(CASE WHEN cache_status = 'miss' THEN 1 ELSE 0 END) AS cache_misses,
  SUM(CASE WHEN cache_status = 'bypass' THEN 1 ELSE 0 END) AS cache_bypass,
  SUM(CASE WHEN cache_status = 'unknown' THEN 1 ELSE 0 END) AS cache_unknown,
  SUM(CASE WHEN cacheable = 1 THEN 1 ELSE 0 END) AS cacheable_requests,
  MAX(created_at) AS latest_seen_at
FROM audit_events
WHERE pool_id = ?1
  AND created_at >= datetime('now', ?2)
  AND caller_id = ?3
GROUP BY route_kind
ORDER BY requests DESC, route_kind
LIMIT 12;

-- name: StatsCacheTotals :one
SELECT
  COUNT(*) AS total_entries,
  SUM(CASE WHEN expires_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS fresh_entries,
  SUM(CASE WHEN expires_at <= CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS expired_entries,
  COALESCE(SUM(length(body_json)), 0) AS body_bytes
FROM github_cache_entries
WHERE pool_id = ?1;
