-- The parts of the Supabase Storage schema that the public migrations' Storage
-- policies use, for scripts/test-durable-notifications.py's disposable cluster,
-- which has no Storage. The Storage service owns and migrates these tables in a
-- real project, and the controller test chat_attachments_sql_fixture_passes_on_storage
-- runs the same fixture against them. This stub keeps only the columns and
-- constraints the policies and their fixtures read: buckets, and objects with RLS
-- on, the uploader in owner_id and the deprecated owner, and unique names per
-- bucket. Like Supabase, it gives the browser roles table privileges and leaves
-- row access to the policies.
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
do $$ begin
  if not has_schema_privilege('authenticated', 'storage', 'usage') then
    grant usage on schema storage to anon, authenticated, service_role;
  end if;
end $$;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
