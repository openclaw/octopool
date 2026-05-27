-- name: CreateLeasesTable :exec
CREATE TABLE IF NOT EXISTS leases (
  route_key TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- name: CreateRateStatesTable :exec
CREATE TABLE IF NOT EXISTS rate_states (
  identity_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  remaining INTEGER NOT NULL,
  reset_at INTEGER NOT NULL,
  PRIMARY KEY (identity_id, resource)
);

-- name: CreateCooldownsTable :exec
CREATE TABLE IF NOT EXISTS cooldowns (
  identity_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  status INTEGER NOT NULL,
  reason TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (identity_id, route_key)
);

-- name: GetLease :one
SELECT identity_id, expires_at
FROM leases
WHERE route_key = ?;

-- name: GetRateState :one
SELECT remaining, reset_at
FROM rate_states
WHERE identity_id = ?
  AND resource = ?;

-- name: UpsertLease :exec
INSERT INTO leases (route_key, identity_id, expires_at)
VALUES (?1, ?2, ?3)
ON CONFLICT(route_key) DO UPDATE SET
  identity_id = excluded.identity_id,
  expires_at = excluded.expires_at;

-- name: UpsertRateState :exec
INSERT INTO rate_states (identity_id, resource, remaining, reset_at)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT(identity_id, resource) DO UPDATE SET
  remaining = excluded.remaining,
  reset_at = excluded.reset_at;

-- name: UpsertCooldown :exec
INSERT INTO cooldowns (identity_id, route_key, status, reason, expires_at)
VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT(identity_id, route_key) DO UPDATE SET
  status = excluded.status,
  reason = excluded.reason,
  expires_at = excluded.expires_at;

-- name: CoordinatorRates :many
SELECT identity_id, resource, remaining, reset_at
FROM rate_states
WHERE reset_at > ?
ORDER BY identity_id, resource;

-- name: CoordinatorCooldowns :many
SELECT identity_id, route_key, status, reason, expires_at
FROM cooldowns
WHERE expires_at > ?
ORDER BY expires_at;

-- name: CoordinatorLeases :many
SELECT route_key, identity_id, expires_at
FROM leases
WHERE expires_at > ?
ORDER BY expires_at;

-- name: GetCooldownExpiresAt :one
SELECT expires_at
FROM cooldowns
WHERE identity_id = ?
  AND route_key = ?;
