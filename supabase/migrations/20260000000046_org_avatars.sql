-- Team/org avatars: an https image URL rendered in the sidebar team rail,
-- the workspace switcher, and org settings (initials remain the fallback).

alter table organizations
  add column if not exists avatar_url text;
