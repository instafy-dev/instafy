set local lock_timeout = '5s';

-- Add only the reference; validate existing rows in the next migration.
alter table public.agent_user_input_requests
    add constraint agent_user_input_requests_prompt_id_fkey
    foreign key (prompt_id) references public.prompts(id) on delete set null not valid;
