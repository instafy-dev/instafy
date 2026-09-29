-- Managed AI metering tables and the org credit ledger guard.
-- Executed by scripts/test-durable-notifications.py in its disposable cluster, and by the
-- controller test managed_ai_metering_sql_fixture_passes inside a transaction it rolls back,
-- so this file never begins or ends a transaction itself.
create function pg_temp.metering_assert(ok boolean, label text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'metering test failed: %',label; end if; end; $$;
insert into organizations(id,slug,name) values
  ('00000000-0000-0000-0000-000000000101','metering-fixture-overdraft','Metering overdraft'),
  ('00000000-0000-0000-0000-000000000102','metering-fixture-burn','Metering burn'),
  ('00000000-0000-0000-0000-000000000103','metering-fixture-keys','Metering keys');
insert into projects(id,org_id) values
  ('00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000101'),
  ('00000000-0000-0000-0000-000000000112','00000000-0000-0000-0000-000000000102'),
  ('00000000-0000-0000-0000-000000000113','00000000-0000-0000-0000-000000000103'),
  ('00000000-0000-0000-0000-000000000114','00000000-0000-0000-0000-000000000103');
insert into org_credit_ledger(org_id,project_id,delta,reason) values
  ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000111',5,'test_seed'),
  ('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000112',2,'test_seed'),
  ('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000113',10,'test_seed');

-- overdraft_row_may_go_negative: a metered debit is posted after the upstream call ran.
insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key,allow_overdraft) values
  ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000111',-8,'managed_ai_usage','managed-ai-usage:fixture-1',true);
select pg_temp.metering_assert((select balance=-3 from org_credit_balances where org_id='00000000-0000-0000-0000-000000000101'),'overdraft_row_may_go_negative: balance');
select pg_temp.metering_assert((select balance_after=-3 from org_credit_ledger where idempotency_key='managed-ai-usage:fixture-1'),'overdraft_row_may_go_negative: balance_after');

-- ordinary_burn_still_rejected_below_zero: without allow_overdraft a debit may not end below zero,
-- whether the balance was positive or already negative. A debit to exactly zero is allowed.
do $$
declare refused_from_positive boolean := false; refused_from_negative boolean := false;
begin
  begin
    insert into org_credit_ledger(org_id,project_id,delta,reason)
      values ('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000112',-3,'burn');
  exception when raise_exception then
    refused_from_positive := sqlerrm like 'Insufficient credits for org %';
  end;
  begin
    insert into org_credit_ledger(org_id,project_id,delta,reason,allow_overdraft)
      values ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000111',-1,'burn',false);
  exception when raise_exception then
    refused_from_negative := sqlerrm like 'Insufficient credits for org %';
  end;
  perform pg_temp.metering_assert(refused_from_positive,'ordinary_burn_still_rejected_below_zero: debit past zero');
  perform pg_temp.metering_assert(refused_from_negative,'ordinary_burn_still_rejected_below_zero: debit from debt');
end $$;
select pg_temp.metering_assert((select balance=2 from org_credit_balances where org_id='00000000-0000-0000-0000-000000000102'),'ordinary_burn_still_rejected_below_zero: refused debit left no trace');
insert into org_credit_ledger(org_id,project_id,delta,reason) values
  ('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000112',-2,'burn');
select pg_temp.metering_assert((select balance=0 from org_credit_balances where org_id='00000000-0000-0000-0000-000000000102'),'ordinary_burn_still_rejected_below_zero: debit to zero allowed');

-- refill_into_still_negative_balance_allowed: debt carries into a refill smaller than it.
insert into org_credit_ledger(org_id,project_id,delta,reason) values
  ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000111',1,'auto_refill_daily');
select pg_temp.metering_assert((select balance=-2 from org_credit_balances where org_id='00000000-0000-0000-0000-000000000101'),'refill_into_still_negative_balance_allowed: balance');
select pg_temp.metering_assert((select balance_after=-2 from org_credit_ledger where org_id='00000000-0000-0000-0000-000000000101' and reason='auto_refill_daily'),'refill_into_still_negative_balance_allowed: balance_after');

-- duplicate_idempotency_key_skipped_without_balance_change: a plain insert and an
-- ON CONFLICT insert of an existing key write nothing and leave the balance alone,
-- whatever their reason or delta. The same key in another project is a new row.
insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
  ('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000113',-2,'burn','fixture-key');
with inserted as (
  insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
    ('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000113',-5,'managed_ai_usage','fixture-key')
  returning id)
select pg_temp.metering_assert(count(*)=0,'duplicate_idempotency_key_skipped_without_balance_change: plain insert skipped') from inserted;
with inserted as (
  insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
    ('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000113',-2,'burn','fixture-key')
  on conflict do nothing returning id)
select pg_temp.metering_assert(count(*)=0,'duplicate_idempotency_key_skipped_without_balance_change: on conflict insert skipped') from inserted;
select pg_temp.metering_assert((select balance=8 from org_credit_balances where org_id='00000000-0000-0000-0000-000000000103'),'duplicate_idempotency_key_skipped_without_balance_change: balance moved once');
select pg_temp.metering_assert((select count(*)=1 from org_credit_ledger where idempotency_key='fixture-key'),'duplicate_idempotency_key_skipped_without_balance_change: one row');
insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
  ('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000114',-2,'burn','fixture-key');
select pg_temp.metering_assert((select balance=6 from org_credit_balances where org_id='00000000-0000-0000-0000-000000000103'),'duplicate_idempotency_key_skipped_without_balance_change: other project applies');

