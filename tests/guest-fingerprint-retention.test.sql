-- Run on a scratch database that has supabase/migrations/20261019052550_guest_fingerprint_retention_400_days.sql,
-- 20261019105404_guest_fingerprint_retention_fix_owner_rows.sql and the 20261020000100 guest-counters retention applied.
-- It was also run on the live project before applying, wrapped so that everything rolled back. Test data is fake.
begin;
do $$
declare
  old_a text := repeat('a', 64); new_a text := repeat('b', 64); old_c text := repeat('c', 64);
  alive_d text := repeat('d', 64); only_products_e text := repeat('e', 64);
  pid uuid; gid uuid; sid uuid := gen_random_uuid();
  r jsonb;
begin
  select id into pid from public.products limit 1;
  if pid is null then
    insert into public.products default values returning id into pid; -- scratch databases only; the live table always has rows
  end if;

  -- guests: one idle for 500 days, one seen today, one idle for 500 days but already converted
  insert into public.guest_visitors (fingerprint_hash, status, first_seen_at, last_seen_at) values
    (old_a, 'guest', now() - interval '510 days', now() - interval '500 days'),
    (new_a, 'guest', now() - interval '510 days', now() - interval '1 day'),
    (old_c, 'converted', now() - interval '510 days', now() - interval '500 days');
  select id into gid from public.guest_visitors where fingerprint_hash = old_a;

  -- the idle guest's detailed trail: a session, a product event and a search (all deleted with the guest)
  insert into public.customer_sessions (session_id, guest_id, started_at) values (sid, gid, now() - interval '500 days');
  insert into public.customer_product_events (session_id, guest_id, product_id, event_type, occurred_at)
    values (sid, gid, pid, 'view', now() - interval '500 days');
  insert into public.customer_searches (session_id, guest_id, search_text) values (sid, gid, 'fake search');

  insert into public.guest_fingerprints (analytics_hash, fp_hash, first_seen_at, last_seen_at) values
    (old_a, repeat('1', 32), now() - interval '510 days', now() - interval '500 days'),
    (new_a, repeat('2', 32), now() - interval '510 days', now() - interval '1 day'),
    -- an old fingerprint of a guest who is still active goes too: the signal itself is older than 400 days
    (new_a, repeat('3', 32), now() - interval '510 days', now() - interval '450 days'),
    -- a browser whose counters are old but that left a recent fingerprint is still alive
    (alive_d, repeat('4', 32), now() - interval '510 days', now() - interval '1 day');

  insert into public.guest_identity_links (hash_a, hash_b, score, created_at, last_confirmed_at) values
    (old_a, new_a, 0.9, now() - interval '510 days', now() - interval '500 days'),
    (new_a, old_c, 0.9, now() - interval '510 days', now() - interval '2 days');

  -- the guest counters: a browser idle for 500 days goes with its guest, every one of its days
  insert into public.guest_analytics_visits (visitor_hash, activity_date, first_seen_at, last_seen_at) values
    (old_a, (now() - interval '505 days')::date, now() - interval '505 days', now() - interval '505 days'),
    (old_a, (now() - interval '500 days')::date, now() - interval '500 days', now() - interval '500 days'),
    -- a guest who is still active keeps even the old days
    (new_a, (now() - interval '450 days')::date, now() - interval '450 days', now() - interval '450 days'),
    (new_a, (now() - interval '1 day')::date, now() - interval '1 day', now() - interval '1 day'),
    (alive_d, (now() - interval '500 days')::date, now() - interval '500 days', now() - interval '500 days');
  insert into public.guest_product_analytics (visitor_hash, product_id, activity_date, event_type, event_count, first_seen_at, last_seen_at) values
    (old_a, pid, (now() - interval '500 days')::date, 'view', 2, now() - interval '500 days', now() - interval '500 days'),
    (only_products_e, pid, (now() - interval '500 days')::date, 'cart_add', 1, now() - interval '500 days', now() - interval '500 days'),
    (new_a, pid, (now() - interval '450 days')::date, 'view', 3, now() - interval '450 days', now() - interval '450 days');

  r := public.purge_expired_guest_fingerprints();
  assert (r->>'guest_fingerprints')::int = 2, 'two fingerprints older than 400 days are deleted';
  assert (r->>'guest_identity_links')::int = 1, 'the link confirmed 500 days ago is deleted';
  assert (r->>'guest_visitors')::int = 1, 'only the idle guest-status visitor is deleted';
  assert (r->>'guest_sessions')::int = 1 and (r->>'guest_product_events')::int = 1, 'the idle guest''s session and event are deleted first';
  assert (r->>'guest_counter_visit_rows')::int = 2, 'both days of the idle browser are deleted';
  assert (r->>'guest_counter_product_rows')::int = 2, 'the idle browser and the products-only browser lose their product counters';

  assert exists (select 1 from public.guest_visitors where fingerprint_hash = new_a), 'an active guest is kept';
  assert exists (select 1 from public.guest_visitors where fingerprint_hash = old_c), 'a converted row is not touched by this job';
  assert not exists (select 1 from public.guest_visitors where fingerprint_hash = old_a), 'the idle guest is gone';
  assert not exists (select 1 from public.customer_sessions where session_id = sid), 'the idle guest''s session is gone';
  assert not exists (select 1 from public.customer_product_events where session_id = sid or guest_id = gid), 'the idle guest''s events are gone';
  assert not exists (select 1 from public.customer_searches where search_text = 'fake search'), 'the idle guest''s searches are gone';
  assert exists (select 1 from public.guest_fingerprints where analytics_hash = new_a and fp_hash = repeat('2', 32)), 'the recent fingerprint is kept';
  assert exists (select 1 from public.guest_identity_links where hash_a = new_a and hash_b = old_c), 'the recently confirmed link is kept';

  assert not exists (select 1 from public.guest_analytics_visits where visitor_hash = old_a), 'the idle guest''s visit counters are gone';
  assert not exists (select 1 from public.guest_product_analytics where visitor_hash in (old_a, only_products_e)), 'the idle guest''s product counters are gone';
  assert (select count(*) from public.guest_analytics_visits where visitor_hash = new_a) = 2, 'an active guest keeps all of its counter days, old ones included';
  assert exists (select 1 from public.guest_product_analytics where visitor_hash = new_a), 'an active guest keeps its product counters';
  assert exists (select 1 from public.guest_analytics_visits where visitor_hash = alive_d), 'a recent fingerprint keeps a browser alive';

  -- running it again deletes nothing more
  r := public.purge_expired_guest_fingerprints();
  assert (r->>'guest_fingerprints')::int = 0 and (r->>'guest_identity_links')::int = 0 and (r->>'guest_visitors')::int = 0
    and (r->>'guest_counter_visit_rows')::int = 0 and (r->>'guest_counter_product_rows')::int = 0, 'idempotent';

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
