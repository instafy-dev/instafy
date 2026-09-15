-- Public profile text is optional; existing self-write/read policies stay unchanged.
alter table public.profiles
  add column bio text,
  add constraint profiles_bio_length check (bio is null or char_length(bio) <= 500);

comment on column public.profiles.bio is
  'Optional plain-text introduction, at most 500 Unicode characters. Shared through project-authorized profile reads.';
