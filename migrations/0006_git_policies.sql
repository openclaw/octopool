CREATE TABLE IF NOT EXISTS caller_git_policies (
  caller_id TEXT NOT NULL REFERENCES callers(id) ON DELETE CASCADE,
  pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  allow_fetch INTEGER NOT NULL DEFAULT 0 CHECK (allow_fetch IN (0, 1)),
  allow_push INTEGER NOT NULL DEFAULT 0 CHECK (allow_push IN (0, 1)),
  push_branch_globs_json TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (caller_id, pool_id, owner, repo)
);

CREATE INDEX IF NOT EXISTS idx_caller_git_policies_repo
  ON caller_git_policies(pool_id, owner, repo);
