-- Real-database test for the guest/registered/total activity numbers and the clean-up when a guest registers.
-- Run AFTER supabase/migrations/20261017062830_customer_activity_totals_and_guest_cleanup_on_claim.sql, inside one
-- transaction. Everything is rolled back; no test data is left in Supabase. It creates a throw-away auth user and
-- fake hashes only, and uses one existing product for the events.
begin;

do $$
declare
  v_uid uuid := gen_random_uuid();
  v_prod uuid;
  v_res jsonb;
  v_fp text := repeat('a',64);
  v_an text := repeat('b',64);
  v_other text := repeat('9',64);
  fpa text := repeat('a',28);
  g0 bigint; c0 bigint; a0 bigint; g1 bigint; c1 bigint; a1 bigint;
  sg jsonb; sc jsonb; sa jsonb;
begin
  select id into v_prod from public.products order by id limit 1;
  if v_prod is null then raise notice 'no product in this database, skipping'; return; end if;

  insert into auth.users (id, email, aud, role) values (v_uid, 'test-' || v_uid || '@example.invalid', 'authenticated', 'authenticated');
  insert into public.profiles (id, role) values (v_uid, 'customer') on conflict (id) do update set role = 'customer';

  -- a guest with events, a stored fingerprint and an identity link
  perform public.resolve_guest_browser(v_fp, v_an);
  assert public.record_customer_product_event(v_fp, v_an, null, null, 'view', v_prod, null, null, null), 'guest view 1';
  assert public.record_customer_product_event(v_fp, v_an, null, null, 'view', v_prod, null, null, null), 'guest view 2';
  assert public.guest_signal_store(v_an, fpa, '{"gpu":"g","screen":"s"}'::jsonb, repeat('3',64), repeat('4',64), null, null, null, 5, 20, 2), 'fingerprint stored';
  assert public.guest_identity_link(v_an, v_other, 0.95, '["test"]'::jsonb), 'link stored';
  -- a registered customer with one view of the same product
  assert public.record_customer_product_event(null, null, v_uid, null, 'view', v_prod, null, null, null), 'customer view';

  -- 'all' is exactly guests + customers, for the ranking and for the summary
  select coalesce(sum((r->>'operations')::bigint),0) into g0 from jsonb_array_elements(public.customer_product_ranking('guest','today','view',100,0)->'records') r;
  select coalesce(sum((r->>'operations')::bigint),0) into c0 from jsonb_array_elements(public.customer_product_ranking('customer','today','view',100,0)->'records') r;
  select coalesce(sum((r->>'operations')::bigint),0) into a0 from jsonb_array_elements(public.customer_product_ranking('all','today','view',100,0)->'records') r;
  assert c0 = 1, 'one customer view counted';
  assert g0 >= 2, 'guest views counted';
  assert a0 = g0 + c0, 'total ranking = guests + customers';
  sg := public.customer_activity_summary('guest','today');
  sc := public.customer_activity_summary('customer','today');
  sa := public.customer_activity_summary('all','today');
  assert (sa->>'productViews')::bigint = (sg->>'productViews')::bigint + (sc->>'productViews')::bigint, 'summary views add up';
  assert (sa->>'people')::bigint = (sg->>'people')::bigint + (sc->>'people')::bigint, 'summary people add up';

  -- claim: events move to the account, the browser's identity disappears, the total does not change
  v_res := public.claim_guest_browser_cart(v_fp, v_an, v_uid);
  assert (v_res->>'claimed')::boolean, 'claimed';
  assert not exists (select 1 from public.guest_visitors where fingerprint_hash = v_fp), 'guest removed';
  assert not exists (select 1 from public.guest_analytics_visits where visitor_hash = v_an), 'visits removed';
  assert not exists (select 1 from public.guest_product_analytics where visitor_hash = v_an), 'anonymous analytics removed';
  assert not exists (select 1 from public.guest_fingerprints where analytics_hash = v_an), 'stored fingerprints removed';
  assert not exists (select 1 from public.guest_identity_links where hash_a = v_an or hash_b = v_an), 'identity links removed';
  assert not exists (select 1 from public.guest_conversions where visitor_hash = v_an), 'conversion record does not keep the browser hash';
  assert exists (select 1 from public.guest_conversions where user_id = v_uid), 'conversion recorded for the account';
  assert (select count(*) from public.customer_product_events where user_id = v_uid and event_type = 'view') = 3, 'the 2 guest views and the customer view belong to the account';
  select coalesce(sum((r->>'operations')::bigint),0) into g1 from jsonb_array_elements(public.customer_product_ranking('guest','today','view',100,0)->'records') r;
  select coalesce(sum((r->>'operations')::bigint),0) into c1 from jsonb_array_elements(public.customer_product_ranking('customer','today','view',100,0)->'records') r;
  select coalesce(sum((r->>'operations')::bigint),0) into a1 from jsonb_array_elements(public.customer_product_ranking('all','today','view',100,0)->'records') r;
  assert g1 = g0 - 2, 'guest ranking lost the two moved views';
  assert c1 = c0 + 2, 'customer ranking gained the two moved views';
  assert a1 = a0, 'the total is unchanged by registering';

  -- merge: the duplicate browser's stored fingerprint goes with it
  perform public.resolve_guest_browser(repeat('c',64), repeat('d',64));
  perform public.resolve_guest_browser(repeat('e',64), repeat('f',64));
  assert public.guest_signal_store(repeat('d',64), fpa, '{"gpu":"g2","screen":"s2"}'::jsonb, null, null, null, null, null, 1, 1, 1), 'duplicate fingerprint stored';
  v_res := public.merge_guest_browser(repeat('c',64), repeat('e',64), repeat('d',64), repeat('f',64));
  assert v_res->>'reason' = 'merged', 'merged';
  assert not exists (select 1 from public.guest_fingerprints where analytics_hash = repeat('d',64)), 'duplicate fingerprint removed';

  -- invalid scopes are still rejected, and only the server can call these
  begin perform public.customer_product_ranking('everyone','today','view',20,0); assert false, 'invalid actor must fail'; exception when raise_exception then null; end;
  assert not has_function_privilege('authenticated', 'public.customer_product_ranking(text,text,text,integer,integer)', 'EXECUTE'), 'authenticated cannot rank';
  assert not has_function_privilege('authenticated', 'public.claim_guest_browser_cart(text,text,uuid)', 'EXECUTE'), 'authenticated cannot claim';
  assert has_function_privilege('service_role', 'public.customer_activity_summary(text,text)', 'EXECUTE'), 'the server can summarise';

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
