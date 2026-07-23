-- Private conversation support (project-scoped).

alter table if exists conversations
  add column if not exists visibility text not null default 'public'
    check (visibility in ('public','private'));

create index if not exists conversations_visibility_idx on conversations(visibility);

create table if not exists conversation_participants (
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member',
  added_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index if not exists conversation_participants_user_idx
  on conversation_participants(user_id);
