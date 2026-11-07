-- Global expiry pruning cannot use the caller-prefixed session index.
CREATE INDEX IF NOT EXISTS idx_web_sessions_expires
  ON web_sessions(expires_at);
