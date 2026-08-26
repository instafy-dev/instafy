-- Idempotent message-stash creation -----------------------------------------
-- A stable client id makes a response-lost create safe to replay. This later
-- additive migration also upgrades databases that applied the initial Stash
-- migration before client-side idempotency was introduced.

alter table public.conversation_message_stashes
  add column if not exists client_stash_id text;

update public.conversation_message_stashes
set client_stash_id = 'legacy:' || id::text
where client_stash_id is null
   or client_stash_id <> btrim(client_stash_id)
   or length(client_stash_id) not between 1 and 200;

with duplicate_client_ids as (
  select id,
         row_number() over (
           partition by conversation_id, owner_user_id, client_stash_id
           order by created_at asc, id asc
         ) as duplicate_number
  from public.conversation_message_stashes
)
update public.conversation_message_stashes stashes
set client_stash_id = 'legacy-duplicate:' || stashes.id::text || ':' || gen_random_uuid()::text
from duplicate_client_ids duplicates
where stashes.id = duplicates.id
  and duplicates.duplicate_number > 1;

alter table public.conversation_message_stashes
  alter column client_stash_id set not null;

do $message_stash_client_id_constraint$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.conversation_message_stashes'::regclass
      and conname = 'conversation_message_stashes_client_stash_id_check'
  ) then
    alter table public.conversation_message_stashes
      add constraint conversation_message_stashes_client_stash_id_check
      check (
        client_stash_id = btrim(client_stash_id)
        and length(client_stash_id) between 1 and 200
      )
      not valid;
  end if;
end
$message_stash_client_id_constraint$;

alter table public.conversation_message_stashes
  validate constraint conversation_message_stashes_client_stash_id_check;

create unique index if not exists conversation_message_stashes_owner_client_id_uidx
  on public.conversation_message_stashes(
    conversation_id,
    owner_user_id,
    client_stash_id
  );
