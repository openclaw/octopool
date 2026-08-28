CREATE TABLE string_rewrite_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  rules_json TEXT NOT NULL
);

INSERT INTO string_rewrite_policy (id, schema_version, revision, updated_at, rules_json)
VALUES (1, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '[]');
