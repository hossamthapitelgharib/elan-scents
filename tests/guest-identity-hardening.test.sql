-- Real-database test for supabase/migrations/<version>_guest_identity_hardening.sql
-- Run AFTER the migration, as the project owner, inside one transaction. Everything is rolled back.
-- All identifiers below are synthetic.
begin;

do $$
declare
  n text[];
  v_i integer;
  r jsonb;
  v_known text := md5('budget1') || md5('fill1');
begin
  -- 1. The legacy two-argument claim is gone; the complete one stays and is server-only.
  assert to_regprocedure('public.claim_guest_browser_cart(text,uuid)') is null, 'the legacy two-argument claim is removed';
  assert to_regprocedure('public.claim_guest_browser_cart(text,text,uuid)') is not null, 'the complete claim stays';
  assert not has_function_privilege('anon', 'public.claim_guest_browser_cart(text,text,uuid)', 'execute'), 'anon cannot claim';
  assert not has_function_privilege('authenticated', 'public.claim_guest_browser_cart(text,text,uuid)', 'execute'), 'signed-in users cannot claim directly';
  assert exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'guest_visitors_first_seen_idx'), 'the new-guest budget has its index';

  -- 2. One person never groups more than 8 browsers, however the links chain.
  n := array(select md5('hardening-n' || i) || md5('hardening-m' || i) from generate_series(1, 12) i);
  for v_i in 1..7 loop
    assert public.guest_identity_link(n[v_i], n[v_i + 1], 0.9, '[]'::jsonb), 'chain link ' || v_i || ' is accepted';
  end loop;
  assert not public.guest_identity_link(n[8], n[9], 0.9, '[]'::jsonb), 'a ninth browser cannot join the group of eight';
  assert public.guest_identity_link(n[9], n[10], 0.9, '[]'::jsonb), 'a separate pair is fine';
  assert not public.guest_identity_link(n[1], n[9], 0.9, '[]'::jsonb), 'two groups that would add up to more than eight are not joined';
  assert public.guest_identity_link(n[1], n[2], 0.95, '[]'::jsonb), 'an existing link of a full group can still be refreshed';
  assert public.guest_final_id(n[1]) = public.guest_final_id(n[8]), 'the eight chained browsers share one id';
  assert public.guest_final_id(n[9]) <> public.guest_final_id(n[1]), 'the refused browser keeps a separate id';

  -- 3. A fingerprint is stored only for a browser the server has seen.
  assert not public.guest_signal_store(repeat('a', 64), repeat('1', 32), '{"gpu":"g","screen":"s"}'::jsonb, null, null, null, null, null, 1, 1, 1),
    'an unknown browser identifier stores nothing';
  assert not exists (select 1 from public.guest_fingerprints where analytics_hash = repeat('a', 64)), 'no fingerprint row was created';
  perform public.resolve_guest_browser(repeat('b', 64), repeat('a', 64));
  assert public.guest_signal_store(repeat('a', 64), repeat('1', 32), '{"gpu":"g","screen":"s"}'::jsonb, null, null, null, null, null, 1, 1, 1),
    'a browser that has been seen stores its fingerprint';

  -- 4. Exact fingerprint matches come first, before fifty more recent look-alikes.
  insert into public.guest_fingerprints (analytics_hash, fp_hash, parts, last_seen_at)
  select md5('weak' || i) || md5('x' || i), md5('wfp' || i), '{"gpu":"gpux","screen":"scr"}'::jsonb, now() - (i || ' seconds')::interval
  from generate_series(1, 55) i;
  insert into public.guest_fingerprints (analytics_hash, fp_hash, parts, last_seen_at)
  values (repeat('c', 64), repeat('f', 32), '{"gpu":"gpux","screen":"scr"}'::jsonb, now() - interval '10 days');
  r := public.guest_signal_candidates(repeat('d', 64), repeat('f', 32), 'gpux', 'scr');
  assert jsonb_array_length(r) = 50, 'at most fifty candidates are returned';
  assert r->0->>'analyticsHash' = repeat('c', 64), 'the exact fingerprint match is first even though it is the oldest';

  -- 5. The budget for brand-new guests. (Last, because it fills the hour.)
  perform public.resolve_guest_browser(v_known, repeat('9', 64));
  insert into public.guest_visitors (fingerprint_hash, identity_version)
  select md5('budget' || i) || md5('fill' || i), 2 from generate_series(1, 2000) i
  on conflict do nothing;
  r := public.resolve_guest_browser(repeat('7', 64), repeat('8', 64));
  assert (r->>'limited')::boolean, 'a new guest over the hourly budget is refused';
  assert r->>'visitorId' is null and r->'cart' = '[]'::jsonb, 'the refusal carries no identity and an empty basket';
  assert not exists (select 1 from public.guest_visitors where fingerprint_hash = repeat('7', 64)), 'no guest row was created';
  assert not exists (select 1 from public.guest_analytics_visits where visitor_hash = repeat('8', 64)), 'no visit row was created';
  r := public.save_guest_browser_cart(repeat('7', 64), repeat('8', 64), '[]'::jsonb);
  assert (r->>'limited')::boolean, 'saving a basket cannot get around the budget';
  assert not exists (select 1 from public.guest_visitors where fingerprint_hash = repeat('7', 64)), 'saving created no guest row';
  r := public.resolve_guest_browser(v_known, repeat('9', 64));
  assert r->>'limited' is null and r->>'visitorId' is not null, 'a guest who already exists is never affected by the budget';
  r := public.save_guest_browser_cart(v_known, repeat('9', 64), '[]'::jsonb);
  assert r->>'limited' is null and r->>'visitorId' is not null, 'an existing guest can still save a basket';

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
