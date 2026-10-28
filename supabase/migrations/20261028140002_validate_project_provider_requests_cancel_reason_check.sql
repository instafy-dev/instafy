-- Checks the rows that existed before 20261028140000 against the
-- cancel_reason check it added NOT VALID. Its own file because VALIDATE
-- CONSTRAINT scans the table under SHARE UPDATE EXCLUSIVE, which blocks no
-- live read or write, not under that migration's ACCESS EXCLUSIVE.
set local lock_timeout = '5s';

alter table public.project_provider_requests
  validate constraint project_provider_requests_cancel_reason_check;
