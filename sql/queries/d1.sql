-- name: AuthenticateCaller :one
SELECT callers.id, callers.name, callers.github_login, callers.github_user_id, callers.org_login,
       callers.org_identity_verified_at AS org_verified_at,
       caller_tokens.id AS caller_token_id, caller_tokens.client_name
FROM caller_tokens
JOIN callers ON callers.id = caller_tokens.caller_id
JOIN caller_pools ON caller_pools.caller_id = callers.id
WHERE caller_tokens.token_hash = ?1
  AND callers.status = 'active'
  AND caller_pools.pool_id = ?2
LIMIT 1;

-- name: UpdateCallerOrgIdentityVerifiedAt :exec
UPDATE callers
SET org_identity_verified_at = ?1,
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

-- name: GetStringRewritePolicy :one
SELECT schema_version, revision, updated_at, rules_json
FROM string_rewrite_policy
WHERE id = 1;

-- name: ReplaceStringRewritePolicy :one
UPDATE string_rewrite_policy
SET revision = revision + 1, updated_at = ?1, rules_json = ?2
WHERE id = 1 AND schema_version = 1 AND revision = ?3
RETURNING revision, updated_at;

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

-- name: ListActivePublicIdentitiesForPool :many
SELECT DISTINCT identities.id, identities.kind, identities.login, identities.secret_ref, identities.installation_id, identities.weight
FROM identities
JOIN identity_scopes ON identity_scopes.identity_id = identities.id
WHERE identities.pool_id = ?1
  AND identities.status = 'active'
  AND identities.kind = 'pat'
  AND identity_scopes.owner = '*'
  AND identity_scopes.repo IS NULL;

-- name: InsertAudit :exec
INSERT INTO audit_events
  (request_id, caller_id, caller_token_id, client_name, pool_id, route_key, route_kind, identity_id, status,
   error_code, fallback_reason, backend, duration_ms, cache_status, cacheable, coalesced)
VALUES (?1, ?2, (SELECT id FROM caller_tokens WHERE id = ?3), ?4, ?5, ?6, ?7, ?8,
        ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16);

-- name: ReadGitHubCache :one
SELECT status, response_headers_json, body_json, body_encoding, identity_id, identity_kind, created_at, expires_at
FROM github_cache_entries
WHERE cache_key = ?1
  AND expires_at > CURRENT_TIMESTAMP;

-- name: ReadGitHubCacheAny :one
SELECT status, response_headers_json, body_json, body_encoding, identity_id, identity_kind,
       created_at, expires_at, stale_expires_at
FROM github_cache_entries
WHERE cache_key = ?1
  AND stale_expires_at > CURRENT_TIMESTAMP;

