set local lock_timeout = '5s';

-- Deferred worker questions survive normal completion without retaining a runtime lease.
-- Only the controller writes these rows; a reply is bound to one exact worker job.
create table public.agent_user_input_requests (
    id uuid primary key default gen_random_uuid(),
    -- Lock referenced parents before their children when creating the table.
    requested_user_id uuid references auth.users(id) on delete set null,
    answered_by uuid references auth.users(id) on delete set null,
    project_id uuid not null references public.projects(id) on delete cascade,
    conversation_id uuid not null,
    job_id uuid not null unique references public.agent_jobs(id) on delete cascade,
    run_id uuid,
    prompt_id uuid,
    runtime_id uuid,
    lease_attempt integer not null check (lease_attempt >= 0),
    group_id uuid not null,
    agent_handle text not null,
    questions jsonb not null check (jsonb_typeof(questions) = 'array'),
    message_id uuid,
    continuation_note text not null,
    status text not null default 'pending' check (status in ('pending','answered','resumed','expired')),
    expired_reason text,
    answers jsonb,
    answer_message_id uuid,
    resumed_job_id uuid references public.agent_jobs(id) on delete set null,
    resume_attempts integer not null default 0 check (resume_attempts >= 0),
    resume_after timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    answered_at timestamptz,
    check (answers is null or jsonb_typeof(answers) = 'object')
);

create index agent_user_input_requests_group_pending
    on public.agent_user_input_requests(project_id, group_id)
    where status in ('pending','answered');

create index agent_user_input_requests_recovery
    on public.agent_user_input_requests(updated_at)
    where status in ('pending','answered');

-- Redispatch is durable across a crash between queueing the continuation and
-- recording its ID. A request may produce exactly one continuation job.
create unique index agent_jobs_user_input_continuation_request
    on public.agent_jobs ((payload #>> '{metadata,multiAgentPlan,userInputContinuation,requestId}'))
    where payload #>> '{metadata,multiAgentPlan,userInputContinuation,requestId}' is not null;

-- Keep the ordinary run and chat views consistent even when invalidation is
-- performed by a job-state trigger or a group cancellation transaction.
create function public.sync_agent_user_input_request_presentation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    update public.runs
    set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
            'userInputRequest', jsonb_build_object('requestId', new.id, 'status', new.status)),
        updated_at = now()
    where id = new.run_id;
    update public.conversation_messages
    set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{details}',
            coalesce(metadata->'details', '{}'::jsonb) || jsonb_build_object(
                'userInputRequestId', new.id, 'userInputRequestStatus', new.status))
    where id = new.message_id;
    return new;
end;
$$;

create trigger sync_agent_user_input_request_presentation
    after insert or update of status, message_id on public.agent_user_input_requests
    for each row execute function public.sync_agent_user_input_request_presentation();

alter table public.agent_user_input_requests enable row level security;
revoke all privileges on public.agent_user_input_requests from anon, authenticated;

create function public.expire_agent_user_input_requests_on_job_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if new.status in ('failed','canceled','expired')
       or (old.status = 'leased' and new.status not in ('leased','completed'))
       or new.lease_attempts is distinct from old.lease_attempts
       or (old.status = 'leased' and new.status = 'leased'
           and new.leased_by_runtime_id is distinct from old.leased_by_runtime_id) then
        update public.agent_user_input_requests
        set status = 'expired', expired_reason = 'The worker lease or job is no longer active.', updated_at = now()
        where job_id = new.id and status in ('pending','answered');
    end if;
    return new;
end;
$$;

create trigger expire_agent_user_input_requests_on_job_change
    after update on public.agent_jobs
    for each row execute function public.expire_agent_user_input_requests_on_job_change();
