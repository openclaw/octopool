-- Ambiguous active enrollments must fail this upgrade; never choose or merge owners.
CREATE UNIQUE INDEX idx_callers_active_github_org
ON callers (github_user_id, org_login COLLATE NOCASE)
WHERE status = 'active' AND github_user_id IS NOT NULL;
