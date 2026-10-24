set local lock_timeout = '5s';

-- Add only the reference; validate existing rows in the next migration.
alter table public.agent_user_input_requests
    add constraint agent_user_input_requests_conversation_id_fkey
    foreign key (conversation_id) references public.conversations(id) on delete cascade not valid;
