-- Security hardening: lock down controller-owned internal tables that may be
-- created lazily after the initial public-table lockdown migration ran.

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'project_integrations',
    'bug_reports',
    'bug_report_attachments'
  ]
  loop
    if exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = tbl
        and c.relkind = 'r'
    ) then
      execute format('alter table public.%I enable row level security', tbl);
      execute format('revoke all privileges on table public.%I from anon, authenticated', tbl);
    end if;
  end loop;
end
$$;
