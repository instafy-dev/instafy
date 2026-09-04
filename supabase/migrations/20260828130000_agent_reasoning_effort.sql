-- Add per-agent reasoning effort override (minimal|low|medium|high; null = inherit).
--
-- Mirrors the per-agent model override column (20260000000026_agent_model_overrides.sql).
-- Note: Instafy Studio is not live yet; no backfills/migrations required beyond schema updates.

alter table if exists user_agents
  add column if not exists reasoning_effort text;
