-- 20261017014836_expire_editor_sections already archives expired sections every minute
-- (public.expire_editor_sections + cron job 'expire-editor-sections').
-- The earlier migration 'archive_expired_editor_sections' duplicated it by mistake; remove only that duplicate.
do $$
declare
  duplicate_job bigint;
begin
  select jobid into duplicate_job from cron.job where jobname = 'archive-expired-editor-sections' limit 1;
  if duplicate_job is not null then
    perform cron.unschedule(duplicate_job);
  end if;
end;
$$;

drop function if exists private.archive_expired_editor_sections();
