-- Durable GitHub device-login status and short-lived, session-bound import tokens.
-- The provider device code remains process-local for now; completed access tokens
-- are encrypted by the controller before entering this table.

create table if not exists github_device_auth_sessions (
    session_id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    status text not null check (status in ('pending', 'completed', 'failed', 'cancelled')),
    verification_url text not null,
    user_code text not null,
    poll_interval_seconds integer not null check (poll_interval_seconds > 0),
    device_expires_at timestamptz not null,
    completed_at timestamptz,
    assertion_expires_at timestamptz,
    error_message text,
    token_nonce_b64 text,
    token_ciphertext_b64 text,
    token_scope text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (
        (
            status = 'pending'
            and completed_at is null
            and assertion_expires_at is null
            and token_nonce_b64 is null
            and token_ciphertext_b64 is null
        )
        or (
            status = 'completed'
            and completed_at is not null
            and token_nonce_b64 is not null
            and token_ciphertext_b64 is not null
            and assertion_expires_at > completed_at
        )
        or (
            status in ('failed', 'cancelled')
            and completed_at is not null
            and assertion_expires_at is null
            and token_nonce_b64 is null
            and token_ciphertext_b64 is null
        )
    )
);

create index if not exists github_device_auth_sessions_user_created_idx
    on github_device_auth_sessions(user_id, created_at desc);

create index if not exists github_device_auth_sessions_retention_idx
    on github_device_auth_sessions(status, assertion_expires_at, completed_at, device_expires_at);

alter table github_device_auth_sessions enable row level security;
revoke all privileges on table github_device_auth_sessions from anon, authenticated;

comment on table github_device_auth_sessions is
    'Internal controller state for GitHub device login; access tokens are encrypted and session assertions expire after 30 minutes.';
