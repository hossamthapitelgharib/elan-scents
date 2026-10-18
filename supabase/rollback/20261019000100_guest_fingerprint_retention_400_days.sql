-- Rolls back pending/20261019000100_guest_fingerprint_retention_400_days.sql.
-- Rows the job already deleted are not restored; this only stops any further deletion.
begin;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'guest-fingerprint-retention-400d') then
    perform cron.unschedule('guest-fingerprint-retention-400d');
  end if;
end;
$$;

drop function if exists public.purge_expired_guest_fingerprints(interval);
drop index if exists public.guest_fingerprints_last_seen_idx;
drop index if exists public.guest_identity_links_last_confirmed_idx;

commit;
