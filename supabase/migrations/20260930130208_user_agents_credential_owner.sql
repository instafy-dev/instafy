-- An agent pins only a credential its owner holds.
--
-- user_agents.credential_id names the credential an agent runs on. The
-- controller checks ownership wherever it pins one (agent create and update,
-- credential-seeded agents), and dispatch resolves an agent's pinned
-- credential only when the agent's owner holds it. As defence in depth, this
-- trigger applies the same rule to every write that sets credential_id or
-- user_id, whichever role makes it.
--
-- Stored rows are neither checked nor rewritten here, so nothing can block
-- this migration; dispatch already ignores a stored pin whose credential
-- belongs to someone else. Only a function and a trigger are added.
set local lock_timeout = '5s';

create or replace function public.user_agents_credential_owner_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.credential_id is not null and not exists (
    select 1
      from public.user_credentials
      where id = new.credential_id
        and user_id = new.user_id
  ) then
    raise exception 'an agent can only use a credential its owner holds'
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.user_agents_credential_owner_check()
  from public, anon, authenticated;

drop trigger if exists user_agents_credential_owner on public.user_agents;
create trigger user_agents_credential_owner
  before insert or update of credential_id, user_id on public.user_agents
  for each row
  execute function public.user_agents_credential_owner_check();
