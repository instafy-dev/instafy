-- Search indexes only: message contents remain canonical conversation records.
-- Trigrams support literal substring matching for historical user/assistant text.
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

do $message_search_index$
declare extension_schema text;
begin
  select n.nspname into extension_schema
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_trgm';
  execute format('create index if not exists conversation_messages_search_content_idx
    on public.conversation_messages using gin (lower(content) %I.gin_trgm_ops)
    where role in (''user'', ''assistant'')', extension_schema);
end
$message_search_index$;

create index if not exists conversation_messages_context_order_idx
  on public.conversation_messages (conversation_id, created_at desc, id desc);
