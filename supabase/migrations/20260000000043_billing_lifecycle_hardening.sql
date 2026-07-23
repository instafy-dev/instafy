-- Billing lifecycle hardening (2026-07-10 subscription gap review):
-- 1. Webhook idempotency: record processed Stripe event ids so replayed/retried
--    deliveries cannot re-apply state transitions (e.g. a late
--    invoice.payment_succeeded resurrecting a canceled subscription).
-- 2. Stripe customer reuse: persist the Stripe customer id per org so checkouts
--    reuse one customer instead of minting a new one per session.
-- 3. Cancel visibility: store cancel_at_period_end so the app can render
--    "cancels on <date>" (current_period_end already exists on the table).

create table if not exists billing_webhook_events (
  event_id text primary key,
  processor text not null default 'stripe',
  kind text,
  processed_at timestamptz not null default now()
);

alter table billing_webhook_events enable row level security;
revoke all privileges on table billing_webhook_events from anon, authenticated;

comment on table billing_webhook_events is
  'Processed billing webhook event ids (idempotency). Internal: controller service role only.';

-- Retention: rows older than 30 days are safe to purge (Stripe retries max ~3 days).
create index if not exists billing_webhook_events_processed_at_idx
  on billing_webhook_events (processed_at);

alter table org_subscriptions
  add column if not exists external_customer_id text,
  add column if not exists cancel_at_period_end boolean not null default false;
