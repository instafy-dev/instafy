-- Shared display metadata. Organization access and membership policies are unchanged.
alter table public.organizations
  add column accent_color text,
  add constraint organizations_accent_color_allowed check (
    accent_color is null or accent_color in ('slate', 'blue', 'violet', 'pink', 'red', 'orange', 'green', 'teal')
  );
