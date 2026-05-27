ALTER TABLE audit_events ADD COLUMN cache_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (cache_status IN ('hit', 'miss', 'bypass', 'unknown'));

ALTER TABLE audit_events ADD COLUMN cacheable INTEGER NOT NULL DEFAULT 0
  CHECK (cacheable IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_audit_pool_cache_created
  ON audit_events(pool_id, cache_status, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_pool_route_cache_created
  ON audit_events(pool_id, route_kind, cache_status, created_at);
