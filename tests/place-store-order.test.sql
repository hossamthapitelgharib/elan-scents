-- Real-database test for supabase/migrations/<version>_server_confirmed_orders.sql
-- Run AFTER the migration, as the project owner, inside one transaction. Everything is rolled back.
-- The users below are synthetic (no real customer); the catalog and the stores are only read, and the few catalog rows
-- that are changed (stock and availability, to make the test independent of today's stock) are changed inside the
-- transaction and rolled back with it.
begin;

do $$
declare
  v_uid constant uuid := 'b0000000-0000-4000-8000-0000000000c1';
  v_uid2 constant uuid := 'b0000000-0000-4000-8000-0000000000c2';
  v_store_a uuid;
  v_store_b uuid;
  a1 public.store_products;
  a2 public.store_products;
  b1 public.store_products;
  v_customer jsonb := '{"name":"Test Customer","phone":"+201000000000","email":"t@example.invalid","address":"Test street 1","notes":"call first"}'::jsonb;
  v_res jsonb;
  v_res2 jsonb;
  v_n integer;
  v_text text;
  v_msg text;
  v_ok boolean;
begin
  -- Two active stores with products to order from.
  select sp.store_id into v_store_a
  from public.store_products sp join public.stores s on s.id = sp.store_id
  where s.status = 'active' group by sp.store_id having count(*) >= 2 order by sp.store_id limit 1;
  select sp.store_id into v_store_b
  from public.store_products sp join public.stores s on s.id = sp.store_id
  where s.status = 'active' and sp.store_id <> v_store_a group by sp.store_id order by sp.store_id limit 1;
  assert v_store_a is not null and v_store_b is not null, 'two active stores with products exist to test with';

  select * into a1 from public.store_products where store_id = v_store_a order by id limit 1;
  select * into a2 from public.store_products where store_id = v_store_a and id <> a1.id order by id limit 1;
  select * into b1 from public.store_products where store_id = v_store_b order by id limit 1;
  update public.store_products set is_available = true, stock_quantity = 50 where id in (a1.id, a2.id, b1.id);
  select * into a1 from public.store_products where id = a1.id;
  select * into a2 from public.store_products where id = a2.id;
  select * into b1 from public.store_products where id = b1.id;

  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (v_uid, 'authenticated', 'authenticated', 'place-order-1@example.invalid', '{"full_name":"Order One"}'::jsonb),
         (v_uid2, 'authenticated', 'authenticated', 'place-order-2@example.invalid', '{"full_name":"Order Two"}'::jsonb);

  -- 1. Who may call what.
  assert not has_function_privilege('anon', 'public.place_store_order(jsonb)', 'execute'), 'anon cannot place an order';
  assert has_function_privilege('authenticated', 'public.place_store_order(jsonb)', 'execute'), 'signed-in users can place an order';
  assert not has_function_privilege('authenticated', 'private.new_tracking_number()', 'execute'), 'the number maker is not callable by clients';
  begin
    perform public.place_store_order(jsonb_build_object('storeId', v_store_a, 'customer', v_customer, 'items', '[]'::jsonb));
    raise exception 'an anonymous call must be refused';
  exception when raise_exception then
    if sqlerrm = 'an anonymous call must be refused' then raise; end if;
    assert sqlerrm = 'Authentication required', 'the anonymous refusal says so: ' || sqlerrm;
  end;

  -- 2. The number maker: right shape, practically never repeats.
  select count(*) into v_n from (select private.new_tracking_number() t from generate_series(1, 200)) s;
  assert v_n = 200, 'two hundred numbers made';
  select count(distinct t) into v_n from (select private.new_tracking_number() t from generate_series(1, 200)) s;
  assert v_n >= 190, 'the numbers are random, not a counter that repeats';
  assert not exists (select 1 from (select private.new_tracking_number() t from generate_series(1, 200)) s where t !~ '^ELN-[0-9]{8}-[0-9]{6}$'),
    'every number looks like ELN-YYYYMMDD-NNNNNN';

  -- The saved cart before ordering: two lines of store A (one stale, not displayed any more) and one of store B.
  insert into public.cart_items (user_id, store_product_id, quantity) values (v_uid, a1.id, 5), (v_uid, a2.id, 1), (v_uid, b1.id, 2);

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 3. A good order: the number is the server's, the order is what was displayed, the cart is cleared for that store only.
  v_res := public.place_store_order(jsonb_build_object(
    'storeId', v_store_a, 'trackingNumber', 'CLIENT-CHOSEN-1', 'idempotencyKey', 'retry-key-0001', 'customer', v_customer,
    'subtotal', round(a1.price * 2, 2),
    'items', jsonb_build_array(jsonb_build_object('storeProductId', a1.id, 'productSizeId', a1.product_size_id, 'quantity', 2, 'unitPrice', a1.price))));
  reset role;
  assert v_res->>'trackingNumber' ~ '^ELN-[0-9]{8}-[0-9]{6}$', 'the tracking number is made by the server in the usual shape';
  assert v_res->>'trackingNumber' <> 'CLIENT-CHOSEN-1', 'a number chosen by the client is ignored';
  assert v_res->>'status' = 'awaiting_store_confirmation', 'the order waits for the store';
  assert (v_res->>'duplicate') is null, 'a first call is not a duplicate';
  assert (v_res->>'subtotal')::numeric = round(a1.price * 2, 2), 'the subtotal is returned';
  select count(*) into v_n from public.store_order_requests where user_id = v_uid and store_id = v_store_a and tracking_number = v_res->>'trackingNumber'
    and subtotal = round(a1.price * 2, 2) and checkout_session_id is not null and checkout_tracking_number = v_res->>'trackingNumber';
  assert v_n = 1, 'one order request exists with the server number, the total and a linked checkout session';
  select count(*) into v_n from public.checkout_sessions where user_id = v_uid and tracking_number = v_res->>'trackingNumber' and subtotal = round(a1.price * 2, 2);
  assert v_n = 1, 'one checkout session carries the same number';
  select count(*) into v_n from public.store_order_request_items i join public.store_order_requests r on r.id = i.request_id
    where r.id = (v_res->>'id')::uuid and i.product_size_id = a1.product_size_id and i.quantity = 2 and i.unit_price = a1.price;
  assert v_n = 1, 'the order holds the displayed line';
  select count(*) into v_n from public.store_order_request_items where request_id = (v_res->>'id')::uuid;
  assert v_n = 1, 'the stale cart line that was not displayed is not in the order';
  select count(*) into v_n from public.cart_items ci join public.store_products sp on sp.id = ci.store_product_id where ci.user_id = v_uid and sp.store_id = v_store_a;
  assert v_n = 0, 'the ordered store''s cart rows are gone';
  select count(*) into v_n from public.cart_items where user_id = v_uid and store_product_id = b1.id and quantity = 2;
  assert v_n = 1, 'the other store''s cart row is untouched';

  -- 4. A retry with the same key (the answer was lost) returns the same order and creates nothing.
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res2 := public.place_store_order(jsonb_build_object(
    'storeId', v_store_a, 'idempotencyKey', 'retry-key-0001', 'customer', v_customer,
    'items', jsonb_build_array(jsonb_build_object('storeProductId', a2.id, 'productSizeId', a2.product_size_id, 'quantity', 1, 'unitPrice', a2.price))));
  reset role;
  assert (v_res2->>'duplicate')::boolean, 'the repeated call is marked as a duplicate';
  assert v_res2->>'id' = v_res->>'id' and v_res2->>'trackingNumber' = v_res->>'trackingNumber', 'the same order comes back';
  select count(*) into v_n from public.store_order_requests where user_id = v_uid;
  assert v_n = 1, 'no second order was made';
  select count(*) into v_n from public.checkout_sessions where user_id = v_uid;
  assert v_n = 1, 'no second checkout session was made';
  select count(*) into v_n from public.cart_items ci join public.store_products sp on sp.id = ci.store_product_id where ci.user_id = v_uid and sp.store_id = v_store_a;
  assert v_n = 0, 'the retry did not bring cart rows back';

  -- 5. Refusals leave nothing behind, not even the cart change (the stale row is still there afterwards).
  insert into public.cart_items (user_id, store_product_id, quantity) values (v_uid, a2.id, 1);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  for v_text, v_msg in
    select * from (values
      ('price', 'Price changed%'),
      ('subtotal', 'Subtotal mismatch'),
      ('customer', 'Customer details are required'),
      ('other_store', 'Product is not offered by this store'),
      ('qty_100', 'Invalid order item'),
      ('duplicate_line', 'Invalid order item'),
      ('bad_id', 'Invalid order item'),
      ('wrong_size', 'Invalid order item'),
      ('empty', 'Order items are required'),
      ('stock', 'Product is unavailable or has insufficient stock'),
      ('bad_store', 'Invalid or inactive store'),
      ('long_name', 'Customer details are too long'),
      ('short_key', 'Invalid retry key')
    ) t(k, m)
  loop
    v_ok := false;
    begin
      perform public.place_store_order(case v_text
        when 'price' then jsonb_build_object('storeId', v_store_a, 'customer', v_customer,
          'items', jsonb_build_array(jsonb_build_object('storeProductId', a2.id, 'quantity', 1, 'unitPrice', a2.price + 1)))
        when 'subtotal' then jsonb_build_object('storeId', v_store_a, 'customer', v_customer, 'subtotal', a2.price + 5,
          'items', jsonb_build_array(jsonb_build_object('storeProductId', a2.id, 'quantity', 1, 'unitPrice', a2.price)))
        when 'customer' then jsonb_build_object('storeId', v_store_a, 'customer', '{"name":"X","phone":"1","address":""}'::jsonb,
          'items', jsonb_build_array(jsonb_build_object('storeProductId', a2.id, 'quantity', 1, 'unitPrice', a2.price)))
        when 'other_store' then jsonb_build_object('storeId', v_store_a, 'customer', v_customer,
          'items', jsonb_build_array(jsonb_build_object('storeProductId', b1.id, 'quantity', 1, 'unitPrice', b1.price)))
        when 'qty_100' then jsonb_build_object('storeId', v_store_a, 'customer', v_customer,
          'items', jsonb_build_array(jsonb_build_object('storeProductId', a2.id, 'quantity', 100, 'unitPrice', a2.price)))
        when 'duplicate_line' then jsonb_build_object('storeId', v_store_a, 'customer', v_customer,
          'items', jsonb_build_array(jsonb_build_object('storeProductId', a2.id, 'quantity', 1, 'unitPrice', a2.price),
                                     jsonb_build_object('storeProductId', a2.id, 'quantity', 1, 'unitPrice', a2.price)))
        when 'bad_id' then jsonb_build_object('storeId', v_store_a, 'customer', v_customer,
          'items', jsonb_build_array(jsonb_build_object('storeProductId', 'not-a-uuid', 'quantity', 1, 'unitPrice', 1)))
        when 'wrong_size' then jsonb_build_object('storeId', v_store_a, 'customer', v_customer,
          'items', jsonb_build_array(jsonb_build_object('storeProductId', a2.id, 'productSizeId', a1.product_size_id, 'quantity', 1, 'unitPrice', a2.price)))
        when 'empty' then jsonb_build_object('storeId', v_store_a, 'customer', v_customer, 'items', '[]'::jsonb)
        when 'stock' then jsonb_build_object('storeId', v_store_a, 'customer', v_customer,
          'items', jsonb_build_array(jsonb_build_object('storeProductId', a2.id, 'quantity', 51, 'unitPrice', a2.price)))
        when 'bad_store' then jsonb_build_object('storeId', gen_random_uuid(), 'customer', v_customer,
          'items', jsonb_build_array(jsonb_build_object('storeProductId', a2.id, 'quantity', 1, 'unitPrice', a2.price)))
        when 'long_name' then jsonb_build_object('storeId', v_store_a, 'customer', jsonb_build_object('name', repeat('n', 121), 'phone', '1', 'address', 'a'),
          'items', jsonb_build_array(jsonb_build_object('storeProductId', a2.id, 'quantity', 1, 'unitPrice', a2.price)))
        when 'short_key' then jsonb_build_object('storeId', v_store_a, 'customer', v_customer, 'idempotencyKey', 'abc',
          'items', jsonb_build_array(jsonb_build_object('storeProductId', a2.id, 'quantity', 1, 'unitPrice', a2.price)))
      end);
    exception when raise_exception then
      v_ok := sqlerrm like v_msg;
      assert v_ok, format('refusal "%s" said "%s", expected "%s"', v_text, sqlerrm, v_msg);
    end;
    assert v_ok, format('"%s" must be refused', v_text);
  end loop;
  reset role;
  select count(*) into v_n from public.store_order_requests where user_id = v_uid;
  assert v_n = 1, 'no refused call created an order';
  select count(*) into v_n from public.checkout_sessions where user_id = v_uid;
  assert v_n = 1, 'no refused call left a checkout session behind';
  select count(*) into v_n from public.cart_items where user_id = v_uid and store_product_id = a2.id and quantity = 1;
  assert v_n = 1, 'no refused call changed the cart';

  -- 6. A second order without a key gets its own number.
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res2 := public.place_store_order(jsonb_build_object(
    'storeId', v_store_a, 'customer', v_customer,
    'items', jsonb_build_array(jsonb_build_object('storeProductId', a2.id, 'productSizeId', a2.product_size_id, 'quantity', 3, 'unitPrice', a2.price))));
  reset role;
  assert v_res2->>'trackingNumber' <> v_res->>'trackingNumber', 'each order has its own number';
  assert (v_res2->>'duplicate') is null, 'a call without a key is never a duplicate';
  select count(*) into v_n from public.store_order_requests where user_id = v_uid;
  assert v_n = 2, 'two orders now';

  -- 7. Retry keys belong to their customer: another customer using the same key makes their own order.
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res2 := public.place_store_order(jsonb_build_object(
    'storeId', v_store_b, 'idempotencyKey', 'retry-key-0001', 'customer', v_customer,
    'items', jsonb_build_array(jsonb_build_object('storeProductId', b1.id, 'productSizeId', b1.product_size_id, 'quantity', 1, 'unitPrice', b1.price))));
  reset role;
  assert (v_res2->>'duplicate') is null and v_res2->>'id' <> v_res->>'id', 'the key of another customer does not return their order';
  select count(*) into v_n from public.store_order_requests where user_id = v_uid2;
  assert v_n = 1, 'the second customer has their own order';

  -- 8. The keys table is closed to clients.
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform count(*) from private.store_order_idempotency;
    raise exception 'clients must not read the retry keys';
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- 9. A customer cannot flood a store: after 20 orders in an hour the next one is refused.
  insert into public.store_order_requests (tracking_number, store_id, user_id, customer_name, customer_phone, customer_address, subtotal, currency)
  select 'ELN-TEST-FLOOD-' || g, v_store_b, v_uid2, 'n', '1', 'a', 1, 'EGP' from generate_series(1, 19) g;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.place_store_order(jsonb_build_object(
      'storeId', v_store_b, 'customer', v_customer,
      'items', jsonb_build_array(jsonb_build_object('storeProductId', b1.id, 'quantity', 1, 'unitPrice', b1.price))));
    raise exception 'the 21st order in an hour must be refused';
  exception when raise_exception then
    if sqlerrm = 'the 21st order in an hour must be refused' then raise; end if;
    assert sqlerrm like 'Too many orders%', 'the flood refusal says so: ' || sqlerrm;
  end;
  reset role;

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
