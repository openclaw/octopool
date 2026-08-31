-- Only identity-bound verification can populate this proof; never backfill legacy timestamps.
ALTER TABLE callers ADD COLUMN org_identity_verified_at TEXT;