-- null_project_keys_still_not_deduplicated: the unique index never matches a NULL project,
-- and the guard follows it.
insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
  ('00000000-0000-0000-0000-000000000103',null,-1,'burn','fixture-null-project-key');
insert into org_credit_ledger(org_id,project_id,delta,reason,idempotency_key) values
  ('00000000-0000-0000-0000-000000000103',null,-1,'burn','fixture-null-project-key');
select pg_temp.metering_assert((select count(*)=2 from org_credit_ledger where idempotency_key='fixture-null-project-key'),'null_project_keys_still_not_deduplicated: two rows');
select pg_temp.metering_assert((select balance=4 from org_credit_balances where org_id='00000000-0000-0000-0000-000000000103'),'null_project_keys_still_not_deduplicated: balance moved twice');

-- admissions_unique_per_kind_subject: one subject counts once per kind.
insert into managed_ai_admissions(kind,subject_id,org_id,project_id,user_id) values
  ('prompt','00000000-0000-0000-0000-000000000130','00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000113','00000000-0000-0000-0000-000000000140'),
  ('evaluation_answer','00000000-0000-0000-0000-000000000130','00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000113','00000000-0000-0000-0000-000000000140'),
  ('steer','00000000-0000-0000-0000-000000000131','00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000113','00000000-0000-0000-0000-000000000140');
do $$
declare duplicate_refused boolean := false;
begin
  begin
    insert into managed_ai_admissions(kind,subject_id,org_id,project_id,user_id) values
      ('prompt','00000000-0000-0000-0000-000000000130','00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000113','00000000-0000-0000-0000-000000000141');
  exception when unique_violation then
    duplicate_refused := true;
  end;
  perform pg_temp.metering_assert(duplicate_refused,'admissions_unique_per_kind_subject: duplicate refused');
end $$;
with inserted as (
  insert into managed_ai_admissions(kind,subject_id,org_id,project_id,user_id) values
    ('evaluation_answer','00000000-0000-0000-0000-000000000130','00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000113','00000000-0000-0000-0000-000000000141')
  on conflict (kind,subject_id) do nothing returning id)
select pg_temp.metering_assert(count(*)=0,'admissions_unique_per_kind_subject: second answer of one prompt not counted') from inserted;
select pg_temp.metering_assert((select count(*)=3 from managed_ai_admissions where org_id='00000000-0000-0000-0000-000000000103'),'admissions_unique_per_kind_subject: three admissions');

-- A job's metering rows go with the job.
insert into agent_jobs(id,project_id,intent) values
  ('00000000-0000-0000-0000-000000000120','00000000-0000-0000-0000-000000000111','feature');
insert into ai_usage_jobs(job_id,org_id,project_id,billing_mode,decline_waiver_units) values
  ('00000000-0000-0000-0000-000000000120','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000111','record_only',2);
insert into ai_usage_events(request_id,job_id,lease_attempt,org_id,project_id,route,source_tag,served_by,outcome,served_model,rates,job_token_sha256,report_sha256) values
  ('00000000-0000-0000-0000-000000000150','00000000-0000-0000-0000-000000000120',1,'00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000111','responses','main','controller_lease','completed','gpt-6-luna','{}','\x00','\x00');
delete from agent_jobs where id='00000000-0000-0000-0000-000000000120';
select pg_temp.metering_assert((select count(*)=0 from ai_usage_jobs where job_id='00000000-0000-0000-0000-000000000120'),'metering rows follow their job: job record');
select pg_temp.metering_assert((select count(*)=0 from ai_usage_events where job_id='00000000-0000-0000-0000-000000000120'),'metering rows follow their job: events');

-- every_metering_foreign_key_has_a_leading_index: an org, project or job delete cascades into
-- these tables, and without an index that leads with the key's columns each cascade scans the
-- whole table while it holds its locks. The label names any key that lacks one.
select pg_temp.metering_assert(count(*)=0,
  'every_metering_foreign_key_has_a_leading_index: '||coalesce(string_agg(c.conname,', ' order by c.conname),''))
from pg_constraint c
where c.contype='f'
  and c.conrelid in ('public.ai_usage_jobs'::regclass,'public.ai_usage_events'::regclass,'public.managed_ai_admissions'::regclass)
  and not exists (
    select 1 from pg_index i
    where i.indrelid=c.conrelid and i.indisvalid and i.indpred is null
      and (string_to_array(i.indkey::text,' ')::int2[])[1:cardinality(c.conkey)] @> c.conkey);

-- anon_and_authenticated_cannot_read_or_write_metering_tables: browser roles hold no privilege.
select pg_temp.metering_assert(not exists (
  select 1
  from unnest(array['anon','authenticated']) as r(role_name)
  cross join unnest(array['public.ai_usage_jobs','public.ai_usage_events','public.managed_ai_admissions']) as t(table_name)
  cross join unnest(array['select','insert','update','delete','truncate','references','trigger']) as p(privilege)
  where has_table_privilege(r.role_name,t.table_name,p.privilege)),
  'anon_and_authenticated_cannot_read_or_write_metering_tables: no privilege');
select pg_temp.metering_assert((select bool_and(relrowsecurity) from pg_class
  where oid in ('public.ai_usage_jobs'::regclass,'public.ai_usage_events'::regclass,'public.managed_ai_admissions'::regclass)),
  'anon_and_authenticated_cannot_read_or_write_metering_tables: row level security enabled');
