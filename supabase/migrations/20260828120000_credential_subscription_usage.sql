-- Persist the most recent BYOC ChatGPT/Codex subscription-usage snapshot per
-- credential. Populated by the proxy (via the controller's internal usage
-- endpoint) from OpenAI's x-codex-* rate-limit response headers, and surfaced
-- read-only on GET /me/credentials as `subscriptionUsage`.
--
-- The JSON shape mirrors the frontend contract:
--   { "windows": [ { "kind", "usedPercent", "windowMinutes", "resetAt" } ],
--     "planName": <string|null>, "capturedAt": <unix_seconds_int> }
-- Null until the first usage report lands for the credential.

alter table if exists user_credentials
  add column if not exists subscription_usage jsonb;

alter table if exists user_credentials
  add column if not exists subscription_usage_updated_at timestamptz;
