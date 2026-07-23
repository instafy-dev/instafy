alter table if exists org_invitations
  add column if not exists project_id uuid references projects(id) on delete cascade;

create index if not exists org_invitations_project_idx on org_invitations(project_id);

drop index if exists org_invitations_pending_unique;

create unique index if not exists org_invitations_pending_org_unique
  on org_invitations(org_id, email)
  where status = 'pending' and project_id is null;

create unique index if not exists org_invitations_pending_project_unique
  on org_invitations(org_id, project_id, email)
  where status = 'pending' and project_id is not null;
