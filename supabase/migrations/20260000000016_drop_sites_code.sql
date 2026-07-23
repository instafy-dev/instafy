-- Instafy is not live yet, so we can change behavior without migrating historical data.
-- The filesystem is the source of truth; do not persist full file snapshots in Postgres.

alter table if exists public.sites
  drop column if exists code;
