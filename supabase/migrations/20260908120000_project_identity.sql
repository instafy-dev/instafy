-- Optional display metadata only. Existing project access/RLS stays unchanged.
alter table public.projects
  add column icon text,
  add column color text,
  add constraint projects_icon_allowed check (
    icon is null or icon in ('🚀', '🛠️', '💡', '🌱', '🎨', '📚', '🔬', '🎯', '🌍', '⚡', '🏡', '🧩')
  ),
  add constraint projects_color_allowed check (
    color is null or color in ('slate', 'blue', 'violet', 'pink', 'red', 'orange', 'green', 'teal')
  );
