-- name: CreateBackendPermits :exec
CREATE TABLE IF NOT EXISTS backend_permits (
  permit_id TEXT PRIMARY KEY,
  client_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL
);

-- name: CreateBackendPermitsClientIndex :exec
CREATE INDEX IF NOT EXISTS backend_permits_client ON backend_permits(client_key, expires_at);

-- name: CreateBackendPermitsExpiryIndex :exec
CREATE INDEX IF NOT EXISTS backend_permits_expiry ON backend_permits(expires_at);

-- name: DrainBackendPermits :exec
DELETE FROM backend_permits WHERE permit_id IN (
  SELECT old.permit_id FROM backend_permits AS old WHERE old.expires_at <= ?1 ORDER BY old.expires_at LIMIT 64
);

-- name: ReadBackendPermit :one
SELECT client_key, expires_at, deadline FROM backend_permits WHERE permit_id = ?1;

-- name: CountBackendPermits :one
SELECT COUNT(*) AS count FROM backend_permits WHERE client_key = ?1 AND expires_at > ?2;

-- name: InsertBackendPermit :exec
INSERT INTO backend_permits (permit_id, client_key, expires_at, deadline) VALUES (?1, ?2, ?3, ?4);

-- name: RenewBackendPermit :one
UPDATE backend_permits SET expires_at = MIN(deadline, MAX(expires_at, ?3))
WHERE permit_id = ?1 AND expires_at > ?2 AND deadline > ?2
RETURNING expires_at, deadline;

-- name: ReleaseBackendPermit :exec
DELETE FROM backend_permits WHERE permit_id = ?1;
