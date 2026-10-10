-- Real-database test for supabase/pending/20261010030000_harden_anon_grants_rls_initplan_and_order_pricing.sql
-- Run AFTER the migration inside one transaction. Everything is rolled back; no test data is left in Supabase.
-- Note: anon reads the catalog through column-level SELECT grants, so privileges are checked with has_any_column_privilege.
-- Uses an existing auth user and an existing purchasable store product; creates no real customer data.
begin;

do $$
declare
  v_uid uuid;
  v_sp public.store_products;
  v_payload jsonb;
  v_res jsonb;
  v_own_session uuid;
  v_foreign_session uuid;
  v_total numeric;
begin
  -- privileges ---------------------------------------------------------------------------------
  assert not has_any_column_privilege('anon', 'public.orders', 'INSERT'), 'anon must not insert orders';
  assert not has_any_column_privilege('anon', 'public.profiles', 'UPDATE'), 'anon must not update profiles';
  assert not has_table_privilege('anon', 'public.store_products', 'DELETE'), 'anon must not delete store_products';
  assert not has_any_column_privilege('anon', 'public.store_products', 'UPDATE'), 'anon must not update store_products';
  assert has_any_column_privilege('anon', 'public.analytics_events', 'INSERT'), 'anon keeps the intentional analytics insert';
  assert has_any_column_privilege('anon', 'public.brands', 'SELECT'), 'anon keeps public reads (column-level grants)';
  assert has_any_column_privilege('anon', 'public.store_products', 'SELECT'), 'anon keeps catalog reads';
  assert has_table_privilege('anon', 'public.public_products', 'SELECT'), 'anon keeps the public views';
  assert not has_table_privilege('authenticated', 'public.orders', 'TRUNCATE'), 'authenticated must not truncate';
  assert has_any_column_privilege('authenticated', 'public.cart_items', 'INSERT'), 'signed-in cart sync keeps working';
  assert not has_function_privilege('anon', 'public.create_store_order_request(jsonb)', 'EXECUTE'), 'anon must not create orders';
  assert has_function_privilege('authenticated', 'public.create_store_order_request(jsonb)', 'EXECUTE'), 'signed-in users create orders';

  -- policies: auth.uid() must be wrapped in a sub-select ------------------------------------------
  assert (select count(*) from pg_policies where schemaname = 'public' and policyname in (
      'checkout_sessions_owner_read', 'notifications_realtime_user_read', 'notifications_realtime_store_read',
      'store_order_cart_restorations_owner_read', 'store_order_notifications_owner_read',
      'store_order_request_items_owner_read', 'store_order_requests_owner_read')) = 7, 'all 7 policies still exist';
  assert (select count(*) from pg_policies where schemaname = 'public' and policyname in (
      'checkout_sessions_owner_read', 'notifications_realtime_user_read', 'notifications_realtime_store_read',
      'store_order_cart_restorations_owner_read', 'store_order_notifications_owner_read',
      'store_order_request_items_owner_read', 'store_order_requests_owner_read')
      and qual !~* 'select auth\.uid\(\)') = 0, 'auth.uid() is evaluated once per statement';

  -- ordering ------------------------------------------------------------------------------------
  select id into v_uid from auth.users order by created_at limit 1;
  select sp.* into v_sp
    from public.store_products sp join public.stores s on s.id = sp.store_id and s.status = 'active'
    where sp.is_available and (sp.stock_quantity is null or sp.stock_quantity >= 2)
    order by sp.created_at limit 1;
  if v_uid is null or v_sp.id is null then
    raise notice 'SKIPPED order checks: needs one auth user and one purchasable store product';
    return;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_total := round(v_sp.price * 2, 2);
  v_payload := jsonb_build_object(
    'trackingNumber', 'TEST-' || gen_random_uuid(), 'storeId', v_sp.store_id, 'currency', v_sp.currency, 'subtotal', v_total,
    'customer', jsonb_build_object('name', 'Test', 'phone', '0', 'address', 'Test'),
    'items', jsonb_build_array(jsonb_build_object('productSizeId', v_sp.product_size_id, 'storeProductId', v_sp.id,
      'name', 'Test item', 'brand', 'Test', 'size', '50ml', 'quantity', 2, 'unitPrice', v_sp.price, 'total', v_total)));

  -- an unauthenticated call is rejected (keeps the live "Authentication required" guard)
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.create_store_order_request(v_payload);
    raise exception 'TEST FAILED: unauthenticated order accepted';
  exception when others then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    assert sqlerrm = 'Authentication required', 'unexpected error: ' || sqlerrm;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  -- a valid order is accepted and stores the database values
  v_res := public.create_store_order_request(v_payload);
  assert v_res->>'status' = 'awaiting_store_confirmation', 'valid order accepted';
  assert (select subtotal from public.store_order_requests where id = (v_res->>'id')::uuid) = v_total, 'subtotal stored from the database';
  assert (select unit_price from public.store_order_request_items where request_id = (v_res->>'id')::uuid) = v_sp.price, 'unit price stored from the database';

  -- a tampered unit price is rejected
  begin
    perform public.create_store_order_request(jsonb_set(v_payload, '{items,0,unitPrice}', to_jsonb(v_sp.price - 1)));
    raise exception 'TEST FAILED: tampered price accepted';
  exception when others then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    assert sqlerrm like 'Price changed%', 'unexpected error: ' || sqlerrm;
  end;

  -- a tampered line total is rejected
  begin
    perform public.create_store_order_request(jsonb_set(v_payload, '{items,0,total}', to_jsonb(1)));
    raise exception 'TEST FAILED: tampered total accepted';
  exception when others then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    assert sqlerrm like 'Line total mismatch%', 'unexpected error: ' || sqlerrm;
  end;

  -- a tampered subtotal is rejected
  begin
    perform public.create_store_order_request(jsonb_set(v_payload, '{subtotal}', to_jsonb(1)));
    raise exception 'TEST FAILED: tampered subtotal accepted';
  exception when others then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    assert sqlerrm = 'Subtotal mismatch', 'unexpected error: ' || sqlerrm;
  end;

  -- more units than the stock is rejected
  if v_sp.stock_quantity is not null then
    begin
      perform public.create_store_order_request(jsonb_set(v_payload, '{items,0,quantity}', to_jsonb(v_sp.stock_quantity + 1)));
      raise exception 'TEST FAILED: over-stock order accepted';
    exception when others then
      if sqlerrm like 'TEST FAILED%' then raise; end if;
      assert sqlerrm like 'Product is unavailable%', 'unexpected error: ' || sqlerrm;
    end;
  end if;

  -- a checkout session of someone else is rejected, the caller's own session is accepted
  insert into public.checkout_sessions (tracking_number, user_id, customer_name, customer_phone, customer_address)
    values ('TEST-FOREIGN-' || gen_random_uuid(), null, 'Test', '0', 'Test') returning id into v_foreign_session;
  insert into public.checkout_sessions (tracking_number, user_id, customer_name, customer_phone, customer_address)
    values ('TEST-OWN-' || gen_random_uuid(), v_uid, 'Test', '0', 'Test') returning id into v_own_session;
  begin
    perform public.create_store_order_request(jsonb_set(v_payload || jsonb_build_object('trackingNumber', 'TEST-' || gen_random_uuid()), '{checkoutSessionId}', to_jsonb(v_foreign_session::text)));
    raise exception 'TEST FAILED: foreign checkout session accepted';
  exception when others then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    assert sqlerrm = 'Checkout session not found', 'unexpected error: ' || sqlerrm;
  end;
  v_res := public.create_store_order_request(jsonb_set(v_payload || jsonb_build_object('trackingNumber', 'TEST-' || gen_random_uuid()), '{checkoutSessionId}', to_jsonb(v_own_session::text)));
  assert (v_res->>'checkoutSessionId')::uuid = v_own_session, 'own checkout session accepted';

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
