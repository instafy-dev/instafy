set local lock_timeout = '5s';

alter table public.agent_user_input_requests
    validate constraint agent_user_input_requests_run_id_fkey;
