-- Bind project invitations to a private conversation when they originate from
-- the chat invite surface. The controller validates this binding before issue
-- and uses it to grant conversation participation atomically on acceptance.
-- Fail instead of queueing production writes behind an unexpectedly long DDL
-- lock. Supabase applies this whole migration and its history row atomically,
-- so a lock timeout is safe to retry from the same pinned release.
set lock_timeout = '5s';

-- Accessible project discovery also includes owner-only projects. Keep that
-- lookup indexed alongside the existing membership and org indexes.
create index if not exists projects_owner_user_idx
  on projects(owner_user_id, status)
  where owner_user_id is not null;

alter table if exists org_invitations
  add column if not exists conversation_id uuid references conversations(id) on delete cascade;

alter table if exists org_invite_links
  add column if not exists conversation_id uuid references conversations(id) on delete cascade;

create index if not exists org_invitations_conversation_idx
  on org_invitations(conversation_id);

create index if not exists org_invite_links_conversation_idx
  on org_invite_links(conversation_id);

drop index if exists org_invitations_pending_project_unique;

create unique index if not exists org_invitations_pending_project_unique
  on org_invitations(org_id, project_id, email)
  where status = 'pending'
    and project_id is not null
    and conversation_id is null;

create unique index if not exists org_invitations_pending_conversation_unique
  on org_invitations(org_id, project_id, conversation_id, email)
  where status = 'pending'
    and project_id is not null
    and conversation_id is not null;

reset lock_timeout;
