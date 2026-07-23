-- Canonical encrypted OAuth token storage. This table used to be created on
-- demand by the controller; keeping its schema in a migration avoids runtime
-- DDL and makes GitHub/Gemini connection failures explicit during rollout.

create table if not exists user_oauth_tokens (
    user_id uuid not null,
    provider text not null,
    nonce_b64 text not null,
    ciphertext_b64 text not null,
    scope text,
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (user_id, provider)
);

-- Compatibility for a table created by an older controller before migrations
-- became authoritative. Additive clauses are safe to rerun.
alter table user_oauth_tokens add column if not exists scope text;
alter table user_oauth_tokens add column if not exists last_used_at timestamptz;
alter table user_oauth_tokens add column if not exists revoked_at timestamptz;
alter table user_oauth_tokens
    add column if not exists created_at timestamptz not null default now();
alter table user_oauth_tokens
    add column if not exists updated_at timestamptz not null default now();

create unique index if not exists user_oauth_tokens_user_provider_uidx
    on user_oauth_tokens(user_id, provider);

alter table user_oauth_tokens enable row level security;
revoke all privileges on table user_oauth_tokens from anon, authenticated;

comment on table user_oauth_tokens is
    'Controller-internal encrypted OAuth access tokens; service-role access only.';
