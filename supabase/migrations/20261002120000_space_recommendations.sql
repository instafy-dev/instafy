-- Personal, evidence-backed recommendations. Decisions survive repeated reviews.
-- Controller routes validate project, conversation and active-job permissions;
-- direct browser writes/reads cannot bypass those evidence checks.
create table public.space_recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  recommendation_key text not null check (recommendation_key ~ '^[a-z0-9][a-z0-9_-]{0,119}$'),
  title text not null check (char_length(title) between 1 and 160),
  reason text not null check (char_length(reason) between 1 and 2000),
  prompt text not null check (char_length(prompt) between 1 and 4000),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) between 1 and 8),
  -- Retain deleted conversation IDs as privacy tombstones. The controller hides
  -- the entire recommendation when its source or evidence is no longer readable.
  source_conversation_id uuid not null,
  status text not null default 'proposed' check (status in ('proposed', 'accepted', 'dismissed')),
  accepted_conversation_id uuid,
  -- Retain the prepared draft identity across failed outcome saves and retries.
  -- No FK: a deleted draft must report unavailable instead of being recreated.
  prepared_conversation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, project_id, recommendation_key),
  check (accepted_conversation_id is null or status = 'accepted')
);

create index space_recommendations_owner_project_updated_idx
  on public.space_recommendations(user_id, project_id, updated_at desc, id);

alter table public.space_recommendations enable row level security;
revoke all on public.space_recommendations from anon, authenticated;
grant all on public.space_recommendations to service_role;
create policy "space recommendations controller only" on public.space_recommendations
  for all using (public.current_request_role() = 'service_role')
  with check (public.current_request_role() = 'service_role');

-- Repeated on-demand reviews use one private root so the existing active-job
-- conversation boundary can recover prior decisions without broader grants.
create table public.space_review_conversations (
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid not null unique references public.conversations(id) on delete cascade,
  primary key (user_id, project_id)
);
alter table public.space_review_conversations enable row level security;
revoke all on public.space_review_conversations from anon, authenticated;
grant all on public.space_review_conversations to service_role;
create policy "space review conversations controller only" on public.space_review_conversations
  for all using (public.current_request_role() = 'service_role')
  with check (public.current_request_role() = 'service_role');
