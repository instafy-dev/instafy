-- Public profile text is separate from the agent's runtime style guidance.
alter table public.user_agents
  add column bio text;

alter table public.user_agents
  add constraint user_agents_bio_length_check
  check (bio is null or char_length(bio) <= 500);

comment on column public.user_agents.bio is
  'Optional public profile biography, up to 500 Unicode characters. Not runtime or system instructions.';
