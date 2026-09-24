CREATE TABLE backend_permits (
  permit_id TEXT PRIMARY KEY,
  client_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL
);
CREATE INDEX backend_permits_client ON backend_permits(client_key, expires_at);
CREATE INDEX backend_permits_expiry ON backend_permits(expires_at);
