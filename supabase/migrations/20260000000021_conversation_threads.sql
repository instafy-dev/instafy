-- Conversation threads + last-message indexing.
--
-- Note: Instafy Studio is not live yet; no backfills/migrations required beyond schema updates.

alter table if exists conversations
  add column if not exists parent_conversation_id uuid references conversations(id) on delete cascade,
  add column if not exists root_conversation_id uuid,
  add column if not exists thread_kind text,
  add column if not exists last_message_id uuid,
  add column if not exists last_message_at timestamptz,
  add column if not exists last_message_preview text;

do $$
declare
  conversations_regclass regclass;
begin
  conversations_regclass := to_regclass('public.conversations');
  if conversations_regclass is null then
    return;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'conversations_parent_not_self'
      and conrelid = conversations_regclass
  ) then
    execute 'alter table public.conversations add constraint conversations_parent_not_self check (parent_conversation_id is null or parent_conversation_id <> id)';
  end if;
end $$;

create index if not exists conversations_parent_idx
  on conversations(parent_conversation_id);
create index if not exists conversations_root_idx
  on conversations(root_conversation_id);
create index if not exists conversations_project_parent_idx
  on conversations(project_id, parent_conversation_id);
create index if not exists conversations_project_root_idx
  on conversations(project_id, root_conversation_id);
create index if not exists conversations_project_last_message_idx
  on conversations(project_id, last_message_at desc);