-- name: WriteGitHubCache :exec
INSERT INTO github_cache_entries
  (cache_key, pool_id, method, path, query_json, headers_json, route_key, route_kind,
   status, response_headers_json, body_json, body_encoding, identity_id, identity_kind,
   expires_at, stale_expires_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
ON CONFLICT(cache_key) DO UPDATE SET
  status = excluded.status,
  response_headers_json = excluded.response_headers_json,
  body_json = excluded.body_json,
  body_encoding = excluded.body_encoding,
  identity_id = excluded.identity_id,
  identity_kind = excluded.identity_kind,
  created_at = CURRENT_TIMESTAMP,
  expires_at = excluded.expires_at,
  stale_expires_at = excluded.stale_expires_at;

-- name: DeleteExpiredGitHubCacheBatch :exec
DELETE FROM github_cache_entries
WHERE cache_key IN (
  SELECT cache_key
  FROM github_cache_entries
  WHERE stale_expires_at <= CURRENT_TIMESTAMP
  ORDER BY stale_expires_at
  LIMIT ?1
);

-- name: DeleteOldAuditEventsBatch :exec
DELETE FROM audit_events
WHERE request_id IN (
  SELECT request_id
  FROM audit_events
  WHERE created_at < datetime(CURRENT_TIMESTAMP, '-30 days')
  ORDER BY created_at
  LIMIT ?1
);

-- name: DashboardIdentities :many
SELECT id, kind, login, installation_id, status, weight, updated_at
FROM identities
WHERE pool_id = ?1
ORDER BY status = 'active' DESC, weight DESC, id;

-- name: CacheTotals :one
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

-- name: DashboardClients :many
SELECT
  callers.github_login,
  audit_events.client_name,
  COUNT(*) AS requests,
  SUM(CASE WHEN audit_events.status >= 400 THEN 1 ELSE 0 END) AS errors,
  SUM(CASE WHEN audit_events.cache_status IN ('hit', 'stale') THEN 1 ELSE 0 END) AS saved_github_requests,
  SUM(CASE WHEN audit_events.cache_status IN ('miss', 'bypass') THEN 1 ELSE 0 END) AS backend_requests,
  MAX(audit_events.created_at) AS last_seen
FROM audit_events
JOIN callers ON callers.id = audit_events.caller_id
WHERE audit_events.pool_id = ?1
  AND audit_events.created_at >= datetime('now', '-7 days')
GROUP BY callers.github_login, audit_events.client_name
ORDER BY requests DESC, last_seen DESC
LIMIT 40;

-- name: UsageBackends :many
SELECT
  backend,
  route_kind,
  COUNT(*) AS requests,
  SUM(CASE WHEN cache_status = 'miss' THEN 1 ELSE 0 END) AS cache_misses,
  SUM(CASE WHEN cache_status = 'bypass' THEN 1 ELSE 0 END) AS cache_bypass,
  SUM(CASE WHEN fallback_reason = 'cache_revalidated' THEN 1 ELSE 0 END) AS revalidated,
  MAX(created_at) AS latest_seen_at
FROM audit_events
WHERE pool_id = ?1
  AND created_at >= datetime('now', ?2)
  AND backend IS NOT NULL
GROUP BY backend, route_kind
ORDER BY requests DESC, latest_seen_at DESC
LIMIT 20;

-- name: UsageFallbackReasons :many
SELECT
  COALESCE(fallback_reason, 'unknown') AS reason,
  route_kind,
  COUNT(*) AS requests,
  MAX(created_at) AS latest_seen_at
FROM audit_events
WHERE pool_id = ?1
  AND created_at >= datetime('now', ?2)
  AND error_code = 'fallback_local'
GROUP BY reason, route_kind
ORDER BY requests DESC, latest_seen_at DESC
LIMIT 20;

-- name: DashboardRecent :many
SELECT
  audit_events.created_at,
  callers.github_login,
  audit_events.client_name,
  audit_events.route_kind,
  audit_events.route_key,
  audit_events.identity_id,
  audit_events.status,
  audit_events.error_code,
  audit_events.fallback_reason,
  audit_events.duration_ms
FROM audit_events
JOIN callers ON callers.id = audit_events.caller_id
WHERE audit_events.pool_id = ?1
ORDER BY audit_events.created_at DESC
LIMIT 20;

-- name: DashboardRouteKeys7d :many
SELECT
  route_kind,
  route_key,
  COUNT(*) AS requests,
  SUM(CASE WHEN cache_status IN ('hit', 'stale') THEN 1 ELSE 0 END) AS cache_hits,
  SUM(CASE WHEN cache_status = 'miss' THEN 1 ELSE 0 END) AS cache_misses,
  SUM(CASE WHEN coalesced = 1 THEN 1 ELSE 0 END) AS coalesced,
  SUM(CASE WHEN error_code = 'fallback_local' THEN 1 ELSE 0 END) AS fallbacks,
  SUM(CASE
    WHEN status >= 400 AND COALESCE(error_code, '') <> 'fallback_local' THEN 1
    ELSE 0
  END) AS service_errors,
  MAX(created_at) AS latest_seen_at
FROM audit_events
WHERE pool_id = ?1
  AND created_at >= datetime('now', '-7 days')
GROUP BY route_kind, route_key
ORDER BY requests DESC, latest_seen_at DESC
LIMIT 16;

-- name: DashboardErrorCodes7d :many
SELECT
  CASE
    WHEN error_code = 'fallback_local' THEN COALESCE(fallback_reason, error_code)
    WHEN error_code IS NOT NULL THEN error_code
    ELSE 'github_status_' || status
  END AS outcome,
  route_kind,
  COUNT(*) AS requests,
  MAX(created_at) AS latest_seen_at
FROM audit_events
WHERE pool_id = ?1
  AND created_at >= datetime('now', '-7 days')
  AND status >= 400
GROUP BY outcome, route_kind
ORDER BY requests DESC, latest_seen_at DESC
LIMIT 16;

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
  COUNT(identities.id) AS identities_total,
  SUM(CASE WHEN identities.status = 'active' THEN 1 ELSE 0 END) AS identities_healthy
FROM pools
LEFT JOIN identities ON identities.pool_id = pools.id
WHERE pools.id = ?1
GROUP BY pools.id;

-- name: UpsertCallerEnrollment :one
INSERT INTO callers (id, name, token_hash, github_login, github_user_id, org_login, org_identity_verified_at, status)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active')
ON CONFLICT(github_user_id, org_login COLLATE NOCASE)
WHERE status = 'active' AND github_user_id IS NOT NULL
DO UPDATE SET
  name = excluded.name,
  github_login = excluded.github_login,
  org_identity_verified_at = excluded.org_identity_verified_at,
  updated_at = CURRENT_TIMESTAMP
RETURNING id, name, github_login, org_login;

-- name: UpsertCallerToken :exec
INSERT INTO caller_tokens (id, caller_id, token_hash, client_name, updated_at)
VALUES (?1, (
  SELECT enrolled.id FROM callers AS enrolled
  WHERE enrolled.github_user_id = ?2 AND enrolled.org_login = ?3 COLLATE NOCASE AND enrolled.status = 'active'
), ?4, ?5, strftime('%Y-%m-%d %H:%M:%f', 'now'))
ON CONFLICT(caller_id, client_name) DO UPDATE SET
  token_hash = excluded.token_hash,
  updated_at = excluded.updated_at;

-- name: PruneCallerTokens :exec
DELETE FROM caller_tokens
WHERE caller_tokens.caller_id = (
  SELECT enrolled.id FROM callers AS enrolled
  WHERE enrolled.github_user_id = ?1 AND enrolled.org_login = ?2 COLLATE NOCASE AND enrolled.status = 'active'
)
AND caller_tokens.client_name <> ?3
AND caller_tokens.id NOT IN (
  SELECT kept.id FROM caller_tokens AS kept
  WHERE kept.caller_id = (
    SELECT enrolled.id FROM callers AS enrolled
    WHERE enrolled.github_user_id = ?1 AND enrolled.org_login = ?2 COLLATE NOCASE AND enrolled.status = 'active'
  )
  AND kept.client_name <> ?3
  ORDER BY julianday(kept.updated_at) DESC, kept.rowid DESC
  LIMIT 15
);

-- name: InsertCallerPool :exec
INSERT INTO caller_pools (caller_id, pool_id)
VALUES ((
  SELECT enrolled.id FROM callers AS enrolled
  WHERE enrolled.github_user_id = ?1 AND enrolled.org_login = ?2 COLLATE NOCASE AND enrolled.status = 'active'
), ?3)
ON CONFLICT(caller_id, pool_id) DO NOTHING;

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
  callers.github_user_id,
  callers.org_login,
  callers.org_identity_verified_at AS org_verified_at,
  callers.dashboard_role,
  web_sessions.expires_at
FROM web_sessions
JOIN callers ON callers.id = web_sessions.caller_id
WHERE web_sessions.session_hash = ?1
  AND web_sessions.expires_at > CURRENT_TIMESTAMP
  AND callers.status = 'active'
  AND callers.org_login = ?2 COLLATE NOCASE;

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
INSERT INTO github_public_repos (owner, repo, is_public, checked_at, expires_at)
VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP, datetime(CURRENT_TIMESTAMP, ?4))
ON CONFLICT(owner, repo) DO UPDATE SET
  is_public = excluded.is_public,
  checked_at = excluded.checked_at,
  expires_at = excluded.expires_at;

