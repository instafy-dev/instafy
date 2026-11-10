-- Which chat made each of a space's pages.
--
-- A page made for a person (a comparison, a map, a page to share) is the chat's that made it:
-- another chat's turn reads it and never changes it, and the runtime holds it to that. The
-- runtime read which chat made a page from a file in the space's own folder, written by
-- `instafy preview open`. That file is outside every save, so a hosted space lost it with its
-- machine, and the next chat to open a page's card became its maker: the chat that really made
-- the page could no longer change it.
--
-- So the controller keeps the record: one row per space and page folder (the folder its site is
-- served from, relative to the space's workspace), written when the page's card is posted, with
-- the chat the card went to. A later card for the same folder keeps that chat. conversation_id
-- is null for a page whose maker is not known: one that was there before this record held it,
-- or whose card went to a thread nobody asks in. A leased turn is given the space's rows, and
-- a row whose chat is gone reads there as not known.
--
-- No foreign key to conversations: a chat goes only with its space, which takes these rows too.
--
-- Controller only: RLS is on and no client policy exists.
set local lock_timeout = '5s';

create table public.space_pages (
  project_id uuid not null references public.projects(id) on delete cascade,
  folder text not null check (char_length(folder) between 1 and 512),
  conversation_id uuid,
  title text not null default '' check (char_length(title) <= 200),
  server jsonb not null default '[]'::jsonb check (jsonb_typeof(server) = 'array'),
  opened_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (project_id, folder)
);

-- A lease reads a space's most recently opened pages.
create index space_pages_project_opened_idx
  on public.space_pages(project_id, opened_at desc);

alter table public.space_pages enable row level security;
revoke all on public.space_pages from anon, authenticated;
grant all on public.space_pages to service_role;
