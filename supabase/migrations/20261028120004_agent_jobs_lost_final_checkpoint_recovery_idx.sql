-- Idle recovery of a lost final plan lead reads only recently ended plan workers.
-- The controller rechecks group state and Stop intent under the existing group lock.
set local lock_timeout = '5s';

create index agent_jobs_lost_final_checkpoint_recovery_idx
    on public.agent_jobs (completed_at, id)
    where agent_role = 'worker'
      and plan_group_id is not null
      and status in ('completed', 'failed', 'canceled', 'cancelled', 'expired');
