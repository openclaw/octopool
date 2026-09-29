-- Publication triggers share the body's guarded transaction. Old entries warm
-- this index only when republished; no body scan/backfill is required at upgrade.
CREATE TABLE github_run_list_items (
  cache_key TEXT NOT NULL REFERENCES github_cache_entries(cache_key) ON DELETE CASCADE,
  pool_id TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  PRIMARY KEY(cache_key, run_id)
) WITHOUT ROWID;

CREATE INDEX idx_github_run_list_item_lookup
  ON github_run_list_items(pool_id, repo_path, run_id);

CREATE TRIGGER github_run_list_items_insert
AFTER INSERT ON github_cache_entries
WHEN NEW.method = 'GET' AND NEW.route_kind IN ('run_list', 'workflow_run_list')
  AND NEW.status = 200 AND NEW.body_encoding = 'json'
BEGIN
  INSERT INTO github_run_list_items (cache_key, pool_id, repo_path, run_id)
  SELECT NEW.cache_key, NEW.pool_id,
    lower(substr(NEW.path, 1, instr(NEW.path, '/actions/') - 1)), json_extract(value, '$.id')
  FROM json_each(CASE WHEN json_valid(NEW.body_json) AND json_valid(NEW.headers_json)
    THEN CASE WHEN json_type(NEW.body_json, '$.workflow_runs') = 'array'
      AND json_array_length(NEW.body_json, '$.workflow_runs') <= 100
      AND json_extract(NEW.headers_json, '$."x-octopool-public-shape"') IS NULL
      THEN NEW.body_json END END, '$.workflow_runs')
  WHERE type = 'object' AND json_type(value, '$.id') = 'integer'
    AND json_extract(value, '$.id') BETWEEN 1 AND 9007199254740991
  GROUP BY json_extract(value, '$.id') HAVING count(*) = 1;
END;

CREATE TRIGGER github_run_list_items_update
AFTER UPDATE OF body_json, publication_id ON github_cache_entries
WHEN OLD.route_kind IN ('run_list', 'workflow_run_list')
  OR NEW.route_kind IN ('run_list', 'workflow_run_list')
BEGIN
  DELETE FROM github_run_list_items WHERE cache_key = OLD.cache_key;
  INSERT INTO github_run_list_items (cache_key, pool_id, repo_path, run_id)
  SELECT NEW.cache_key, NEW.pool_id,
    lower(substr(NEW.path, 1, instr(NEW.path, '/actions/') - 1)), json_extract(value, '$.id')
  FROM json_each(CASE WHEN json_valid(NEW.body_json) AND json_valid(NEW.headers_json)
    THEN CASE WHEN NEW.method = 'GET' AND NEW.route_kind IN ('run_list', 'workflow_run_list')
      AND NEW.status = 200 AND NEW.body_encoding = 'json'
      AND json_type(NEW.body_json, '$.workflow_runs') = 'array'
      AND json_array_length(NEW.body_json, '$.workflow_runs') <= 100
      AND json_extract(NEW.headers_json, '$."x-octopool-public-shape"') IS NULL
      THEN NEW.body_json END END, '$.workflow_runs')
  WHERE type = 'object' AND json_type(value, '$.id') = 'integer'
    AND json_extract(value, '$.id') BETWEEN 1 AND 9007199254740991
  GROUP BY json_extract(value, '$.id') HAVING count(*) = 1;
END;
