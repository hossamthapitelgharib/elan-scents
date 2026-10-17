-- Real-database test for the guest fingerprint, merge and claim migrations:
--   20261017011522_guest_conversions_and_claim_conversion_record.sql
--   20261017011533_merge_duplicate_guest_browsers.sql
--   20261017011558_guest_fingerprint_signals.sql
-- Run AFTER the migrations, inside one transaction. Everything is rolled back; no test data is left in Supabase.
-- It creates a throw-away auth user and fake hashes only, so no real customer data is touched.
begin;

do $$
declare
  v_uid uuid := gen_random_uuid();
  v_res jsonb;
  v_cand jsonb;
  v_fp text := repeat('a',64);
  v_an text := repeat('b',64);
  h1 text := repeat('1',64);
  h2 text := repeat('2',64);
  fpa text := repeat('a',28);
  i int;
begin
  -- privileges: the tables and functions are reachable by the server only ------------------------
  assert (select relrowsecurity from pg_class where oid = 'public.guest_conversions'::regclass), 'RLS on guest_conversions';
  assert (select relrowsecurity from pg_class where oid = 'public.guest_fingerprints'::regclass), 'RLS on guest_fingerprints';
  assert (select relrowsecurity from pg_class where oid = 'public.guest_identity_links'::regclass), 'RLS on guest_identity_links';
  assert not has_table_privilege('anon', 'public.guest_fingerprints', 'SELECT'), 'anon cannot read guest_fingerprints';
  assert not has_table_privilege('authenticated', 'public.guest_identity_links', 'SELECT'), 'authenticated cannot read guest_identity_links';
  assert not has_table_privilege('anon', 'public.guest_conversions', 'SELECT'), 'anon cannot read guest_conversions';
  assert not has_function_privilege('anon', 'public.guest_signal_store(text,text,jsonb,text,text,text,text,text,integer,integer,integer)', 'EXECUTE'), 'anon cannot run guest_signal_store';
  assert not has_function_privilege('authenticated', 'public.merge_guest_browser(text,text,text,text)', 'EXECUTE'), 'authenticated cannot run merge';
  assert not has_function_privilege('authenticated', 'public.claim_guest_browser_cart(text,text,uuid)', 'EXECUTE'), 'authenticated cannot run claim';
  assert has_function_privilege('service_role', 'public.claim_guest_browser_cart(text,text,uuid)', 'EXECUTE'), 'the server can run claim';

  -- signals: two guests with the same fingerprint find each other, link, share one final id, and the 5-link cap holds
  assert public.guest_signal_store(h1, fpa, '{"gpu":"g","screen":"s"}'::jsonb, repeat('3',64), repeat('4',64), null, null, null, 5, 20, 2), 'store 1';
  assert public.guest_signal_store(h2, fpa, '{"gpu":"g","screen":"s"}'::jsonb, repeat('3',64), repeat('4',64), null, null, null, 5, 20, 2), 'store 2';
  v_cand := public.guest_signal_candidates(h2, fpa, 'g', 's');
  assert jsonb_array_length(v_cand) = 1 and v_cand->0->>'analyticsHash' = h1, 'candidate found';
  assert (v_cand->0->>'popularity')::int = 2, 'popularity counts both guests';
  assert public.guest_identity_link(h1, h2, 0.95, '["test"]'::jsonb), 'link created';
  assert public.guest_final_id(h2) = h1 and public.guest_final_id(h1) = h1, 'one final id for the linked group';
  for i in 1..4 loop
    assert public.guest_identity_link(h1, md5('x' || i) || md5('y' || i), 0.9, '[]'::jsonb), 'link ' || i;
  end loop;
  assert not public.guest_identity_link(h1, md5('x5') || md5('y5'), 0.9, '[]'::jsonb), 'sixth link refused';
  v_res := public.guest_unique_people('today');
  assert v_res->>'period' = 'today', 'unique people runs';
  v_res := public.guest_funnel_summary('today');
  assert v_res->>'period' = 'today', 'funnel runs';

  -- merge: one browser seen under two keys becomes one guest
  perform public.resolve_guest_browser(repeat('c',64), repeat('d',64));
  perform public.resolve_guest_browser(repeat('e',64), repeat('f',64));
  v_res := public.merge_guest_browser(repeat('c',64), repeat('e',64), repeat('d',64), repeat('f',64));
  assert v_res->>'reason' = 'merged', 'merged';
  assert not exists (select 1 from public.guest_visitors where fingerprint_hash = repeat('c',64)), 'duplicate guest removed';
  assert exists (select 1 from public.guest_visitors where fingerprint_hash = repeat('e',64)), 'canonical guest kept';

  -- claim: records the conversion, removes the anonymous analytics and the guest, and is a no-op the second time
  insert into auth.users (id, email, aud, role) values (v_uid, 'test-' || v_uid || '@example.invalid', 'authenticated', 'authenticated');
  insert into public.profiles (id, role) values (v_uid, 'customer') on conflict (id) do update set role = 'customer';
  perform public.resolve_guest_browser(v_fp, v_an);
  assert exists (select 1 from public.guest_visitors where fingerprint_hash = v_fp), 'guest exists before claim';
  assert exists (select 1 from public.guest_analytics_visits where visitor_hash = v_an), 'analytics row exists before claim';
  v_res := public.claim_guest_browser_cart(v_fp, v_an, v_uid);
  assert (v_res->>'claimed')::boolean, 'claimed';
  assert exists (select 1 from public.guest_conversions where visitor_hash = v_an and user_id = v_uid), 'conversion recorded';
  assert not exists (select 1 from public.guest_analytics_visits where visitor_hash = v_an), 'analytics removed';
  assert not exists (select 1 from public.guest_visitors where fingerprint_hash = v_fp), 'guest removed';
  v_res := public.claim_guest_browser_cart(v_fp, v_an, v_uid);
  assert not (v_res->>'claimed')::boolean, 'second claim is a no-op';
  assert (select count(*) from public.guest_conversions where visitor_hash = v_an) = 1, 'one conversion row';

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
