-- A repeated idempotency key must never move the org balance.
--
-- org_credit_ledger_before_insert() is a BEFORE INSERT row trigger, so it
-- moved org_credit_balances before the unique index on
-- (org_id, project_id, idempotency_key) was checked. An
-- "insert ... on conflict do nothing" that repeated a key therefore wrote no
-- ledger row but still debited or credited the balance.
--
-- The trigger now skips such a row under the org balance lock, before it
-- touches the balance. Every ledger insert takes that lock first, so a
-- concurrent post of the same key waits for the first one to commit and then
-- sees its row. The check mirrors org_credit_ledger_idempotency_unique
-- exactly: a row without a project, or with a NULL or empty key, never
-- dedupes. A skipped row is not inserted, so both "on conflict do nothing"
-- and a plain insert report zero rows; a plain insert of a repeated key no
-- longer raises 23505.
--
-- Only the function body changes: no table is altered, locked or rewritten.
set local lock_timeout = '5s';

create or replace function public.org_credit_ledger_before_insert()
returns trigger as $$
declare
  current_balance int;
begin
  insert into org_credit_balances(org_id)
    values (new.org_id)
    on conflict (org_id) do nothing;

  select balance into current_balance
    from org_credit_balances
    where org_id = new.org_id
    for update;

  -- The index predicate is repeated inside the exists so that a generic plan
  -- can prove the partial unique index applies and scan only that index.
  if new.project_id is not null
     and new.idempotency_key is not null
     and new.idempotency_key <> ''
     and exists (
       select 1
         from org_credit_ledger
         where org_id = new.org_id
           and project_id = new.project_id
           and idempotency_key = new.idempotency_key
           and idempotency_key is not null
           and idempotency_key <> ''
     ) then
    return null;
  end if;

  current_balance := coalesce(current_balance, 0) + new.delta;

  if current_balance < 0 then
    raise exception 'Insufficient credits for org %', new.org_id;
  end if;

  update org_credit_balances
    set balance = current_balance,
        updated_at = now()
    where org_id = new.org_id;

  new.balance_after := current_balance;
  return new;
end;
$$ language plpgsql;
