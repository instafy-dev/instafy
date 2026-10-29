set local lock_timeout = '5s';

-- A job keeps the credential it was queued with in agent_jobs.credential_id,
-- and the job lease reads a job without one as a platform job: it mints a job
-- token with no credential, which the proxy serves on Instafy's own key. The
-- column references user_credentials on delete set null, so deleting a
-- credential row, which deleting its person does too, turned a queued or
-- running job on that person's own AI into a platform job. The controller's
-- own revoke keeps the row, and a lease for a revoked credential stops the
-- work pinned to it. This trigger gives a deleted row the same answer: an AI
-- job still queued or leased when its credential is cleared fails in the
-- statement that clears it, so no lease can take it again. It never refuses
-- the delete.
--
-- credential_removed_at: when that happened, so the controller can settle the
-- job's run and say why in its conversation. Only this trigger writes it.
--
-- Its own file: it holds ACCESS EXCLUSIVE on agent_jobs, so it may lock no
-- other table that existed before it (MIGRATIONS.md). The column is nullable
-- with no default, so adding it rewrites nothing.
alter table public.agent_jobs
  add column credential_removed_at timestamptz;

create or replace function public.fail_agent_job_on_credential_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A terminal command needs no AI, so it may stay queued. Its case is folded
  -- as the controller and the runtime fold it, ASCII only: under a libc or
  -- builtin collation lower() also turns 'İ' into 'i', which would leave an
  -- AI turn spelled 'TERMİNAL_COMMAND' queued without its credential.
  if old.credential_id is not null
     and new.credential_id is null
     and new.status in ('queued', 'leased')
     and lower(btrim(coalesce(new.intent, '')) collate "C") <> 'terminal_command' then
    new.status := 'failed';
    new.outcome := 'failed';
    -- "credential not found" is the prefix Studio reads as "connect an AI".
    -- The controller's CREDENTIAL_REMOVED_MESSAGE repeats these words.
    new.error_message := 'credential not found: the AI connection this turn was sent with was removed, so it stopped here. Connect an AI and send it again.';
    new.completed_at := now();
    new.lease_expires_at := null;
    new.credential_removed_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.fail_agent_job_on_credential_removal()
  from public, anon, authenticated;

-- Its name sorts before reject_agent_job_inputs_on_lease_end, which then sees
-- the failed status and rejects the inputs a leased job never acknowledged.
-- A referential action's update names credential_id, so the column list
-- still fires it.
create or replace trigger agent_jobs_fail_on_credential_removal
  before update of credential_id on public.agent_jobs
  for each row
  execute function public.fail_agent_job_on_credential_removal();