-- name: CoveringPublicRepoProof :one
SELECT checked_at, expires_at
FROM github_public_repos
WHERE lower(owner) = ?1
  AND lower(repo) = ?2
  AND is_public = 1
  AND checked_at >= datetime(?3, '-5 seconds')
  AND expires_at > CURRENT_TIMESTAMP
LIMIT 1;

-- name: FreshNegativePublicRepoProof :one
SELECT checked_at, expires_at, is_public
FROM github_public_repos
WHERE lower(owner) = ?1
  AND lower(repo) = ?2
  AND is_public = 0
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

-- name: UpsertPublicApiRate :exec
INSERT INTO github_public_api_rates (resource, limit_count, remaining, reset_at, updated_at)
VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
ON CONFLICT(resource) DO UPDATE SET
  limit_count = excluded.limit_count,
  remaining = excluded.remaining,
  reset_at = excluded.reset_at,
  updated_at = CURRENT_TIMESTAMP;

-- name: UsageAggregate :one
SELECT
  COUNT(*) AS requests,
  SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
  SUM(CASE
    WHEN status >= 400 AND COALESCE(error_code, '') <> 'fallback_local' THEN 1
    ELSE 0
  END) AS service_errors,
  SUM(CASE WHEN error_code = 'fallback_local' THEN 1 ELSE 0 END) AS fallbacks,
  SUM(CASE
    WHEN error_code = 'fallback_local'
      AND COALESCE(fallback_reason, '') NOT IN (
        'logs_denied', 'owner_denied', 'repo_not_public', 'repo_public_check_failed',
        'route_denied', 'search_denied'
      )
    THEN 1 ELSE 0
  END) AS operational_fallbacks,
  SUM(CASE
    WHEN error_code = 'fallback_local'
      AND fallback_reason IN (
        'logs_denied', 'owner_denied', 'repo_not_public', 'repo_public_check_failed',
        'route_denied', 'search_denied'
      )
    THEN 1 ELSE 0
  END) AS denied,
  AVG(duration_ms) AS avg_duration_ms,
  SUM(CASE WHEN cache_status = 'hit' THEN 1 ELSE 0 END) AS cache_hits,
  SUM(CASE WHEN cache_status = 'stale' THEN 1 ELSE 0 END) AS cache_stale,
  SUM(CASE WHEN cache_status = 'miss' THEN 1 ELSE 0 END) AS cache_misses,
  SUM(CASE WHEN cache_status = 'bypass' THEN 1 ELSE 0 END) AS cache_bypass,
  SUM(CASE WHEN cache_status = 'unknown' THEN 1 ELSE 0 END) AS cache_unknown,
  SUM(CASE WHEN cacheable = 1 THEN 1 ELSE 0 END) AS cacheable_requests,
  SUM(CASE
    WHEN status < 400 AND cache_status IN ('hit', 'stale', 'miss') THEN 1
    ELSE 0
  END) AS eligible_cache_requests,
  SUM(CASE
    WHEN status < 400 AND cache_status IN ('hit', 'stale') THEN 1
    ELSE 0
  END) AS eligible_cache_hits,
  SUM(CASE WHEN coalesced = 1 THEN 1 ELSE 0 END) AS coalesced,
  MAX(created_at) AS latest_seen_at
