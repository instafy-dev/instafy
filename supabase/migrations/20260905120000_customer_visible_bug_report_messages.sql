-- Customer-visible support conversation ledger.
--
-- Every row in this table is safe to render to the reporter. Internal notes,
-- agent reasoning, runtime logs, workspace paths, and other operator-only data
-- must remain outside this table. Browser roles cannot access it directly;
-- the runtime controller projects rows after report-owner/operator checks.

-- Adding report activity columns takes a lock on the existing report table.
-- Fail quickly behind live traffic so an operator can retry safely.
set lock_timeout = '5s';

alter table if exists public.bug_reports
    add column if not exists customer_last_message_at timestamptz,
    add column if not exists support_last_message_at timestamptz,
    add column if not exists customer_last_reviewed_at timestamptz,
    add column if not exists customer_last_reviewed_by uuid,
    add column if not exists client_request_id uuid,
    add column if not exists client_request_fingerprint text;

-- Add the customer acknowledgement cursor separately so the rollout backfill
-- happens only when the column is first introduced. Re-running this migration
-- must never acknowledge support activity that arrived after deployment.
do $$
begin
    if to_regclass('public.bug_reports') is not null
       and not exists (
           select 1
             from information_schema.columns
            where table_schema = 'public'
              and table_name = 'bug_reports'
              and column_name = 'customer_last_seen_support_at'
       ) then
        alter table public.bug_reports
            add column customer_last_seen_support_at timestamptz;

        -- Existing threads should not produce a one-time historical alert
        -- storm. Only support activity created after this rollout starts unread.
        update public.bug_reports
           set customer_last_seen_support_at = greatest(support_last_message_at, resolved_at)
         where user_id is not null
           and (support_last_message_at is not null or resolved_at is not null);
    end if;
end
$$;

do $$
begin
    if to_regclass('public.bug_reports') is not null
       and not exists (
           select 1
             from information_schema.columns
            where table_schema = 'public'
              and table_name = 'bug_reports'
              and column_name = 'customer_last_notified_resolution_at'
       ) then
        alter table public.bug_reports
            add column customer_last_notified_resolution_at timestamptz;

        -- Resolution alerts are new. Treat historical resolutions as already
        -- announced so rollout cannot generate an alert storm.
        update public.bug_reports
           set customer_last_notified_resolution_at = resolved_at
         where user_id is not null
           and resolved_at is not null;
    end if;
end
$$;

alter table if exists public.bug_reports
    drop constraint if exists bug_reports_customer_client_request_pair_check;
alter table if exists public.bug_reports
    add constraint bug_reports_customer_client_request_pair_check check (
        (client_request_id is null and client_request_fingerprint is null)
        or (
            user_id is not null
            and client_request_id is not null
            and client_request_fingerprint ~ '^[0-9a-f]{64}$'
        )
    );

comment on column public.bug_reports.customer_last_reviewed_at is
    'Operator-only durable cursor for customer activity reviewed by support; never expose in customer DTOs.';
comment on column public.bug_reports.customer_last_reviewed_by is
    'Operator-only audit actor for the durable customer activity cursor; never expose in customer DTOs.';
comment on column public.bug_reports.client_request_id is
    'Private customer report creation idempotency key; never expose in HTTP report DTOs.';
comment on column public.bug_reports.client_request_fingerprint is
    'Private normalized request digest used to reject conflicting report idempotency replays.';
comment on column public.bug_reports.customer_last_seen_support_at is
    'Customer acknowledgement cursor for support-visible activity; customer DTOs expose only derived unread booleans.';
comment on column public.bug_reports.customer_last_notified_resolution_at is
    'Server-owned cursor claimed when an in-app resolution alert is emitted; separate from the customer seen cursor.';

-- Existing customer reports are themselves customer activity. Backfilling the
-- cursor source makes old reports eligible for the operator needs_response queue.
update public.bug_reports
   set customer_last_message_at = created_at
 where user_id is not null
   and customer_last_message_at is null;

-- Closed/duplicate historical reports must not flood the new queue on rollout.
-- Active reports remain unreviewed so they are eligible for support processing.
update public.bug_reports
   set customer_last_reviewed_at = customer_last_message_at
 where user_id is not null
   and customer_last_reviewed_at is null
   and (status = 'resolved' or duplicate_of is not null);

create table if not exists public.bug_report_messages (
    id uuid primary key,
    bug_report_id uuid not null references public.bug_reports(id) on delete cascade,
    author_type text not null check (author_type in ('customer', 'support', 'system')),
    author_user_id uuid,
    body text not null check (
        length(btrim(body)) > 0
        and char_length(body) <= 4000
        and octet_length(body) <= 16384
    ),
    client_request_id uuid,
    reviewed_customer_activity_at timestamptz check (
        reviewed_customer_activity_at is null or author_type = 'support'
    ),
    created_at timestamptz not null default clock_timestamp()
);

comment on table public.bug_report_messages is
    'Customer-visible support report messages only; never store internal notes, reasoning, logs, or workspace data.';
comment on column public.bug_report_messages.author_user_id is
    'Controller audit field. It is never included in the customer or operator HTTP message DTO.';
comment on column public.bug_report_messages.reviewed_customer_activity_at is
    'Operator reply idempotency/audit snapshot; never included in customer or operator message DTOs.';

create index if not exists bug_report_messages_report_created_idx
    on public.bug_report_messages (bug_report_id, created_at asc, id asc);

create index if not exists bug_report_messages_customer_author_created_idx
    on public.bug_report_messages (author_user_id, created_at desc)
    where author_type = 'customer';

create unique index if not exists bug_report_messages_client_request_idx
    on public.bug_report_messages (bug_report_id, client_request_id)
    where client_request_id is not null;

alter table public.bug_report_messages enable row level security;
revoke all privileges on table public.bug_report_messages from anon, authenticated;

create index if not exists bug_reports_customer_activity_idx
    on public.bug_reports (customer_last_message_at desc, id desc)
    where user_id is not null;

create unique index if not exists bug_reports_customer_client_request_idx
    on public.bug_reports (user_id, client_request_id)
    where user_id is not null and client_request_id is not null;

create index if not exists bug_report_attachments_recent_quota_idx
    on public.bug_report_attachments (created_at desc, bug_report_id)
    include (byte_size);

create index if not exists bug_reports_customer_visible_activity_idx
    on public.bug_reports ((greatest(
        created_at,
        coalesce(customer_last_message_at, created_at),
        coalesce(support_last_message_at, created_at)
    )) desc, id desc)
    where user_id is not null;
