-- Normalize legacy default personal organizations that contain projects from
-- more than one owner. Each distinct project owner is moved into a dedicated
-- personal organization (slug user-<uuid>) with a default Starter (dev)
-- subscription and credit balance. Memberships are then cleared from the
-- unused legacy organization.
--
-- Idempotent and safe on any environment: it only touches the three known
-- default slugs AND only orgs that actually hold projects from more than one
-- owner, so it can never split a legitimate multi-member team, and it is a
-- no-op on a fresh database (no such orgs exist yet). projects.owner_user_id
-- is the recovered source of truth for who created each project. The emptied
-- organizations are left in place (zero members => invisible) so the operation stays
-- reversible.

do $$
declare
  shared      record;
  usr         record;
  target_org  uuid;
  new_slug    text;
  moved       int;
  total_moved int := 0;
  total_orgs  int := 0;
begin
  for shared in
    select o.id, o.slug
    from organizations o
    where o.slug in ('personal-organization', 'personal-team', 'personal-workspace')
      and (
        select count(distinct p.owner_user_id)
        from projects p
        where p.org_id = o.id and p.owner_user_id is not null
      ) > 1
  loop
    total_orgs := total_orgs + 1;
    raise notice 'repairing shared org % (%)', shared.slug, shared.id;

    for usr in
      select distinct owner_user_id as uid
      from projects
      where org_id = shared.id and owner_user_id is not null
    loop
      new_slug := 'user-' || lower(usr.uid::text);

      insert into organizations (slug, name)
      values (new_slug, 'Personal workspace')
      on conflict (slug) do nothing;
      select id into target_org from organizations where slug = new_slug;

      insert into org_memberships (org_id, user_id, role, invited_by)
      values (target_org, usr.uid, 'owner', null)
      on conflict (org_id, user_id) do nothing;

      insert into org_subscriptions
        (org_id, processor, external_id, status, currency, credit_limit, billing_cycle)
      select target_org, 'dev', gen_random_uuid()::text, 'active', 'USD', 200, 'starter'
      where not exists (
        select 1 from org_subscriptions s where s.org_id = target_org
      );

      insert into org_credit_balances (org_id, balance, credit_limit, on_hold)
      values (target_org, 200, 200, 0)
      on conflict (org_id) do nothing;

      update projects
      set org_id = target_org, updated_at = now()
      where org_id = shared.id and owner_user_id = usr.uid;
      get diagnostics moved = row_count;
      total_moved := total_moved + moved;
      raise notice '  moved % project(s) for user % -> %', moved, usr.uid, new_slug;
    end loop;

    delete from org_memberships where org_id = shared.id;
    raise notice '  cleared co-mingled memberships from %', shared.slug;
  end loop;

  raise notice 'DONE: repaired % shared org(s), moved % project(s) total',
    total_orgs, total_moved;
end $$;