FROM audit_events
WHERE pool_id = ?1
  AND created_at >= datetime('now', ?2)
  AND (?3 = '' OR caller_id = ?3)
  AND (?4 = '' OR client_name = ?4);

-- name: UsageRoutes :many
SELECT
  route_kind,
  COUNT(*) AS requests,
  SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
  SUM(CASE
    WHEN status >= 400 AND COALESCE(error_code, '') <> 'fallback_local' THEN 1
    ELSE 0
  END) AS service_errors,
  SUM(CASE WHEN error_code = 'fallback_local' THEN 1 ELSE 0 END) AS fallbacks,
  SUM(CASE
    WHEN error_code = 'fallback_local'
      AND COALESCE(fallback_reason, '') NOT IN (
        'logs_denied', 'owner_denied', 'repo_not_public', 'repo_public_check_failed',
        'route_denied', 'search_denied'
      )
    THEN 1 ELSE 0
  END) AS operational_fallbacks,
  AVG(duration_ms) AS avg_duration_ms,
  SUM(CASE WHEN cache_status = 'hit' THEN 1 ELSE 0 END) AS cache_hits,
  SUM(CASE WHEN cache_status = 'stale' THEN 1 ELSE 0 END) AS cache_stale,
  SUM(CASE WHEN cache_status = 'miss' THEN 1 ELSE 0 END) AS cache_misses,
  SUM(CASE WHEN cache_status = 'bypass' THEN 1 ELSE 0 END) AS cache_bypass,
  SUM(CASE WHEN cache_status = 'unknown' THEN 1 ELSE 0 END) AS cache_unknown,
  SUM(CASE WHEN cacheable = 1 THEN 1 ELSE 0 END) AS cacheable_requests,
  SUM(CASE
    WHEN status < 400 AND cache_status IN ('hit', 'stale', 'miss') THEN 1
    ELSE 0
  END) AS eligible_cache_requests,
  SUM(CASE
    WHEN status < 400 AND cache_status IN ('hit', 'stale') THEN 1
    ELSE 0
  END) AS eligible_cache_hits,
  SUM(CASE WHEN coalesced = 1 THEN 1 ELSE 0 END) AS coalesced,
  MAX(created_at) AS latest_seen_at
