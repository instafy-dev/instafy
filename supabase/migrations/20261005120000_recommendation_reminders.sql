-- A user's postponement belongs to the delivered topic, not to the review cadence.
-- Delivery and clearing the due date commit together; retries cannot duplicate a reminder.
set local lock_timeout = '5s';

alter table public.space_recommendations
  add column remind_at timestamptz,
  add column reminder_timezone text,
  add column last_reminded_at timestamptz,
  add constraint space_recommendations_reminder_complete check (
    (remind_at is null and reminder_timezone is null)
    or (remind_at is not null and reminder_timezone is not null
        and delivered_conversation_id is not null and status = 'proposed')
  );

create index space_recommendations_due_reminders
  on public.space_recommendations(remind_at) where remind_at is not null;

-- Existing controller-only permissions and row-level security remain in force.
