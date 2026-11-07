-- Add this reference separately so table creation does not hold conflicting
-- locks on both agent_jobs and conversations in one transaction.
set local lock_timeout = '5s';
alter table public.conversation_goal_continuations
    add constraint conversation_goal_continuations_conversation_id_fkey
    foreign key (conversation_id) references public.conversations(id) on delete cascade;
