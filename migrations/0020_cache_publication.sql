CREATE TABLE cache_publication_owners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protocol_epoch TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  lease_until_ms INTEGER NOT NULL,
  UNIQUE(protocol_epoch, resource_key),
  CONSTRAINT owner_fence_safe_integer CHECK (id BETWEEN 1 AND 9007199254740991)
);

CREATE INDEX cache_publication_owners_expiry
  ON cache_publication_owners(lease_until_ms);

ALTER TABLE github_cache_entries ADD COLUMN publication_epoch TEXT;
ALTER TABLE github_cache_entries ADD COLUMN publication_id INTEGER;
ALTER TABLE github_cache_entries ADD COLUMN publication_token TEXT;

-- Legacy proof writers cannot address the new reader's conflict target.
CREATE TABLE github_public_repo_proofs (
  protocol_epoch TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  is_public INTEGER NOT NULL CHECK (is_public IN (0, 1)),
  checked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  publication_id INTEGER NOT NULL,
  publication_token TEXT NOT NULL,
  PRIMARY KEY(protocol_epoch, owner, repo)
);

CREATE INDEX github_public_repo_proofs_expiry ON github_public_repo_proofs(expires_at);
