-- Agent job hierarchy -------------------------------------------------------
-- First-class parent/group linkage for multi-agent plan jobs. The same facts
-- continue to live in payload metadata (multiAgentPlan.parentJobId/groupId/role)
-- because the runtime reads them from the payload; these columns exist so the
-- controller can query and cancel by hierarchy without JSONB path scans.

alter table agent_jobs
    add column if not exists parent_job_id uuid references agent_jobs(id) on delete set null;

alter table agent_jobs
    add column if not exists plan_group_id uuid;

alter table agent_jobs
    add column if not exists agent_role text;

create index if not exists agent_jobs_parent_job_idx
    on agent_jobs(parent_job_id)
    where parent_job_id is not null;

create index if not exists agent_jobs_plan_group_idx
    on agent_jobs(plan_group_id)
    where plan_group_id is not null;

-- Backfill from payload metadata so column-first queries (plan-group status,
-- group cancel, sibling snapshots) never need the unindexed JSONB fallback for
-- pre-existing rows.
update agent_jobs
set plan_group_id = (payload #>> '{metadata,multiAgentPlan,groupId}')::uuid
where plan_group_id is null
  and payload #>> '{metadata,multiAgentPlan,groupId}'
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

update agent_jobs
set parent_job_id = parent.id
from agent_jobs parent
where agent_jobs.parent_job_id is null
  and agent_jobs.payload #>> '{metadata,multiAgentPlan,parentJobId}'
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and parent.id = (agent_jobs.payload #>> '{metadata,multiAgentPlan,parentJobId}')::uuid
  and parent.project_id = agent_jobs.project_id;

update agent_jobs
set agent_role = nullif(trim(payload #>> '{metadata,multiAgentPlan,role}'), '')
where agent_role is null
  and payload #>> '{metadata,multiAgentPlan,role}' is not null;
