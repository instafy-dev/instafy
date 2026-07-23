-- Org invitations + dev email outbox.

create table if not exists org_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  email citext not null,
  role text not null default 'builder' check (role in ('owner','admin','builder','viewer')),
  token uuid not null unique default gen_random_uuid(),
  invited_by uuid references auth.users(id),
  status text not null default 'pending' check (status in ('pending','canceled','accepted','expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  canceled_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id),
  expires_at timestamptz
);

create index if not exists org_invitations_org_idx on org_invitations(org_id);
create index if not exists org_invitations_email_idx on org_invitations(email);
create unique index if not exists org_invitations_pending_unique
  on org_invitations(org_id, email)
  where status = 'pending';

drop trigger if exists set_org_invitations_updated_at on org_invitations;
create trigger set_org_invitations_updated_at
  before update on org_invitations
  for each row
  execute function set_timestamp();

create table if not exists email_outbox (
  id uuid primary key default gen_random_uuid(),
  to_email citext not null,
  subject text not null,
  body_text text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists email_outbox_to_email_idx on email_outbox(to_email);

