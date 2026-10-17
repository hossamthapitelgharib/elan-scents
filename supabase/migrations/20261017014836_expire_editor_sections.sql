-- Timed sections must expire even while the visual editor is closed.
-- Keep the row and its manual items: expiry is archival, never a hard delete.
create or replace function public.expire_editor_sections()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  archived_count integer;
begin
  update public.editor_sections
     set status = 'archived',
         archived_at = clock_timestamp(),
         archive_reason = 'timer_expired',
         updated_at = clock_timestamp()
   where status = 'active'
     and timer_mode in ('window', 'duration')
     and ends_at is not null
     and ends_at <= clock_timestamp();

  get diagnostics archived_count = row_count;
  return archived_count;
end;
$$;

comment on function public.expire_editor_sections() is
  'Archives editor sections after their configured end time; does not delete sections or their items.';

revoke all on function public.expire_editor_sections() from public, anon, authenticated;
grant execute on function public.expire_editor_sections() to service_role;

do $$
declare
  previous_job bigint;
begin
  select jobid into previous_job
    from cron.job
   where jobname = 'expire-editor-sections'
   limit 1;

  if previous_job is not null then
    perform cron.unschedule(previous_job);
  end if;

  perform cron.schedule(
    'expire-editor-sections',
    '* * * * *',
    'select public.expire_editor_sections();'
  );
end;
$$;
