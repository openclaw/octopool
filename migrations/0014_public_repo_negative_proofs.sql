ALTER TABLE github_public_repos
  ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1;
