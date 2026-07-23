-- Add per-agent model overrides (OpenAI / DeepSeek / z.ai).
--
-- Note: Instafy Studio is not live yet; no backfills/migrations required beyond schema updates.

alter table if exists user_agents
  add column if not exists model text;

