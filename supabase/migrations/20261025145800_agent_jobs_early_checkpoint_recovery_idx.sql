-- Idle recovery inspects only terminal early checkpoints, not ordinary job history.
-- The controller rechecks group state and Stop intent under the existing group lock.
set local lock_timeout = '5s';

create index agent_jobs_early_checkpoint_recovery_idx
    on public.agent_jobs (completed_at, id)
    where status in ('completed', 'failed', 'canceled', 'cancelled', 'expired')
      and coalesce(agent_role, payload #>> '{metadata,multiAgentPlan,role}')
          in ('lead_continuation', 'synthesis')
      and payload #>> '{metadata,multiAgentPlan,checkpointKind}' = 'early_failure';
