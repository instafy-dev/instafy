-- Durable send-queue ordering ----------------------------------------------
--
-- Queue positions are immutable enqueue slots unless their owner explicitly
-- reorders pending work. The controller only permutes an owner's existing
-- slots, so one user cannot move work ahead of another user's allocation or
-- ahead of an entry that a drain has already claimed.

create sequence if not exists public.conversation_send_queue_position_seq
  as bigint;

alter table if exists public.conversation_send_queue
  add column if not exists queue_position bigint;

-- Fresh installs preserve the historical created_at/id order. The max offset
-- also makes this safe to resume after a partially applied development
-- migration without reusing an existing position.
with position_base as (
  select coalesce(max(queue_position), 0)::bigint as max_position
  from public.conversation_send_queue
), missing_positions as (
  select
    queue.id,
    position_base.max_position
      + row_number() over (order by queue.created_at asc, queue.id asc) as queue_position
  from public.conversation_send_queue as queue
  cross join position_base
  where queue.queue_position is null
)
update public.conversation_send_queue as queue
set queue_position = missing_positions.queue_position
from missing_positions
where queue.id = missing_positions.id;

select setval(
  'public.conversation_send_queue_position_seq',
  greatest(
    coalesce((select max(queue_position) from public.conversation_send_queue), 0),
    1
  ),
  exists(select 1 from public.conversation_send_queue)
);

alter sequence public.conversation_send_queue_position_seq
  owned by public.conversation_send_queue.queue_position;

alter table if exists public.conversation_send_queue
  alter column queue_position
  set default nextval('public.conversation_send_queue_position_seq');

alter table if exists public.conversation_send_queue
  alter column queue_position set not null;

do $send_queue_position_constraint$
begin
  if to_regclass('public.conversation_send_queue') is not null
     and not exists (
       select 1
       from pg_constraint
       where conrelid = 'public.conversation_send_queue'::regclass
         and conname = 'conversation_send_queue_position_check'
     ) then
    alter table public.conversation_send_queue
      add constraint conversation_send_queue_position_check
      check (queue_position > 0)
      not valid;
  end if;
end
$send_queue_position_constraint$;

alter table if exists public.conversation_send_queue
  validate constraint conversation_send_queue_position_check;

create index if not exists conversation_send_queue_dispatch_order_idx
  on public.conversation_send_queue(
    conversation_id,
    status,
    queue_position,
    id
  );

create index if not exists conversation_send_queue_owner_position_idx
  on public.conversation_send_queue(
    conversation_id,
    user_id,
    status,
    queue_position,
    id
  );
