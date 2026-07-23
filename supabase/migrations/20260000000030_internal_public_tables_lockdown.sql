-- Security hardening: lock down internal/public tables that should never be browser-accessible.
-- Instafy is pre-launch; apply directly without legacy backfill handling.

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    '_sqlx_migrations',
    'project_integrations',
    'project_secrets',
    'project_secret_agent_grants',
    'project_secret_agent_handle_grants',
    'runtime_signing_keys',
    'user_oauth_tokens',
    -- Tunnel broker / PowerDNS internal tables.
    'ingress_nodes',
    'tunnels',
    'dns_records',
    'dns_nodes',
    'pdns_domains',
    'domains',
    'records',
    'domainmetadata',
    'cryptokeys',
    'tsigkeys',
    'supermasters',
    'comments'
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

do $$
declare
  seq_name text;
begin
  foreach seq_name in array array[
    'pdns_domains_id_seq',
    'domains_id_seq',
    'records_id_seq',
    'domainmetadata_id_seq',
    'cryptokeys_id_seq',
    'tsigkeys_id_seq',
    'comments_id_seq'
  ]
  loop
    if exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = seq_name
        and c.relkind = 'S'
    ) then
      execute format('revoke all privileges on sequence public.%I from anon, authenticated', seq_name);
    end if;
  end loop;
end
$$;
