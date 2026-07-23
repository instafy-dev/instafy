-- Conversation send queue ----------------------------------------------------
-- Server-side queue for user messages composed while their target agents still
-- have active runs. Replaces the client-only localStorage queue so queued
-- prompts survive reloads/devices and are auto-dispatched by the controller
-- when the target agents go idle.

create table if not exists conversation_send_queue (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects(id) on delete cascade,
    conversation_id uuid not null references conversations(id) on delete cascade,
    session_id uuid,
    user_id uuid,
    status text not null default 'queued', -- queued | dispatched | canceled | failed
    target_agent_handles text[] not null default '{}',
    request jsonb not null,
    error_message text,
    dispatched_run_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    dispatched_at timestamptz
);

create index if not exists conversation_send_queue_conversation_idx
    on conversation_send_queue(conversation_id, status, created_at);
