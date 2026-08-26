-- Durable ordered input commands for an already-leased agent job.
--
-- Human clients never write this table directly. The controller resolves the
-- authoritative live job/runtime, persists the visible conversation message,
-- and inserts one command in the same transaction. The leasing runtime then
-- claims and acknowledges commands through its scoped agent credential.

create table if not exists public.agent_job_inputs (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.projects(id) on delete cascade,
    conversation_id uuid not null references public.conversations(id) on delete cascade,
    job_id uuid not null references public.agent_jobs(id) on delete cascade,
    run_id uuid references public.runs(id) on delete set null,
    message_id uuid references public.conversation_messages(id) on delete set null,
    created_by uuid,
    client_send_id text not null,
    lease_attempt integer not null,
    target_turn_id text not null,
    sequence bigint not null,
    kind text not null default 'active_turn_input',
    request jsonb not null,
    status text not null default 'pending',
    claimed_by_runtime_id uuid references public.runtimes(id) on delete set null,
    claimed_at timestamptz,
    applied_at timestamptz,
    rejected_at timestamptz,
    rejected_by text,
    codex_turn_id text,
    error_message text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint agent_job_inputs_sequence_positive check (sequence > 0),
    constraint agent_job_inputs_lease_attempt_nonnegative check (lease_attempt >= 0),
    constraint agent_job_inputs_target_turn_id_nonempty
        check (length(btrim(target_turn_id)) between 1 and 200),
    constraint agent_job_inputs_kind_check check (kind = 'active_turn_input'),
    constraint agent_job_inputs_status_check
        check (status in ('pending', 'delivering', 'applied', 'rejected')),
    constraint agent_job_inputs_rejected_by_check
        check (rejected_by is null or rejected_by in ('controller', 'runtime', 'legacy')),
    constraint agent_job_inputs_job_sequence_unique unique (job_id, sequence)
);

-- Keep this migration restart-safe for development databases that may have
-- applied an earlier draft before exact-turn fencing was introduced. Legacy
-- commands are deliberately bound to an ID no provider turn can advertise;
-- the lease-end reconciler will reject them instead of applying them to a
-- different turn.
alter table public.agent_job_inputs
    add column if not exists target_turn_id text;

alter table public.agent_job_inputs
    add column if not exists rejected_by text;

update public.agent_job_inputs
set target_turn_id = 'legacy-unbound-' || id::text
where target_turn_id is null;

alter table public.agent_job_inputs
    alter column target_turn_id set not null;

update public.agent_job_inputs
set rejected_by = 'legacy'
where status = 'rejected' and rejected_by is null;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conrelid = 'public.agent_job_inputs'::regclass
          and conname = 'agent_job_inputs_target_turn_id_nonempty'
    ) then
        alter table public.agent_job_inputs
            add constraint agent_job_inputs_target_turn_id_nonempty
            check (length(btrim(target_turn_id)) between 1 and 200);
    end if;
end;
$$;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conrelid = 'public.agent_job_inputs'::regclass
          and conname = 'agent_job_inputs_rejected_by_check'
    ) then
        alter table public.agent_job_inputs
            add constraint agent_job_inputs_rejected_by_check
            check (rejected_by is null or rejected_by in ('controller', 'runtime', 'legacy'));
    end if;
end;
$$;

-- A client send id is idempotent for one actor in one conversation. PostgreSQL
-- treats NULLs as distinct in a normal unique constraint, so coalesce the
-- controller/service actor to a sentinel UUID in the index.
create unique index if not exists agent_job_inputs_client_send_unique
    on public.agent_job_inputs (
        conversation_id,
        coalesce(created_by, '00000000-0000-0000-0000-000000000000'::uuid),
        client_send_id
    );

create index if not exists agent_job_inputs_delivery_idx
    on public.agent_job_inputs (job_id, status, sequence)
    where status in ('pending', 'delivering');

create index if not exists agent_job_inputs_conversation_idx
    on public.agent_job_inputs (conversation_id, created_at desc);

-- A runtime advertises readiness only while its embedded provider owns a
-- steerable live turn for this exact job/lease attempt. This prevents a
-- runtime-wide capability from making terminal, workflow, or direct-worker
-- jobs look steerable merely because they use the same runtime binary.
alter table public.agent_jobs
    add column if not exists active_input_ready_runtime_id uuid
        references public.runtimes(id) on delete set null;

alter table public.agent_jobs
    add column if not exists active_input_ready_expires_at timestamptz;

alter table public.agent_jobs
    add column if not exists active_input_ready_turn_id text;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conrelid = 'public.agent_jobs'::regclass
          and conname = 'agent_jobs_active_input_ready_turn_id_length'
    ) then
        alter table public.agent_jobs
            add constraint agent_jobs_active_input_ready_turn_id_length
            check (
                active_input_ready_turn_id is null
                or length(btrim(active_input_ready_turn_id)) between 1 and 200
            );
    end if;
end;
$$;

create index if not exists agent_jobs_active_input_ready_idx
    on public.agent_jobs (conversation_id, active_input_ready_expires_at)
    where status = 'leased' and active_input_ready_expires_at is not null;

-- Central lease-end safety net. The primary completion/cancel/expiry paths
-- clear readiness and publish command-state events in controller code. Less
-- common terminalization paths (browser disconnects, plan/group completion,
-- runtime requeue) historically update agent_jobs directly; when they leave a
-- live input marker behind this trigger rejects the command and reconciles the
-- visible message rather than allowing a permanent `delivering` state.
create or replace function public.reject_agent_job_inputs_on_lease_end()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    rejection_reason text := 'agent job left its active lease before input acknowledgement';
begin
    if new.active_input_ready_runtime_id is null then
        new.active_input_ready_expires_at := null;
        new.active_input_ready_turn_id := null;
    end if;

    if old.status = 'leased'
       and (
           new.status is distinct from 'leased'
           or new.leased_by_runtime_id is distinct from old.leased_by_runtime_id
           or new.lease_attempts is distinct from old.lease_attempts
       )
       and old.active_input_ready_runtime_id is not null
       and new.active_input_ready_runtime_id is not null then
        new.active_input_ready_runtime_id := null;
        new.active_input_ready_expires_at := null;
        new.active_input_ready_turn_id := null;

        update public.agent_job_inputs
        set status = 'rejected',
            rejected_at = now(),
            rejected_by = 'controller',
            error_message = rejection_reason,
            updated_at = now()
        where job_id = new.id
          and status in ('pending', 'delivering');

        update public.conversation_messages messages
        set metadata = jsonb_set(
                jsonb_set(
                    coalesce(messages.metadata, '{}'::jsonb),
                    '{sendIntent,state}',
                    '"rejected"'::jsonb,
                    true
                ),
                '{sendIntent,errorMessage}',
                to_jsonb(rejection_reason),
                true
            )
        from public.agent_job_inputs inputs
        where inputs.job_id = new.id
          and inputs.message_id = messages.id
          and inputs.status = 'rejected'
          and inputs.error_message = rejection_reason;
    end if;
    return new;
end;
$$;

drop trigger if exists reject_agent_job_inputs_on_lease_end on public.agent_jobs;
create trigger reject_agent_job_inputs_on_lease_end
    before update on public.agent_jobs
    for each row execute function public.reject_agent_job_inputs_on_lease_end();

drop trigger if exists set_agent_job_inputs_updated_at on public.agent_job_inputs;
create trigger set_agent_job_inputs_updated_at
    before update on public.agent_job_inputs
    for each row execute function public.set_timestamp();

alter table public.agent_job_inputs enable row level security;
revoke all privileges on table public.agent_job_inputs from anon, authenticated;
