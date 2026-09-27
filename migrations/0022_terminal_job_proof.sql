CREATE INDEX idx_github_cache_job_proof
  ON github_cache_entries(pool_id, path)
  WHERE method = 'GET' AND route_kind = 'job_view' AND status = 200 AND body_encoding = 'json';
