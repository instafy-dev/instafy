-- Security hardening: lock down the persistent browser-profile table.
-- project_browser_profiles holds AES-256-GCM-encrypted browser session state
-- (cookies etc.) and, like project_secrets, must never be browser-accessible.
-- The controller also applies this on lazy table creation; this is the
-- defense-in-depth backstop matching the other internal secret-bearing tables.
-- Guarded on existence because the table is created lazily by the controller.
do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'project_browser_profiles'
      and c.relkind = 'r'
  ) then
    execute 'alter table public.project_browser_profiles enable row level security';
    execute 'revoke all privileges on table public.project_browser_profiles from anon, authenticated';
  end if;
end $$;
