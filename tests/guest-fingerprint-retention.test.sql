-- Run on a scratch database that has supabase/pending/20261019000100_guest_fingerprint_retention_400_days.sql applied
-- (or on the live project only after the owner approved applying it). Everything is rolled back. Test data is fake.
begin;
do $$
declare
  old_a text := repeat('a', 64); new_a text := repeat('b', 64); old_c text := repeat('c', 64);
  r jsonb;
begin
  -- guests: one idle for 500 days, one seen today, one idle for 500 days but already converted
  insert into public.guest_visitors (fingerprint_hash, status, first_seen_at, last_seen_at) values
    (old_a, 'guest', now() - interval '510 days', now() - interval '500 days'),
    (new_a, 'guest', now() - interval '510 days', now() - interval '1 day'),
    (old_c, 'converted', now() - interval '510 days', now() - interval '500 days');

  insert into public.guest_fingerprints (analytics_hash, fp_hash, first_seen_at, last_seen_at) values
    (old_a, repeat('1', 32), now() - interval '510 days', now() - interval '500 days'),
    (new_a, repeat('2', 32), now() - interval '510 days', now() - interval '1 day'),
    -- an old fingerprint of a guest who is still active goes too: the signal itself is older than 400 days
    (new_a, repeat('3', 32), now() - interval '510 days', now() - interval '450 days');

  insert into public.guest_identity_links (hash_a, hash_b, score, created_at, last_confirmed_at) values
    (old_a, new_a, 0.9, now() - interval '510 days', now() - interval '500 days'),
    (new_a, old_c, 0.9, now() - interval '510 days', now() - interval '2 days');

  -- aggregate counters are not part of this retention
  insert into public.guest_analytics_visits (visitor_hash, activity_date, first_seen_at, last_seen_at)
    values (old_a, (now() - interval '500 days')::date, now() - interval '500 days', now() - interval '500 days');

  r := public.purge_expired_guest_fingerprints();
  assert (r->>'guest_fingerprints')::int = 2, 'two fingerprints older than 400 days are deleted';
  assert (r->>'guest_identity_links')::int = 1, 'the link confirmed 500 days ago is deleted';
  assert (r->>'guest_visitors')::int = 1, 'only the idle guest-status visitor is deleted';

  assert exists (select 1 from public.guest_visitors where fingerprint_hash = new_a), 'an active guest is kept';
  assert exists (select 1 from public.guest_visitors where fingerprint_hash = old_c), 'a converted row is not touched by this job';
  assert not exists (select 1 from public.guest_visitors where fingerprint_hash = old_a), 'the idle guest is gone';
  assert exists (select 1 from public.guest_fingerprints where analytics_hash = new_a and fp_hash = repeat('2', 32)), 'the recent fingerprint is kept';
  assert exists (select 1 from public.guest_identity_links where hash_a = new_a and hash_b = old_c), 'the recently confirmed link is kept';
  assert exists (select 1 from public.guest_analytics_visits where visitor_hash = old_a), 'aggregate visit counters are not deleted';

  -- running it again deletes nothing more
  r := public.purge_expired_guest_fingerprints();
  assert (r->>'guest_fingerprints')::int = 0 and (r->>'guest_identity_links')::int = 0 and (r->>'guest_visitors')::int = 0, 'idempotent';

  -- a retention shorter than 30 days is refused
  begin
    perform public.purge_expired_guest_fingerprints(interval '1 day');
    assert false, 'must refuse a retention under 30 days';
  exception when sqlstate '22023' then null;
  end;

  -- the job is scheduled once, daily
  assert (select count(*) from cron.job where jobname = 'guest-fingerprint-retention-400d') = 1, 'scheduled once';
end;
$$;
rollback;
