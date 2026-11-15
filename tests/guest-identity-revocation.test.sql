-- Run after guest_identity_revocation_barrier is applied, or together with that migration inside one rolled-back transaction.
-- Every key, account, event, and cart here is synthetic; no test data survives ROLLBACK.
begin;
do $$
declare
  v_fp text := md5(random()::text || clock_timestamp()::text) || md5(random()::text || clock_timestamp()::text);
  v_an text := md5(random()::text || clock_timestamp()::text) || md5(random()::text || clock_timestamp()::text);
  v_other_fp text := md5(random()::text || clock_timestamp()::text) || md5(random()::text || clock_timestamp()::text);
  v_other_an text := md5(random()::text || clock_timestamp()::text) || md5(random()::text || clock_timestamp()::text);
  v_link_an text := md5(random()::text || clock_timestamp()::text) || md5(random()::text || clock_timestamp()::text);
  v_product uuid;
  v_customer uuid := gen_random_uuid();
  v_session uuid := gen_random_uuid();
  v_profile jsonb;
  v_result jsonb;
  v_flag boolean;
  v_count integer;
begin
  select id into v_product from public.products limit 1;
  if v_product is null then
    insert into public.products default values returning id into v_product;
  end if;

  -- A synthetic guest exists first, just as a browser that has visited and saved its basket.
  v_profile := public.resolve_guest_browser(v_fp, v_an);
  assert coalesce((v_profile->>'blocked')::boolean, false) = false, 'an unused synthetic key is accepted';
  assert v_profile->>'visitorId' is not null, 'the first resolve creates a guest';
  assert exists (select 1 from public.guest_visitors where fingerprint_hash = v_fp and status = 'guest'), 'guest row exists before refusal';
  perform public.save_guest_browser_cart(v_fp, v_an, '[]'::jsonb);
  v_flag := public.record_guest_product_activity(v_fp, v_an, v_product, 'view');

  -- Refusal installs the HMAC-only tombstone and deletes the guest record in the same transaction.
  v_result := public.forget_guest_browser(v_fp, v_an);
  assert coalesce((v_result->>'forgotten')::boolean, false), 'the synthetic browser can be erased';
  assert exists (
    select 1 from private.guest_identity_blocks b
    where b.fingerprint_hash = v_fp and b.analytics_hash = v_an and b.reason = 'refused' and b.expires_at > now()
  ), 'a short-lived server-only tombstone remains after rows are erased';
  assert not exists (select 1 from public.guest_visitors where fingerprint_hash = v_fp), 'guest row and basket are deleted';

  -- Replay requests from another tab or an earlier in-flight call cannot recreate any part of that identity.
  v_profile := public.resolve_guest_browser(v_fp, v_an);
  assert coalesce((v_profile->>'blocked')::boolean, false), 'delayed resolve is blocked';
  v_profile := public.save_guest_browser_cart(v_fp, v_an, '[{"sid":"synthetic","q":1}]'::jsonb);
  assert coalesce((v_profile->>'blocked')::boolean, false), 'delayed cart save is blocked';
  assert public.record_guest_product_activity(v_fp, v_an, v_product, 'view') = false, 'delayed guest event is blocked';
  assert public.record_customer_session(v_fp, null, v_session, 'start') = false, 'delayed guest session is blocked';
  assert public.record_customer_product_event(v_fp, v_an, null, v_session, 'view', v_product, null, null, null) = false, 'delayed product event is blocked';
  assert public.record_customer_search(v_fp, v_an, null, v_session, 'synthetic delayed search', '[]'::jsonb) = false, 'delayed search is blocked';
  assert public.guest_signal_store(v_an, repeat('1', 32), '{}'::jsonb, null, null, null, null, null, 10, 10, 1) = false, 'delayed fingerprint signal is blocked';
  assert public.guest_identity_link(v_an, v_link_an, 0.9, '[]'::jsonb) = false, 'a refused identity cannot be linked';
  v_count := public.guest_identity_link_many(jsonb_build_array(jsonb_build_object('a', v_an, 'b', v_link_an, 'score', 0.9, 'reasons', '[]'::jsonb)));
  assert v_count = 0, 'the batch link path cannot bypass refusal';
  v_profile := public.guest_signal_behavior(v_fp);
  assert coalesce((v_profile->>'interactions')::integer, 0) = 0, 'refused activity is not returned to identification';
  assert not exists (select 1 from public.guest_visitors where fingerprint_hash = v_fp), 'replays did not resurrect a visitor';
  assert not exists (select 1 from public.guest_analytics_visits where visitor_hash = v_an), 'replays did not recreate visit counters';
  assert not exists (select 1 from public.guest_fingerprints where analytics_hash = v_an), 'replays did not recreate fingerprints';
  assert not exists (select 1 from public.guest_identity_links where hash_a = v_an or hash_b = v_an), 'replays did not recreate identity links';

  -- A merge cannot smuggle a refused key into an otherwise active browser identity.
  v_profile := public.resolve_guest_browser(v_other_fp, v_other_an);
  v_result := public.merge_guest_browser(v_fp, v_other_fp, v_an, v_other_an);
  assert coalesce((v_result->>'merged')::boolean, false) = false and v_result->>'reason' = 'blocked', 'a merge with a refused side is rejected';
  assert exists (select 1 from public.guest_visitors where fingerprint_hash = v_other_fp), 'the unrelated browser remains intact';

  -- A real account-shaped fixture confirms that the claim gate is also closed for a refused key.
  insert into auth.users (id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, email_confirmed_at, created_at, updated_at)
  values (v_customer, 'authenticated', 'authenticated', 'fixture-' || v_customer::text || '@example.invalid', '', '{}'::jsonb, '{"full_name":"revocation-fixture"}'::jsonb, now(), now(), now());
  assert exists (select 1 from public.profiles where id = v_customer and role = 'customer'), 'synthetic account profile exists';
  v_result := public.claim_guest_browser_cart(v_fp, v_an, v_customer);
  assert coalesce((v_result->>'blocked')::boolean, false) and coalesce((v_result->>'claimed')::boolean, true) = false, 'a refused identity is never claimed into an account';

  -- Neither browser roles nor service_role can inspect this short-lived HMAC table directly.
  assert not has_table_privilege('anon', 'private.guest_identity_blocks', 'select'), 'anon cannot inspect tombstones';
  assert not has_table_privilege('authenticated', 'private.guest_identity_blocks', 'select'), 'customers cannot inspect tombstones';
  assert not has_table_privilege('service_role', 'private.guest_identity_blocks', 'select'), 'the API role can only use gated RPCs';
  assert has_function_privilege('service_role', 'public.forget_guest_browser(text,text)', 'execute'), 'service_role retains the forget RPC';
  assert not has_function_privilege('anon', 'public.resolve_guest_browser(text,text)', 'execute'), 'anon cannot call the resolver directly';
end;
$$;
rollback;
