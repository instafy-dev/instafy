set local lock_timeout = '5s';

-- Add only the reference; validate existing rows in the next migration.
alter table public.agent_user_input_requests
    add constraint agent_user_input_requests_message_id_fkey
    foreign key (message_id) references public.conversation_messages(id) on delete set null not valid,
    add constraint agent_user_input_requests_answer_message_id_fkey
    foreign key (answer_message_id) references public.conversation_messages(id) on delete set null not valid;
