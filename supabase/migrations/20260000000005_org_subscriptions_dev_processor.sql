-- Allow the dev billing processor for local/test checkouts.

ALTER TABLE IF EXISTS org_subscriptions
  DROP CONSTRAINT IF EXISTS org_subscriptions_processor_check;

ALTER TABLE IF EXISTS org_subscriptions
  ADD CONSTRAINT org_subscriptions_processor_check
  CHECK (processor in ('stripe','dev'));
