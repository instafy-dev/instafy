-- Durable composer delivery modes ------------------------------------------
-- Queue entries are private, owner-scoped pending prompts. A stable client
-- id makes enqueue retries safe, while deterministic indexes keep per-owner
-- ordering stable when timestamps collide.

alter table if exists public.conversation_send_queue
  add column if not exists client_send_id text;

do $send_queue_status_constraint$
begin
  if to_regclass('public.conversation_send_queue') is not null
     and not exists (
       select 1
       from pg_constraint
       where conrelid = 'public.conversation_send_queue'::regclass
         and conname = 'conversation_send_queue_status_check'
     ) then
    alter table public.conversation_send_queue
      add constraint conversation_send_queue_status_check
      check (status in ('queued', 'dispatched', 'recorded', 'canceled', 'failed'))
      not valid;
  end if;
end
$send_queue_status_constraint$;

alter table if exists public.conversation_send_queue
  validate constraint conversation_send_queue_status_check;

do $send_queue_client_id_constraint$
begin
  if to_regclass('public.conversation_send_queue') is not null
     and not exists (
       select 1
       from pg_constraint
       where conrelid = 'public.conversation_send_queue'::regclass
         and conname = 'conversation_send_queue_client_send_id_check'
     ) then
    alter table public.conversation_send_queue
      add constraint conversation_send_queue_client_send_id_check
      check (
        client_send_id is null
        or (
          client_send_id = btrim(client_send_id)
          and length(client_send_id) between 1 and 200
        )
      )
      not valid;
  end if;
end
$send_queue_client_id_constraint$;

alter table if exists public.conversation_send_queue
  validate constraint conversation_send_queue_client_send_id_check;

create unique index if not exists conversation_send_queue_owner_client_send_uidx
  on public.conversation_send_queue(conversation_id, user_id, client_send_id)
  where user_id is not null and client_send_id is not null;

create index if not exists conversation_send_queue_owner_order_idx
  on public.conversation_send_queue(
    conversation_id,
    user_id,
    status,
    created_at,
    id
  );

do $send_queue_owner_fk$
begin
  if to_regclass('public.conversation_send_queue') is not null
     and not exists (
       select 1
       from pg_constraint
       where conrelid = 'public.conversation_send_queue'::regclass
         and conname = 'conversation_send_queue_user_id_fkey'
     ) then
    alter table public.conversation_send_queue
      add constraint conversation_send_queue_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade
      not valid;
  end if;
end
$send_queue_owner_fk$;

-- Historical versions allowed nullable, unconstrained owners. NOT VALID still
-- enforces the FK for new rows without making an additive deploy fail on an
-- old orphan; cleanup and validation can follow in a separately audited
-- migration.

-- A stash is an opaque composer snapshot. It is deliberately separate from
-- prompts, transcript messages, runs, jobs, and the send queue: saving one has
-- no execution or auto-drain semantics.
create table if not exists public.conversation_message_stashes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  client_stash_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversation_message_stashes_payload_check
    check (
      jsonb_typeof(payload) = 'object'
      and payload ? 'text'
      and jsonb_typeof(payload->'text') = 'string'
      and payload ? 'editorState'
      and payload ? 'composerEnvelope'
      and jsonb_typeof(payload->'composerEnvelope') = 'object'
    )
);

create index if not exists conversation_message_stashes_owner_order_idx
  on public.conversation_message_stashes(
    conversation_id,
    owner_user_id,
    updated_at desc,
    id desc
  );

alter table if exists public.conversation_message_stashes enable row level security;

drop policy if exists "conversation message stashes service role"
  on public.conversation_message_stashes;
create policy "conversation message stashes service role"
  on public.conversation_message_stashes
  for all
  using (public.current_request_role() = 'service_role')
  with check (public.current_request_role() = 'service_role');

drop policy if exists "conversation message stashes own read"
  on public.conversation_message_stashes;
create policy "conversation message stashes own read"
  on public.conversation_message_stashes
  for select
  using (
    auth.uid() is not null
    and owner_user_id = auth.uid()
    and public.has_project_access(project_id)
    and public.has_conversation_access(conversation_id)
  );

revoke insert, update, delete, truncate, references, trigger
  on table public.conversation_message_stashes
  from anon, authenticated;
