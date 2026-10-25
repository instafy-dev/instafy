-- A provider device may have an owner and publish its tool catalog. Kept
-- apart from the agent_jobs migration before it, which may not also lock
-- another existing table. Controller-only, like the table.
set local lock_timeout = '5s';

-- owner_user_id: the person whose own session registered the device as theirs,
-- where device grants are on for them. Only they may then heartbeat it, list
-- its requests, or claim and complete requests as it, and it takes only their
-- requests. Null: the device keeps the project's rules. catalog: the device's
-- tools in MCP tools/list shape, with the MCP initialize instructions they
-- come with: {"instructions"?: text, "tools": [{"name", "inputSchema", ...}]}.
alter table public.project_provider_devices
  add column if not exists owner_user_id uuid,
  add column if not exists catalog jsonb;
