set local lock_timeout = '5s';

-- Opt-in quiet review execution. No schedules are created by this migration.
alter table public.automations add column mode text not null default 'prompt'
  check (mode in ('prompt', 'space_review'));
alter table public.automations add constraint space_review_private_quiet
  check (mode <> 'space_review' or (result_visibility='private' and silent_when_nothing_to_report));
create unique index automations_one_space_review_per_owner
  on public.automations(user_id,project_id) where mode='space_review';
