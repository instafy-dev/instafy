-- Add editable descriptions to user-scoped AI agent profiles (bots + Octo).
--
-- Note: Instafy Studio is not live yet; no backfills/migrations required beyond schema updates.

alter table if exists user_agents
  add column if not exists description text;

