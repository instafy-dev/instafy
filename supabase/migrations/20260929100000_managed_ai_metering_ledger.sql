-- Managed AI metering, part 1 of 2: the credit ledger. The metering tables
-- follow in 20260929100100_managed_ai_metering_tables.sql.
--
-- The two parts are separate migrations, so each commits on its own and no
-- transaction holds a lock on org_credit_ledger and a lock on agent_jobs at
-- once. Live requests take those two tables in both orders: completion and the
-- expired-job sweep update agent_jobs and then write the ledger, while
-- dispatch and deferred billing write the ledger and then agent_jobs. The
-- ALTER below holds an ACCESS EXCLUSIVE lock on the ledger until commit, and
-- each foreign key to agent_jobs in part 2 holds a SHARE ROW EXCLUSIVE lock on
-- agent_jobs until commit. In one transaction, whichever of the two came
-- second would wait on a request that already waits on this migration, and
-- Postgres breaks that deadlock by aborting one side, which can be the
-- request. Apart, each part only waits for requests to finish, and
-- lock_timeout bounds that wait.
set local lock_timeout = '5s';

-- A metered debit is posted after the request already ran upstream, so it may
-- take the balance below zero. Every other debit is still refused there.
alter table public.org_credit_ledger
  add column if not exists allow_overdraft boolean not null default false;
-- Serves the daily refill window lookup (org_id, reason, newest first).
create index if not exists org_credit_ledger_org_reason_created_idx
  on public.org_credit_ledger(org_id, reason, created_at desc);

-- The balance guard with the metering semantics: a debit with allow_overdraft
-- may leave the balance negative, a credit into a still-negative balance is
-- allowed, and a row whose idempotency key already exists is skipped without
-- moving the balance. The row trigger fires before ON CONFLICT is checked, so
-- without the skip a duplicate `insert ... on conflict do nothing` still moved
-- the balance.
create or replace function public.org_credit_ledger_before_insert() returns trigger as $$
declare current_balance int;
begin
  insert into public.org_credit_balances(org_id) values (new.org_id) on conflict (org_id) do nothing;
  select balance into current_balance from public.org_credit_balances where org_id = new.org_id for update;
  -- Skip a duplicate key with no side effect. This runs after the balance lock, so a
  -- concurrent insert of the same key has committed and is visible here. It mirrors the
  -- unique index: a NULL project never matches. The index predicate is repeated so the
  -- lookup can use that partial index.
  if new.idempotency_key is not null and new.idempotency_key <> '' and exists (
       select 1 from public.org_credit_ledger l
       where l.org_id = new.org_id and l.project_id = new.project_id
         and l.idempotency_key = new.idempotency_key
         and l.idempotency_key is not null and l.idempotency_key <> '') then
    return null;
  end if;
  current_balance := coalesce(current_balance, 0) + new.delta;
  if new.delta < 0 and current_balance < 0 and not new.allow_overdraft then
    raise exception 'Insufficient credits for org %', new.org_id;
  end if;
  update public.org_credit_balances set balance = current_balance, updated_at = now() where org_id = new.org_id;
  new.balance_after := current_balance;
  return new;
end; $$ language plpgsql;
