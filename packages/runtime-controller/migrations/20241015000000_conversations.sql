-- Conversations and conversation messages schema
-- Adds conversation tracking to prompts, runs, and agent jobs

create table if not exists conversations (
    id uuid primary key,
    project_id uuid not null references projects(id) on delete cascade,
    session_id uuid,
    created_by uuid,
    metadata jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists conversations_project_idx on conversations(project_id);

create table if not exists conversation_messages (
    id uuid primary key,
    conversation_id uuid not null references conversations(id) on delete cascade,
    project_id uuid not null references projects(id) on delete cascade,
    session_id uuid,
    prompt_id uuid references prompts(id) on delete set null,
    run_id uuid references runs(id) on delete set null,
    role text not null,
    content text not null,
    metadata jsonb,
    created_by uuid,
    created_at timestamptz not null default now()
);

create index if not exists conversation_messages_conversation_idx on conversation_messages(conversation_id);
create index if not exists conversation_messages_project_idx on conversation_messages(project_id);

alter table if exists prompts
    add column if not exists conversation_id uuid references conversations(id) on delete set null;

create index if not exists prompts_conversation_idx on prompts(conversation_id);

alter table if exists runs
    add column if not exists conversation_id uuid references conversations(id) on delete set null;

create index if not exists runs_conversation_idx on runs(conversation_id);

alter table if exists agent_jobs
    add column if not exists conversation_id uuid;

alter table if exists agent_jobs
    add constraint agent_jobs_conversation_fk
        foreign key (conversation_id) references conversations(id) on delete set null;

create index if not exists agent_jobs_conversation_idx on agent_jobs(conversation_id);
