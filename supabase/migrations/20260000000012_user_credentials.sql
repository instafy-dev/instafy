-- User-scoped BYOC credential storage (encrypted) + job pinning.

create table if not exists user_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('codex_auth_json','openai_api_key')),
  label text,
  -- Encrypted secret payload (controller-managed encryption).
  nonce_b64 text not null,
  ciphertext_b64 text not null,
  -- Non-sensitive metadata (e.g. account_id, display hints).
  metadata jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_credentials_user_idx on user_credentials(user_id);
create index if not exists user_credentials_user_kind_idx on user_credentials(user_id, kind);
create index if not exists user_credentials_revoked_idx on user_credentials(revoked_at);

-- Ensure a single active default credential per user.
create unique index if not exists user_credentials_one_default_per_user
  on user_credentials(user_id)
  where is_default and revoked_at is null;

drop trigger if exists set_user_credentials_updated_at on user_credentials;
create trigger set_user_credentials_updated_at
  before update on user_credentials
  for each row
  execute function set_timestamp();

-- Allow controller to pin a job to a specific credential (used for multi-agent routing).
alter table if exists agent_jobs
  add column if not exists credential_id uuid references user_credentials(id) on delete set null;

create index if not exists agent_jobs_credential_idx on agent_jobs(credential_id);
