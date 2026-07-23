create index if not exists org_memberships_org_created_user_idx
  on org_memberships(org_id, created_at, user_id);
