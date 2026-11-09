-- Real-database test for supabase/migrations/<version>_phase1_purchase_core.sql (docs/implementation-phase-1-purchase-core.ar.md).
-- Run AFTER the migration, as the project owner, inside one transaction. Everything is rolled back.
-- The users below are synthetic (no real customer); the catalog and the stores are only read, and the few catalog rows
-- that are changed (stock, availability, a price and a name, to prove the order does not follow them) are changed inside the
-- transaction and rolled back with it.
-- The server reaches the order function through public.place_store_order_server(payload, user_id) (service_role only).
begin;

do $$
declare
  v_u1 constant uuid := 'b0000000-0000-4000-8000-0000000000c1';
  v_u2 constant uuid := 'b0000000-0000-4000-8000-0000000000c2';
  v_u3 constant uuid := 'b0000000-0000-4000-8000-0000000000c3';
  v_store_a uuid;
  v_store_b uuid;
  a1 public.store_products;
  a2 public.store_products;
  b1 public.store_products;
  v_res jsonb;
  v_res2 jsonb;
  v_res3 jsonb;
  v_resb jsonb;
  v_req public.store_order_requests;
  v_n integer;
  v_text text;
  v_msg text;
  v_ok boolean;
  v_expected numeric;
  v_item public.store_order_request_items;
