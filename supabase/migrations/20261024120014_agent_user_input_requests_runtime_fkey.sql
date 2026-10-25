set local lock_timeout = '5s';

-- Add only the reference; validate existing rows in the next migration.
alter table public.agent_user_input_requests
    add constraint agent_user_input_requests_runtime_id_fkey
    foreign key (runtime_id) references public.runtimes(id) on delete set null not valid;
