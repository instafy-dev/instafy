-- Allow self-hosted tunnel provider records.

ALTER TABLE runtime_tunnel_grants
  ALTER COLUMN provider SET DEFAULT 'self_hosted';

ALTER TABLE runtime_tunnel_grants
  DROP CONSTRAINT IF EXISTS runtime_tunnel_grants_provider_check;

ALTER TABLE runtime_tunnel_grants
  ADD CONSTRAINT runtime_tunnel_grants_provider_check
  CHECK (provider IN ('self_hosted'));