begin
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
  update public.store_products set is_available = true, stock_quantity = 50, price = 120.00 where id = a1.id;
  update public.store_products set is_available = true, stock_quantity = 50, price = 80.50 where id = a2.id;
  update public.store_products set is_available = true, stock_quantity = 50, price = 200.00 where id = b1.id;
  select * into a1 from public.store_products where id = a1.id;
  select * into a2 from public.store_products where id = a2.id;
  select * into b1 from public.store_products where id = b1.id;

  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (v_u1, 'authenticated', 'authenticated', 'phase1-1@example.invalid', '{"full_name":"Order One"}'::jsonb),
         (v_u2, 'authenticated', 'authenticated', 'phase1-2@example.invalid', '{"full_name":"Order Two"}'::jsonb),
         (v_u3, 'authenticated', 'authenticated', 'phase1-3@example.invalid', '{"full_name":"Order Three"}'::jsonb);
  -- u1: a complete account, shipping to the same address. u3: a recipient and a different shipping address. u2: no account details at all.
  -- u1's city repeats the governorate (it is written once); u3's shipping address has all its parts.
  insert into public.customer_details (user_id, full_name, phone, governorate, city, address, building_no, floor_no, apartment_no, address_lat, address_lng, ship_same, delivery_notes)
  values (v_u1, 'احمد محمد علي حسن', '01012345678', 'القاهرة', 'القاهرة', 'شارع التحرير', '5', '3', '12', 30.0444, 31.2357, true, 'اتصل قبل الوصول');
  insert into public.customer_details (user_id, full_name, phone, governorate, address, ship_same, ship_governorate, ship_city, ship_address, ship_building_no, ship_floor_no, ship_apartment_no, recipient_name, recipient_phone)
  values (v_u3, 'منى سمير فتحي عبد', '01112345678', 'الجيزة', 'شارع الهرم 10', false, 'الإسكندرية', 'سموحة', 'شارع البحر 7', '12', '4', '9', 'سارة عبد الله', '01212345678');

  -- 1. Who may call what: only the server.
  assert not has_function_privilege('anon', 'public.place_store_order(jsonb)', 'execute'), 'anon cannot place an order';
  assert not has_function_privilege('authenticated', 'public.place_store_order(jsonb)', 'execute'), 'a browser token cannot place an order directly';
  assert has_function_privilege('service_role', 'public.place_store_order_server(jsonb, uuid)', 'execute'), 'the server can place an order for a verified user';
  assert not has_function_privilege('authenticated', 'private.new_tracking_number()', 'execute'), 'the number maker is not callable by clients';
  begin
    perform public.place_store_order(jsonb_build_object('storeId', v_store_a, 'idempotencyKey', 'anon-key-0001'));
    raise exception 'an anonymous call must be refused';
  exception when raise_exception then
    if sqlerrm = 'an anonymous call must be refused' then raise; end if;
    assert sqlerrm = 'Authentication required', 'the anonymous refusal says so: ' || sqlerrm;
  end;

  -- 2. The old paths are closed: the cart-clearing creator and the customer's own confirmation.
  begin
    perform public.create_store_order_request_from_cart(jsonb_build_object('storeId', v_store_a));
    raise exception 'the old cart-clearing creator must be refused';
  exception when raise_exception then
    if sqlerrm = 'the old cart-clearing creator must be refused' then raise; end if;
    assert sqlerrm like 'Retired:%', 'the old creator says it is retired: ' || sqlerrm;
  end;

  -- 3. A customer with no account details cannot order; the answer names the reason. An empty cart is refused too.
  insert into public.cart_items (user_id, store_product_id, quantity) values (v_u2, a1.id, 1);
  begin
    perform public.place_store_order_server(jsonb_build_object('storeId', v_store_a, 'idempotencyKey', 'phase1-key-u2-1'), v_u2);
    raise exception 'an incomplete account must be refused';
  exception when raise_exception then
    if sqlerrm = 'an incomplete account must be refused' then raise; end if;
    assert sqlerrm = 'Account details are incomplete', 'incomplete account refusal: ' || sqlerrm;
  end;
  begin
    perform public.place_store_order_server(jsonb_build_object('storeId', v_store_a, 'idempotencyKey', 'phase1-key-u1-0'), v_u1);
    raise exception 'an empty cart must be refused';
  exception when raise_exception then
    if sqlerrm = 'an empty cart must be refused' then raise; end if;
    assert sqlerrm = 'Cart is empty for this store', 'empty cart refusal: ' || sqlerrm;
  end;

  -- 4. A good order. The saved cart: two lines of store A and one of store B. The payload lies about everything it can.
  insert into public.cart_items (user_id, store_product_id, quantity) values (v_u1, a1.id, 2), (v_u1, a2.id, 1), (v_u1, b1.id, 2);
  v_expected := round(a1.price * 2, 2) + round(a2.price * 1, 2);
  v_res := public.place_store_order_server(jsonb_build_object(
    'storeId', v_store_a, 'idempotencyKey', 'phase1-key-0001', 'trackingNumber', 'CLIENT-CHOSEN-1', 'currency', 'USD',
    'expectedSubtotal', v_expected, 'subtotal', 0.01, 'total', 0.01,
    'customer', jsonb_build_object('name', 'Forged Name', 'phone', '1', 'address', 'Forged address', 'email', 'forged@example.invalid'),
    'items', jsonb_build_array(jsonb_build_object('storeProductId', b1.id, 'productSizeId', b1.product_size_id, 'quantity', 99, 'unitPrice', 0.01))), v_u1);
  assert v_res->>'trackingNumber' ~ '^ELN-[0-9]{8}-[0-9]{6}$', 'the tracking number is made by the server';
  assert v_res->>'trackingNumber' <> 'CLIENT-CHOSEN-1', 'a number chosen by the client is ignored';
  assert v_res->>'status' = 'awaiting_store_confirmation', 'the order waits for the store';
  assert v_res->>'currency' = 'EGP', 'a currency sent by the client is ignored: EGP';
  assert (v_res->>'subtotal')::numeric = v_expected, 'the subtotal is the catalog price times the saved cart, not the number in the payload';
  assert (v_res->>'duplicate')::boolean is false, 'a first call is not a duplicate';
  assert (v_res->>'cartCleared')::boolean is false, 'the answer says the cart was not cleared';
  assert v_res->>'id' = v_res->>'elanOrderId', 'the Élan order id is the order id';
  assert v_res->>'merchantOrderNumber' is null and v_res->>'merchantInvoiceNumber' is null, 'no merchant number exists at creation';
  select * into v_req from public.store_order_requests where id = (v_res->>'id')::uuid;
  assert v_req.user_id = v_u1 and v_req.store_id = v_store_a, 'the order is the customer''s, for store A';
  assert v_req.subtotal = v_expected and v_req.currency = 'EGP', 'stored with the trusted total and EGP';
  assert v_req.customer_name = 'احمد محمد علي حسن' and v_req.customer_phone = '01012345678' and v_req.customer_email = 'phase1-1@example.invalid',
    'the customer data is the account''s, not the payload''s';
  assert v_req.customer_address = E'القاهرة، شارع التحرير، مبنى 5، الدور 3، شقة 12\nhttps://www.google.com/maps?q=30.0444,31.2357',
    'the courier line is governorate, city (once), street, building, floor, flat and the map point, composed like the page';
  assert v_req.customer_snapshot#>>'{shipping,city}' = 'القاهرة' and v_req.customer_snapshot#>>'{shipping,building}' = '5'
    and v_req.customer_snapshot#>>'{shipping,floor}' = '3' and v_req.customer_snapshot#>>'{shipping,apartment}' = '12'
    and v_req.customer_snapshot#>>'{shipping,addressLine}' = 'القاهرة، شارع التحرير، مبنى 5، الدور 3، شقة 12',
    'the snapshot keeps the address parts and the composed line';
  assert v_req.customer_notes = 'اتصل قبل الوصول', 'the delivery notes come from the account';
  assert v_req.merchant_order_number is null and v_req.merchant_invoice_number is null, 'merchant numbers are empty on the stored order';
  assert v_req.customer_snapshot->>'source' = 'customer_details' and v_req.customer_snapshot#>>'{buyer,name}' = 'احمد محمد علي حسن'
    and v_req.customer_snapshot#>>'{shipping,governorate}' = 'القاهرة' and v_req.customer_snapshot#>>'{delivery,phone}' = '01012345678',
    'the customer snapshot holds the buyer, the shipping address and what the merchant receives';
  select count(*) into v_n from public.store_order_request_items where request_id = v_req.id;
  assert v_n = 2, 'only store A''s two lines are in the order (store B''s line is not)';
  select count(*) into v_n from public.store_order_request_items i
  where i.request_id = v_req.id and i.store_product_id = b1.id;
  assert v_n = 0, 'nothing of store B in the store A order';
  select count(*) into v_n from public.store_order_request_items where request_id = v_req.id and platform_order_number like v_req.tracking_number || '-%';
  assert v_n = 2, 'every line carries a platform number built on the tracking number';
  select * into v_item from public.store_order_request_items where request_id = v_req.id and store_product_id = a1.id;
  assert v_item.quantity = 2 and v_item.unit_price = a1.price and v_item.line_total = round(a1.price * 2, 2) and v_item.currency = 'EGP',
    'the line keeps the original quantity, the price at purchase and the line total';
  assert v_item.product_snapshot->>'name' is not null and v_item.product_snapshot->>'sizeId' = a1.product_size_id::text
    and v_item.product_snapshot->>'storeProductId' = a1.id::text, 'the line holds a snapshot of the product as sold';
  select count(*) into v_n from public.checkout_sessions where user_id = v_u1 and tracking_number = v_req.tracking_number and currency = 'EGP' and subtotal = v_expected;
  assert v_n = 1, 'one checkout session carries the same number, in EGP';
  select count(*) into v_n from public.cart_items where user_id = v_u1;
  assert v_n = 3, 'the cart is not cleared at creation: all three lines are still saved';
  select count(*) into v_n from public.notifications where request_id = v_req.id and type = 'order_initial' and body like '%Élan Scents%' and body like '%' || v_req.tracking_number || '%';
  assert v_n >= 1, 'the notice says it is an Élan Scents order and carries the tracking number';

  -- 5. A wrong guard is refused, a missing or short key is refused, a key cannot be reused for another store.
  for v_text, v_msg in
    select * from (values
      ('guard', 'Subtotal mismatch'),
      ('bad_guard', 'Subtotal mismatch'),
      ('no_key', 'Invalid retry key'),
      ('short_key', 'Invalid retry key'),
      ('bad_store', 'Invalid or inactive store'),
      ('other_store_key', 'Invalid retry key')
    ) t(k, m)
  loop
    v_ok := false;
    begin
      perform public.place_store_order_server(case v_text
        when 'guard' then jsonb_build_object('storeId', v_store_a, 'idempotencyKey', 'phase1-key-g001', 'expectedSubtotal', v_expected + 5)
        when 'bad_guard' then jsonb_build_object('storeId', v_store_a, 'idempotencyKey', 'phase1-key-g002', 'expectedSubtotal', 'abc')
        when 'no_key' then jsonb_build_object('storeId', v_store_a)
        when 'short_key' then jsonb_build_object('storeId', v_store_a, 'idempotencyKey', 'abc')
        when 'bad_store' then jsonb_build_object('storeId', gen_random_uuid(), 'idempotencyKey', 'phase1-key-g003')
        when 'other_store_key' then jsonb_build_object('storeId', v_store_b, 'idempotencyKey', 'phase1-key-0001')
      end, v_u1);
    exception when raise_exception then
      v_ok := sqlerrm like v_msg;
      assert v_ok, format('refusal "%s" said "%s", expected "%s"', v_text, sqlerrm, v_msg);
    end;
    assert v_ok, format('"%s" must be refused', v_text);
  end loop;
  select count(*) into v_n from public.store_order_requests where user_id = v_u1;
  assert v_n = 1, 'no refused call created an order';

  -- 6. Repeating the press: the same key returns the same order; a new key for the same open cart returns it too.
  v_res2 := public.place_store_order_server(jsonb_build_object('storeId', v_store_a, 'idempotencyKey', 'phase1-key-0001', 'expectedSubtotal', 1), v_u1);
  assert (v_res2->>'duplicate')::boolean and v_res2->>'id' = v_res->>'id' and v_res2->>'trackingNumber' = v_res->>'trackingNumber',
    'the same key brings back the same order';
  v_res2 := public.place_store_order_server(jsonb_build_object('storeId', v_store_a, 'idempotencyKey', 'phase1-key-0002', 'expectedSubtotal', v_expected), v_u1);
  assert (v_res2->>'duplicate')::boolean and (v_res2->>'sameOpenOrder')::boolean and v_res2->>'id' = v_res->>'id',
    'a new key for the same lines already waiting for the store brings back the same order';
  select count(*) into v_n from public.store_order_requests where user_id = v_u1;
  assert v_n = 1, 'no second order was made';
  select count(*) into v_n from public.checkout_sessions where user_id = v_u1;
  assert v_n = 1, 'no second checkout session was made';

  -- 7. The order does not follow the account or the catalog afterwards.
  update public.customer_details set full_name = 'تم تغيير الاسم بعد الطلب هنا', address = 'عنوان جديد تماما', phone = '01099999999' where user_id = v_u1;
  update public.store_products set price = price + 50 where id = a1.id;
  update public.products set name = name || ' (renamed)' where id = (select product_id from public.product_sizes where id = a1.product_size_id);
  select * into v_req from public.store_order_requests where id = (v_res->>'id')::uuid;
  assert v_req.customer_name = 'احمد محمد علي حسن' and v_req.customer_phone = '01012345678' and v_req.customer_snapshot#>>'{buyer,name}' = 'احمد محمد علي حسن',
    'the order keeps the customer data of the moment it was made';
  select * into v_item from public.store_order_request_items where request_id = v_req.id and store_product_id = a1.id;
  assert v_item.unit_price = a1.price and v_item.line_total = round(a1.price * 2, 2) and v_item.product_snapshot->>'name' not like '%(renamed)',
    'the line keeps the price and the product name of the moment it was sold';
  update public.store_products set price = a1.price where id = a1.id;
  update public.products set name = replace(name, ' (renamed)', '') where id = (select product_id from public.product_sizes where id = a1.product_size_id);
  update public.customer_details set full_name = 'احمد محمد علي حسن', address = 'شارع التحرير', phone = '01012345678' where user_id = v_u1;

  -- 8. Changing the cart makes a new order; another store's order is independent; the cart is still not cleared.
  update public.cart_items set quantity = 3 where user_id = v_u1 and store_product_id = a1.id;
  v_res3 := public.place_store_order_server(jsonb_build_object('storeId', v_store_a, 'idempotencyKey', 'phase1-key-0003'), v_u1);
  assert (v_res3->>'duplicate')::boolean is false and v_res3->>'id' <> v_res->>'id', 'different lines are a new order';
  assert (v_res3->>'subtotal')::numeric = round(a1.price * 3, 2) + round(a2.price, 2), 'the new order is priced from the saved cart';
  v_resb := public.place_store_order_server(jsonb_build_object('storeId', v_store_b, 'idempotencyKey', 'phase1-key-0004'), v_u1);
  assert (v_resb->>'duplicate')::boolean is false and (v_resb->>'subtotal')::numeric = round(b1.price * 2, 2), 'store B has its own order with its own line';
  select count(*) into v_n from public.store_order_request_items i join public.store_order_requests r on r.id = i.request_id
  where r.id = (v_resb->>'id')::uuid;
  assert v_n = 1, 'store B''s order holds store B''s line only';
  select count(*) into v_n from public.store_order_requests where user_id = v_u1;
  assert v_n = 3, 'three independent orders';
  select count(distinct tracking_number) into v_n from public.store_order_requests where user_id = v_u1;
  assert v_n = 3, 'each order has its own tracking number';
  select count(*) into v_n from public.cart_items where user_id = v_u1;
  assert v_n = 3, 'the cart still holds all three lines';

  -- 9. A recipient and a different shipping address flow into the order automatically.
  insert into public.cart_items (user_id, store_product_id, quantity) values (v_u3, a2.id, 1);
  v_res := public.place_store_order_server(jsonb_build_object('storeId', v_store_a, 'idempotencyKey', 'phase1-key-u3-1'), v_u3);
  select * into v_req from public.store_order_requests where id = (v_res->>'id')::uuid;
  assert v_req.customer_name = 'سارة عبد الله' and v_req.customer_phone = '01212345678', 'the recipient is who the courier asks for';
  assert v_req.customer_address = 'الإسكندرية، سموحة، شارع البحر 7، مبنى 12، الدور 4، شقة 9', 'the shipping address, with all its parts, is the order address';
  assert v_req.customer_notes like 'المشتري: منى سمير فتحي عبد - 01112345678%', 'the buyer is written in the notes';
  assert v_req.customer_snapshot#>>'{recipient,name}' = 'سارة عبد الله' and v_req.customer_snapshot#>>'{buyer,address}' = 'شارع الهرم 10'
    and v_req.customer_snapshot#>>'{shipping,sameAsBuyer}' = 'false', 'the snapshot keeps buyer, recipient and shipping apart';

  -- 10. The order is immutable, and is never deleted.
  for v_text, v_msg in
    select * from (values
      ('name', 'The order base is immutable'),
      ('phone', 'The order base is immutable'),
      ('address', 'The order base is immutable'),
      ('snapshot', 'The order base is immutable'),
      ('subtotal', 'The order base is immutable'),
      ('currency', 'The order base is immutable'),
      ('owner', 'The order base is immutable'),
      ('confirm', 'Customer purchase confirmation is retired'),
      ('merchant_unmatched', 'Merchant numbers are recorded only after the merchant notice matched%')
    ) t(k, m)
  loop
    v_ok := false;
    begin
      update public.store_order_requests set
        customer_name = case when v_text = 'name' then 'x' else customer_name end,
        customer_phone = case when v_text = 'phone' then '1' else customer_phone end,
        customer_address = case when v_text = 'address' then 'x' else customer_address end,
        customer_snapshot = case when v_text = 'snapshot' then '{}'::jsonb else customer_snapshot end,
        subtotal = case when v_text = 'subtotal' then 1 else subtotal end,
        currency = case when v_text = 'currency' then 'USD' else currency end,
        user_id = case when v_text = 'owner' then v_u1 else user_id end,
        customer_confirmed_at = case when v_text = 'confirm' then now() else customer_confirmed_at end,
        merchant_order_number = case when v_text = 'merchant_unmatched' then 'M-1' else merchant_order_number end
      where id = v_req.id;
    exception when raise_exception then
      v_ok := sqlerrm like v_msg;
      assert v_ok, format('update "%s" said "%s", expected "%s"', v_text, sqlerrm, v_msg);
    end;
    assert v_ok, format('update "%s" must be refused', v_text);
  end loop;
  for v_text in select unnest(array['product_name', 'quantity', 'price', 'snapshot', 'size', 'platform_number']) loop
    v_ok := false;
    begin
      update public.store_order_request_items set
        product_name = case when v_text = 'product_name' then 'x' else product_name end,
        quantity = case when v_text = 'quantity' then quantity + 1 else quantity end,
        unit_price = case when v_text = 'price' then 1 else unit_price end,
        product_snapshot = case when v_text = 'snapshot' then '{}'::jsonb else product_snapshot end,
        size_label = case when v_text = 'size' then 'x' else size_label end,
        platform_order_number = case when v_text = 'platform_number' then 'X-01' else platform_order_number end
      where request_id = v_req.id;
    exception when raise_exception then
      v_ok := sqlerrm = 'Order lines are immutable; use an adjustment';
      assert v_ok, format('line update "%s" said "%s"', v_text, sqlerrm);
    end;
    assert v_ok, format('line update "%s" must be refused', v_text);
  end loop;
  assert (select count(*) from pg_trigger t where t.tgname = 'protect_order_base_trigger' and not t.tgisinternal and (t.tgtype & 8) <> 0
          and t.tgrelid in ('public.store_order_requests'::regclass, 'public.store_order_request_items'::regclass)) = 2,
    'the protection runs on DELETE for both the order and its lines';

  -- 11. Merchant numbers: none at creation, fixed once recorded, recorded only after a matched notice.
  begin
    insert into public.store_order_requests (tracking_number, store_id, user_id, customer_name, customer_phone, customer_address, subtotal, currency, merchant_order_number)
    values ('ELN-TEST-MERCHANT-1', v_store_a, v_u1, 'n', '1', 'a', 1, 'EGP', 'M-1');
    raise exception 'a merchant number at creation must be refused';
  exception when raise_exception then
    if sqlerrm = 'a merchant number at creation must be refused' then raise; end if;
    assert sqlerrm like 'Merchant numbers do not exist when an order is created%', 'creation with a merchant number: ' || sqlerrm;
  end;
  update public.store_order_requests set reconciliation_status = 'matched' where id = v_req.id;
  update public.store_order_requests set merchant_order_number = 'M-100', merchant_invoice_number = 'INV-100' where id = v_req.id;
  begin
    update public.store_order_requests set merchant_order_number = 'M-101' where id = v_req.id;
    raise exception 'a recorded merchant number must not change';
  exception when raise_exception then
    if sqlerrm = 'a recorded merchant number must not change' then raise; end if;
    assert sqlerrm like 'A merchant number is fixed once it is recorded%', 'changing a recorded number: ' || sqlerrm;
  end;

  -- 12. The customer's own confirmation is retired and nothing in the sale or commission cycle reads it.
  begin
    perform public.confirm_store_order_purchase_server(v_req.id, v_u3);
    raise exception 'the customer confirmation must be refused';
  exception when raise_exception then
    if sqlerrm = 'the customer confirmation must be refused' then raise; end if;
    assert sqlerrm = 'Customer purchase confirmation is retired', 'confirmation refusal: ' || sqlerrm;
  end;
  assert not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prokind = 'f'
      and p.proname in ('accrue_store_order_commission', 'shipment_signals', 'receive_store_order_notification', 'platform_verify_store_delivery',
                        'set_verified_delivery_commission_deadlines', 'place_store_order', 'create_store_order_request')
      and pg_get_functiondef(p.oid) ilike '%customer_confirmed%'),
    'no sale or commission function reads the customer''s confirmation';
  assert pg_get_viewdef('public.platform_commission_watch'::regclass) not ilike '%customer_confirmed%', 'the watch view ignores the customer''s word';
  assert (select count(*) from public.platform_store_order_health(30)) >= 0, 'the health report runs without the customer column';
  assert not (select pg_get_function_result('public.platform_store_order_health(integer)'::regprocedure) ilike '%customer_confirmed%'), 'the health report has no customer-confirmation column';

  -- 13. EGP only in the database.
  begin
    insert into public.store_order_requests (tracking_number, store_id, user_id, customer_name, customer_phone, customer_address, subtotal, currency)
    values ('ELN-TEST-USD-1', v_store_a, v_u1, 'n', '1', 'a', 1, 'USD');
    raise exception 'a USD order must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.checkout_sessions (tracking_number, user_id, customer_name, customer_phone, customer_address, currency, subtotal)
    values ('ELN-TEST-USD-2', v_u1, 'n', '1', 'a', 'SAR', 1);
    raise exception 'a SAR checkout session must be refused';
  exception when check_violation then null;
  end;

  -- 14. A customer cannot flood a store: after 20 orders in an hour the next one is refused.
  insert into public.store_order_requests (tracking_number, store_id, user_id, customer_name, customer_phone, customer_address, subtotal, currency)
  select 'ELN-TEST-FLOOD-' || g, v_store_b, v_u3, 'n', '1', 'a', 1, 'EGP' from generate_series(1, 19) g;
  begin
    perform public.place_store_order_server(jsonb_build_object('storeId', v_store_a, 'idempotencyKey', 'phase1-key-u3-9'), v_u3);
    raise exception 'the 21st order in an hour must be refused';
  exception when raise_exception then
    if sqlerrm = 'the 21st order in an hour must be refused' then raise; end if;
    assert sqlerrm like 'Too many orders%', 'the flood refusal says so: ' || sqlerrm;
  end;

  -- 15. The keys table is closed to clients.
  perform set_config('request.jwt.claims', json_build_object('sub', v_u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform count(*) from private.store_order_idempotency;
    raise exception 'clients must not read the retry keys';
  exception when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
