-- Raise defaults for future settings rows; preserve saved choices and task snapshots.
set local lock_timeout = '5s';
alter table public.project_research_settings
    alter column max_page_loads set default 100,
    alter column max_page_loads_per_site set default 25;
