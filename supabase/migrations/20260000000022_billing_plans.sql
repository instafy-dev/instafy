-- Billing plans catalog.
-- Controllers read this table to resolve plan IDs, daily credit limits, and default resource limits.

create table if not exists billing_plans (
  id text primary key,
  name text not null,
  currency text not null default 'USD',
  monthly_price_cents int not null default 0,
  credit_limit int not null default 0,
  max_active_tunnels bigint not null default 0,
  max_active_hosted_runtimes bigint not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_plans_id_lowercase check (id = lower(id))
);

drop trigger if exists set_billing_plans_updated_at on billing_plans;
create trigger set_billing_plans_updated_at
  before update on billing_plans
  for each row
  execute function set_timestamp();

alter table billing_plans enable row level security;

drop policy if exists "billing plans service role" on billing_plans;
create policy "billing plans service role" on billing_plans
  for all using (public.current_request_role() = 'service_role')
  with check (true);

insert into billing_plans (
  id,
  name,
  currency,
  monthly_price_cents,
  credit_limit,
  max_active_tunnels,
  max_active_hosted_runtimes,
  active
)
values
  ('starter', 'Starter', 'USD', 0, 200, 3, 5, true),
  ('pro', 'Pro', 'USD', 1000, 2000, 10, 20, true),
  ('scale', 'Scale', 'USD', 10000, 10000, 25, 50, true)
on conflict (id) do update
set name = excluded.name,
    currency = excluded.currency,
    monthly_price_cents = excluded.monthly_price_cents,
    credit_limit = excluded.credit_limit,
    max_active_tunnels = excluded.max_active_tunnels,
    max_active_hosted_runtimes = excluded.max_active_hosted_runtimes,
    active = excluded.active,
    updated_at = now();
