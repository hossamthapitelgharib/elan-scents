-- Permanently archive editor sections whose timer has ended. Never deletes: the row stays,
-- marked archived with reason 'timer_expired'. The public_read policy already hides an expired
-- section the moment its end time passes; this job only makes the archive state permanent.
-- To restore one: set status='active', archived_at=null, archive_reason=null AND clear or move
-- its timer (otherwise the next run archives it again).
create or replace function private.archive_expired_editor_sections()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  archived_count integer;
begin
  with expired as (
    update public.editor_sections
       set status = 'archived',
           archived_at = now(),
           archive_reason = 'timer_expired'
     where status = 'active'
       and ends_at is not null
       and ends_at <= now()
    returning 1
  )
  select count(*) into archived_count from expired;
  return archived_count;
end;
$$;

revoke all on function private.archive_expired_editor_sections() from public, anon, authenticated;

select cron.schedule(
  'archive-expired-editor-sections',
  '*/5 * * * *',
  $job$select private.archive_expired_editor_sections()$job$
);
