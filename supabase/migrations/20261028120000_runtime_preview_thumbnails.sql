-- A small picture of a site preview, for its card in the conversation.
--
-- `instafy preview open` takes a screenshot of the site once it is live, and
-- `instafy preview check` takes a new one after a change; a skill may hand in
-- a picture of its own. The runtime that serves the preview uploads it
-- (PUT /projects/:id/previews/:previewId/thumbnail, a job or machine token
-- bound to that runtime); people cannot. The controller checks the format
-- from the bytes (JPEG, PNG or WebP), removes metadata (EXIF, XMP, ICC,
-- comments, text chunks) and keeps one picture per preview.
--
-- Read only through the controller (GET .../thumbnail), with the preview's
-- own reader rule: members who may open the preview. Never a Storage object,
-- a public URL or a signed URL. A row goes when its preview is closed or
-- replaced, and with its space.
--
-- Controller only: RLS is on and no client policy exists.
set local lock_timeout = '5s';

create table public.runtime_preview_thumbnails (
  tunnel_id text primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  runtime_id uuid,
  content_type text not null
    check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  bytes bytea not null check (octet_length(bytes) <= 524288),
  width integer not null check (width between 1 and 2000),
  height integer not null check (height between 1 and 2000),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  source text not null check (source in ('capture', 'og_image', 'file')),
  page_description text check (page_description is null or char_length(page_description) <= 300),
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index runtime_preview_thumbnails_project_idx
  on public.runtime_preview_thumbnails(project_id);

alter table public.runtime_preview_thumbnails enable row level security;
revoke all on public.runtime_preview_thumbnails from anon, authenticated;
grant all on public.runtime_preview_thumbnails to service_role;
