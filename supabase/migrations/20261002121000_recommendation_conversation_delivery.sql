-- A proactive finding is delivered once as an ordinary private conversation.
-- Keep IDs as tombstones after deletion so later reviews cannot recreate it.
alter table public.space_recommendations
  add column delivered_conversation_id uuid,
  add column delivered_message_id uuid,
  add column delivered_run_id uuid,
  add column delivered_at timestamptz,
  add constraint space_recommendations_delivery_complete check (
    (delivered_conversation_id is null and delivered_message_id is null and delivered_at is null and delivered_run_id is null)
    or (delivered_conversation_id is not null and delivered_message_id is not null and delivered_at is not null)
  );

-- The application serializes a run's submissions; this also guards other writers.
create unique index space_recommendations_one_delivery_per_run
  on public.space_recommendations(delivered_run_id) where delivered_run_id is not null;
