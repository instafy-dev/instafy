set local lock_timeout = '5s';

alter table public.agent_user_input_requests
    validate constraint agent_user_input_requests_message_id_fkey;
