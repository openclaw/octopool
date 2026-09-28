-- NULL for cache-served, live, and non-cache requests, including historical rows.
ALTER TABLE audit_events ADD COLUMN cache_miss_reason TEXT;
