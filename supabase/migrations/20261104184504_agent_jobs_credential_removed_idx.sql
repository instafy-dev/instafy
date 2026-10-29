set local lock_timeout = '5s';

-- The sweep that settles the jobs agent_jobs_fail_on_credential_removal failed
-- reads only those rows. A plain index build holds SHARE on agent_jobs, which
-- blocks writes to it but no read, while it scans the table, so it has a file
-- of its own, as 20261025145800 does.
create index agent_jobs_credential_removed_idx
    on public.agent_jobs (credential_removed_at)
    where credential_removed_at is not null;
