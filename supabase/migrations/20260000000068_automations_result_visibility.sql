-- Automations may share their result threads with the team instead of keeping them owner-only.
--
-- Note: Instafy Studio is not live yet; no backfills/migrations required beyond schema updates.
-- The stored enum keeps the product word "team". Thread creation maps 'team' onto the
-- conversation 'public' visibility, which the conversation list gate exposes to anyone with
-- project access (it is scoped to the space, not world-readable).

alter table public.automations
  add column if not exists result_visibility text not null default 'private';

alter table public.automations
  drop constraint if exists automations_result_visibility_check;

alter table public.automations
  add constraint automations_result_visibility_check
  check (result_visibility in ('private', 'team'));

comment on column public.automations.result_visibility is
  'Visibility of the automation''s result conversation threads: ''private'' (owner-only, default) or ''team'' (visible to anyone with project access, mapped to the conversation ''public'' visibility).';
