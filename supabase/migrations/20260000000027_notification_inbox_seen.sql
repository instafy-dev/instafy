-- Notification inbox read state (per conversation participant).

alter table if exists conversation_participants
  add column if not exists last_seen_message_id uuid,
  add column if not exists last_seen_at timestamptz;

create index if not exists conversation_participants_last_seen_idx
  on conversation_participants(user_id, conversation_id, last_seen_message_id);

