-- Seeds a development organization and attaches all existing projects to it.
-- Intended for local environments only.

DO $$
DECLARE
  dev_org_id uuid;
  dev_user_id uuid;
BEGIN
  -- Upsert a development org
  INSERT INTO organizations (slug, name, billing_email)
  VALUES ('dev', 'Instafy Dev Org', 'dev@instafy.local')
  ON CONFLICT (slug) DO UPDATE
    SET name = EXCLUDED.name,
        billing_email = EXCLUDED.billing_email
  RETURNING id INTO dev_org_id;

  -- Attach all projects without an org to the dev org
  UPDATE projects
  SET org_id = dev_org_id
  WHERE org_id IS NULL;

  -- Link the fallback local user if it exists in auth.users
  SELECT id INTO dev_user_id
  FROM auth.users
  WHERE email = 'dev@instafy.local'
  LIMIT 1;

  IF dev_user_id IS NOT NULL THEN
    INSERT INTO profiles (user_id, default_org_id, full_name)
    VALUES (dev_user_id, dev_org_id, 'Instafy Dev User')
    ON CONFLICT (user_id) DO UPDATE
      SET default_org_id = EXCLUDED.default_org_id;

    INSERT INTO org_memberships (org_id, user_id, role)
    VALUES (dev_org_id, dev_user_id, 'owner')
    ON CONFLICT (org_id, user_id) DO UPDATE
      SET role = EXCLUDED.role;
  END IF;
END
$$;