FROM audit_events
WHERE pool_id = ?1
  AND created_at >= datetime('now', ?2)
  AND (?3 = '' OR caller_id = ?3)
  AND (?4 = '' OR client_name = ?4)
GROUP BY route_kind
ORDER BY requests DESC, route_kind
LIMIT 12;

-- name: UsageClients :many
SELECT
  audit_events.client_name,
  COUNT(*) AS requests,
  SUM(CASE WHEN audit_events.status >= 400 THEN 1 ELSE 0 END) AS errors,
  SUM(CASE
    WHEN audit_events.status >= 400 AND COALESCE(audit_events.error_code, '') <> 'fallback_local'
    THEN 1 ELSE 0
  END) AS service_errors,
  SUM(CASE WHEN audit_events.error_code = 'fallback_local' THEN 1 ELSE 0 END) AS fallbacks,
  AVG(audit_events.duration_ms) AS avg_duration_ms,
  SUM(CASE WHEN audit_events.cache_status = 'hit' THEN 1 ELSE 0 END) AS cache_hits,
  SUM(CASE WHEN audit_events.cache_status = 'stale' THEN 1 ELSE 0 END) AS cache_stale,
  SUM(CASE WHEN audit_events.cache_status = 'miss' THEN 1 ELSE 0 END) AS cache_misses,
  SUM(CASE WHEN audit_events.cache_status = 'bypass' THEN 1 ELSE 0 END) AS cache_bypass,
  SUM(CASE WHEN audit_events.cache_status = 'unknown' THEN 1 ELSE 0 END) AS cache_unknown,
  SUM(CASE WHEN audit_events.cacheable = 1 THEN 1 ELSE 0 END) AS cacheable_requests,
  SUM(CASE
    WHEN audit_events.status < 400 AND audit_events.cache_status IN ('hit', 'stale', 'miss')
    THEN 1 ELSE 0
  END) AS eligible_cache_requests,
  SUM(CASE
    WHEN audit_events.status < 400 AND audit_events.cache_status IN ('hit', 'stale')
    THEN 1 ELSE 0
  END) AS eligible_cache_hits,
  SUM(CASE WHEN audit_events.coalesced = 1 THEN 1 ELSE 0 END) AS coalesced,
  MAX(audit_events.created_at) AS latest_seen_at
FROM audit_events
WHERE audit_events.pool_id = ?1
  AND audit_events.caller_id = ?2
  AND audit_events.created_at >= datetime('now', ?3)
GROUP BY audit_events.client_name
ORDER BY requests DESC, latest_seen_at DESC
LIMIT 40;
