create table if not exists newsletter_subscribers (
  email text primary key,
  created_at timestamptz not null default now(),
  source text,
  referrer text,
  user_agent text
);

comment on table newsletter_subscribers is 'Email-only signup list for Instafy marketing/news updates.';

alter table newsletter_subscribers enable row level security;

drop policy if exists "newsletter subscribers insert" on newsletter_subscribers;
create policy "newsletter subscribers insert" on newsletter_subscribers
  for insert to anon, authenticated
  with check (true);

drop policy if exists "newsletter subscribers service role" on newsletter_subscribers;
create policy "newsletter subscribers service role" on newsletter_subscribers
  for all using (public.current_request_role() = 'service_role')
  with check (true);

grant insert on table newsletter_subscribers to anon, authenticated;
grant select, insert, update, delete on table newsletter_subscribers to service_role;

