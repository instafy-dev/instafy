-- Push notification endpoints (Web Push + native device tokens).

create table if not exists web_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists web_push_subscriptions_endpoint_uidx
  on web_push_subscriptions(endpoint);

create index if not exists web_push_subscriptions_user_idx
  on web_push_subscriptions(user_id);

drop trigger if exists set_web_push_subscriptions_updated_at on web_push_subscriptions;
create trigger set_web_push_subscriptions_updated_at
  before update on web_push_subscriptions
  for each row
  execute function set_timestamp();

create table if not exists native_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null default 'ios' check (platform in ('ios','android')),
  environment text not null default 'production' check (environment in ('sandbox','production')),
  token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists native_push_tokens_platform_token_uidx
  on native_push_tokens(platform, token);

create index if not exists native_push_tokens_user_idx
  on native_push_tokens(user_id);

drop trigger if exists set_native_push_tokens_updated_at on native_push_tokens;
create trigger set_native_push_tokens_updated_at
  before update on native_push_tokens
  for each row
  execute function set_timestamp();

