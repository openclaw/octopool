CREATE TABLE IF NOT EXISTS leases (
  route_key TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_states (
  identity_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  limit_count INTEGER NOT NULL DEFAULT 5000,
  remaining INTEGER NOT NULL,
  reset_at INTEGER NOT NULL,
  PRIMARY KEY (identity_id, resource)
);

CREATE TABLE IF NOT EXISTS cooldowns (
  identity_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  status INTEGER NOT NULL,
  reason TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (identity_id, route_key)
);

CREATE INDEX IF NOT EXISTS leases_expiry ON leases(expires_at, route_key);
CREATE INDEX IF NOT EXISTS cooldowns_expiry ON cooldowns(expires_at, identity_id, route_key);

CREATE TABLE IF NOT EXISTS cache_fills (
  cache_key TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
