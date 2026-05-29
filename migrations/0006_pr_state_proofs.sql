CREATE TABLE IF NOT EXISTS github_pr_state_proofs (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  state_hint TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (owner, repo, number, state_hint)
);

CREATE INDEX IF NOT EXISTS idx_github_pr_state_proofs_expires
  ON github_pr_state_proofs (expires_at);
