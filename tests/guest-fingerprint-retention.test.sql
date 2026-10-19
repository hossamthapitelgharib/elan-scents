-- Real-database test for the guest fingerprint retention job.
-- Run on a scratch database that has supabase/migrations/20261019052550_guest_fingerprint_retention_400_days.sql and
-- supabase/migrations/20261019105404_guest_fingerprint_retention_fix_owner_rows.sql applied (the live project has both).
-- Everything is rolled back. Test data is fake.
begin;
do $$
declare
  old_a text := repeat('a', 64); new_a text := repeat('b', 64); old_c text := repeat('c', 64);
  an_old text := repeat('d', 64); an_new text := repeat('e', 64);
  v_prod uuid;
  r jsonb;
begin
  select id into v_prod from public.products order by id limit 1;
  assert v_prod is not null, 'the test needs one existing product';

  -- guests created the normal way, so they have sessions and product events like real ones
  perform public.resolve_guest_browser(old_a, an_old);
  perform public.resolve_guest_browser(new_a, an_new);
  assert public.record_customer_product_event(old_a, an_old, null, null, 'view', v_prod, null, null, null), 'event of the idle guest';
  assert public.record_customer_product_event(new_a, an_new, null, null, 'view', v_prod, null, null, null), 'event of the active guest';
  insert into public.customer_sessions (session_id, guest_id) select gen_random_uuid(), id from public.guest_visitors where fingerprint_hash = old_a;
  -- one idle for 500 days, one seen today, one idle for 500 days but already converted
  update public.guest_visitors set first_seen_at = now() - interval '510 days', last_seen_at = now() - interval '500 days' where fingerprint_hash = old_a;
  insert into public.guest_visitors (fingerprint_hash, status, first_seen_at, last_seen_at)
    values (old_c, 'converted', now() - interval '510 days', now() - interval '500 days');

  insert into public.guest_fingerprints (analytics_hash, fp_hash, first_seen_at, last_seen_at) values
    (an_old, repeat('1', 32), now() - interval '510 days', now() - interval '500 days'),
    (an_new, repeat('2', 32), now() - interval '510 days', now() - interval '1 day'),
    -- an old fingerprint of a guest who is still active goes too: the signal itself is older than 400 days
    (an_new, repeat('3', 32), now() - interval '510 days', now() - interval '450 days');

  insert into public.guest_identity_links (hash_a, hash_b, score, created_at, last_confirmed_at) values
    (an_old, an_new, 0.9, now() - interval '510 days', now() - interval '500 days'),
    (an_new, repeat('f', 64), 0.9, now() - interval '510 days', now() - interval '2 days');

  -- aggregate counters are not part of this retention
  update public.guest_analytics_visits set activity_date = (now() - interval '500 days')::date where visitor_hash = an_old;
  assert exists (select 1 from public.guest_analytics_visits where visitor_hash = an_old), 'the idle guest has an aggregate visit row';

  r := public.purge_expired_guest_fingerprints();
  assert (r->>'guest_fingerprints')::int = 2, 'two fingerprints older than 400 days are deleted';
  assert (r->>'guest_identity_links')::int = 1, 'the link confirmed 500 days ago is deleted';
  assert (r->>'guest_visitors')::int = 1, 'only the idle guest-status visitor is deleted';
  assert (r->>'guest_product_events')::int = 1 and (r->>'guest_sessions')::int = 1, 'the idle guest''s event and session go with it';

  assert exists (select 1 from public.guest_visitors where fingerprint_hash = new_a), 'an active guest is kept';
  assert exists (select 1 from public.guest_visitors where fingerprint_hash = old_c), 'a converted row is not touched by this job';
  assert not exists (select 1 from public.guest_visitors where fingerprint_hash = old_a), 'the idle guest is gone';
  assert exists (select 1 from public.customer_product_events e join public.guest_visitors v on v.id = e.guest_id where v.fingerprint_hash = new_a), 'the active guest keeps its event';
  assert not exists (select 1 from public.customer_product_events where guest_id is null and user_id is null), 'no owner-less event is left behind';
  assert not exists (select 1 from public.customer_sessions where guest_id is null and user_id is null), 'no owner-less session is left behind';
  assert exists (select 1 from public.guest_fingerprints where analytics_hash = an_new and fp_hash = repeat('2', 32)), 'the recent fingerprint is kept';
  assert exists (select 1 from public.guest_identity_links where hash_a = an_new and hash_b = repeat('f', 64)), 'the recently confirmed link is kept';
  assert exists (select 1 from public.guest_analytics_visits where visitor_hash = an_old), 'aggregate visit counters are not deleted';

  -- running it again deletes nothing more
  r := public.purge_expired_guest_fingerprints();
  assert (r->>'guest_fingerprints')::int = 0 and (r->>'guest_identity_links')::int = 0 and (r->>'guest_visitors')::int = 0
     and (r->>'guest_product_events')::int = 0 and (r->>'guest_sessions')::int = 0, 'idempotent';

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
