-- Add new server columns (idempotent)
alter table public."match-stream-app"
  add column if not exists stream_url_6 text,
  add column if not exists stream_url_7 text;

-- Verify columns
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'match-stream-app'
  and column_name in ('stream_url_6', 'stream_url_7')
order by column_name;

-- Optional: inspect current RPC body to confirm it writes stream_url_6/7
select n.nspname as schema_name, p.proname as function_name, pg_get_functiondef(p.oid) as function_sql
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'refresh_match_stream_app'
order by n.nspname;
