-- Executed only by scripts/test-durable-notifications.py in its disposable cluster.
-- A repeated idempotency key must neither write a second ledger row nor move the
-- org balance, and the dedupe must match org_credit_ledger_idempotency_unique.
create function credit_ledger_test_assert(ok boolean, label text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'credit ledger test failed: %',label; end if; end; $$;
-- The balance must always equal the opening balance plus the ledger rows.
create function credit_ledger_test_explained(org uuid, opening int) returns boolean language sql as $$
  select b.balance=opening+coalesce((select sum(delta) from org_credit_ledger l where l.org_id=org),0)
  from org_credit_balances b where b.org_id=org; $$;
insert into organizations(id,slug,name) values
  ('30000000-0000-0000-0000-000000000001','ledger-fixture-a','Ledger fixture A'),
  ('30000000-0000-0000-0000-000000000002','ledger-fixture-b','Ledger fixture B');
insert into projects(id,org_id,name) values
  ('30000000-0000-0000-0000-000000000010','30000000-0000-0000-0000-000000000001','Ledger fixture'),
  ('30000000-0000-0000-0000-000000000011','30000000-0000-0000-0000-000000000001','Ledger fixture sibling'),
  ('30000000-0000-0000-0000-000000000020','30000000-0000-0000-0000-000000000002','Ledger fixture other org');
insert into org_credit_balances(org_id,balance) values
  ('30000000-0000-0000-0000-000000000001',100),
  ('30000000-0000-0000-0000-000000000002',100);

-- A retried burn, shaped like the controller's insert, debits once.
insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
  ('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000010',-5,'managed_ai_prompt','burn-key')
  on conflict do nothing;
with retried as (
  insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
    ('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000010',-5,'managed_ai_prompt','burn-key')
    on conflict do nothing returning id)
select credit_ledger_test_assert((select count(*)=0 from retried),'a retried burn writes no row');
select credit_ledger_test_assert((select balance=95 from org_credit_balances where org_id='30000000-0000-0000-0000-000000000001'),'a retried burn debits once');
select credit_ledger_test_assert((select count(*)=1 from org_credit_ledger where org_id='30000000-0000-0000-0000-000000000001' and idempotency_key='burn-key'),'a retried burn keeps one row');

-- A retried credit (a refill or a refund) credits once.
insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
  ('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000010',50,'refill','credit-key')
  on conflict do nothing;
insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
  ('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000010',50,'refill','credit-key')
  on conflict do nothing;
select credit_ledger_test_assert((select balance=145 from org_credit_balances where org_id='30000000-0000-0000-0000-000000000001'),'a retried credit credits once');
select credit_ledger_test_assert((select count(*)=1 from org_credit_ledger where org_id='30000000-0000-0000-0000-000000000001' and idempotency_key='credit-key'),'a retried credit keeps one row');

-- The key alone dedupes: neither the reason nor the amount matters, a plain insert
-- reports zero rows instead of 23505, and a repeat that would overdraw is still a no-op.
with retried as (
  insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
    ('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000010',7,'managed_ai_refund','burn-key')
    returning id)
select credit_ledger_test_assert((select count(*)=0 from retried),'a plain insert of a repeated key inserts nothing');
insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
  ('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000010',-100000,'burn','credit-key');
select credit_ledger_test_assert((select balance=145 from org_credit_balances where org_id='30000000-0000-0000-0000-000000000001'),'repeated keys never move the balance');
select credit_ledger_test_assert(credit_ledger_test_explained('30000000-0000-0000-0000-000000000001',100),'the ledger explains the balance after retries');

-- Mixed keys: another key, another project and another org are distinct posts. The
-- last row repeats org A's project and key under org B, as after a project moves
-- orgs, so only the org tells it apart, exactly as in the unique index.
insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
  ('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000010',-1,'burn','other-key'),
  ('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000011',-2,'burn','burn-key'),
  ('30000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000020',-3,'burn','burn-key'),
  ('30000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000010',-4,'burn','burn-key')
  on conflict do nothing;
select credit_ledger_test_assert((select balance=142 from org_credit_balances where org_id='30000000-0000-0000-0000-000000000001'),'another key or project in the org debits');
select credit_ledger_test_assert((select balance=93 from org_credit_balances where org_id='30000000-0000-0000-0000-000000000002'),'the same key in another org debits');
select credit_ledger_test_assert((select count(*)=5 from org_credit_ledger where org_id in
  ('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002') and idempotency_key in ('burn-key','other-key')),'mixed keys each keep their own row');

-- Like the unique index, a row without a project or without a key never dedupes.
insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
  ('30000000-0000-0000-0000-000000000001',null,-1,'burn','no-project-key') on conflict do nothing;
insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
  ('30000000-0000-0000-0000-000000000001',null,-1,'burn','no-project-key') on conflict do nothing;
select credit_ledger_test_assert((select count(*)=2 from org_credit_ledger where org_id='30000000-0000-0000-0000-000000000001' and idempotency_key='no-project-key'),'a NULL project never dedupes');
insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
  ('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000010',-1,'burn','') on conflict do nothing;
insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
  ('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000010',-1,'burn','') on conflict do nothing;
select credit_ledger_test_assert((select count(*)=2 from org_credit_ledger where org_id='30000000-0000-0000-0000-000000000001' and idempotency_key=''),'an empty key never dedupes');
insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
  ('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000010',-1,'burn',null),
  ('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000010',-1,'burn',null);
select credit_ledger_test_assert((select count(*)=2 from org_credit_ledger where org_id='30000000-0000-0000-0000-000000000001' and idempotency_key is null),'a NULL key never dedupes');
select credit_ledger_test_assert((select balance=136 from org_credit_balances where org_id='30000000-0000-0000-0000-000000000001'),'keyless and projectless posts each move the balance');
select credit_ledger_test_assert(credit_ledger_test_explained('30000000-0000-0000-0000-000000000001',100)
  and credit_ledger_test_explained('30000000-0000-0000-0000-000000000002',100),'the ledger explains every balance');
