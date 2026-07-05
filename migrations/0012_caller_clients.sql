CREATE TABLE caller_tokens (
  id TEXT PRIMARY KEY,
  caller_id TEXT NOT NULL REFERENCES callers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (caller_id, client_name)
);

INSERT INTO caller_tokens (id, caller_id, token_hash, client_name)
SELECT 'legacy_' || id, id, token_hash, 'legacy'
FROM callers;

CREATE INDEX idx_caller_tokens_caller ON caller_tokens(caller_id, updated_at);

ALTER TABLE audit_events ADD COLUMN caller_token_id TEXT
  REFERENCES caller_tokens(id) ON DELETE SET NULL;

ALTER TABLE audit_events ADD COLUMN client_name TEXT;

UPDATE audit_events
SET caller_token_id = 'legacy_' || caller_id,
    client_name = 'legacy'
WHERE caller_id IS NOT NULL;

CREATE INDEX idx_audit_caller_token_created
  ON audit_events(caller_token_id, created_at);

CREATE INDEX idx_audit_caller_client_created
  ON audit_events(caller_id, client_name, created_at);
