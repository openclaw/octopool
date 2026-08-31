-- name: AcquirePublicationOwner :one
INSERT INTO cache_publication_owners
  (protocol_epoch, resource_key, owner_token, lease_until_ms)
SELECT ?1, ?2, ?3,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
    + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER) + ?4
WHERE NOT EXISTS (
  SELECT 1 FROM cache_publication_owners
  WHERE protocol_epoch = ?1 AND resource_key = ?2
    AND lease_until_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
)
ON CONFLICT(protocol_epoch, resource_key) DO UPDATE SET
  id = excluded.id,
  owner_token = excluded.owner_token,
  lease_until_ms = excluded.lease_until_ms
WHERE cache_publication_owners.lease_until_ms <=
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
    + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
RETURNING id, protocol_epoch, resource_key, owner_token, lease_until_ms;

-- name: ReadPublicationOwner :one
SELECT id, protocol_epoch, resource_key, owner_token, lease_until_ms
FROM cache_publication_owners
WHERE protocol_epoch = ?1 AND resource_key = ?2;

-- name: RenewPublicationOwner :one
UPDATE cache_publication_owners
SET lease_until_ms = MAX(lease_until_ms,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
    + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER) + ?5)
WHERE protocol_epoch = ?1 AND resource_key = ?2 AND id = ?3 AND owner_token = ?4
  AND lease_until_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
RETURNING id, protocol_epoch, resource_key, owner_token, lease_until_ms;

-- name: CompletePublicationOwner :one
DELETE FROM cache_publication_owners
WHERE protocol_epoch = ?1 AND resource_key = ?2 AND id = ?3 AND owner_token = ?4
  AND lease_until_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
RETURNING id;

-- name: RevokePublicationOwner :one
DELETE FROM cache_publication_owners
WHERE protocol_epoch = ?1 AND resource_key = ?2 AND id = ?3 AND owner_token = ?4
RETURNING id, lease_until_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
  + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER) AS was_live;

-- name: DeleteExpiredPublicationOwners :many
DELETE FROM cache_publication_owners
WHERE id IN (
  SELECT id FROM cache_publication_owners
  WHERE lease_until_ms <= CAST(strftime('%s', 'now') AS INTEGER) * 1000
    + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
  ORDER BY lease_until_ms, id
  LIMIT ?1
)
RETURNING id;

-- name: AuthorizeEdgePublication :one
UPDATE cache_publication_owners
SET lease_until_ms = lease_until_ms
WHERE protocol_epoch = ?1 AND resource_key = ?2 AND id = ?3 AND owner_token = ?4
  AND lease_until_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
  AND ?5 > strftime('%Y-%m-%d %H:%M:%f', 'now')
RETURNING id;
