-- list_org_projects and org entitlement checks filter `where org_id = $1`, but
-- projects had no index leading with org_id (only projects_repo_unique and
-- projects_cleanup_idx(project_type,status,expires_at)), so every org project
-- listing was a full-table seqscan. Add a composite index matching the query
-- (org_id + status filter). projects is small today, so this builds instantly.
create index if not exists projects_org_idx on projects (org_id, status);
