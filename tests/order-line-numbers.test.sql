-- Real-database test for supabase/migrations/20261118063850_order_lines_stable_order.sql.
-- The order page shows each line with the number it will get (tracking number, then -01, -02 ...). The numbers follow the order the database
-- reads the cart, and that order is now the byte order of the store product id, whatever order the rows were added in.
-- Run AFTER the migration as the project owner. Everything is rolled back. Synthetic user only; the integration row (fake https address,
-- fake secret) is added inside the transaction and rolled back with it.
begin;

do $$
declare
  v_u constant uuid := 'b0000000-0000-4000-8000-0000000000e1';
  v_store uuid;
  v_ids uuid[];
  v_sub numeric := 0;
  v_res jsonb;
  v_got text[];
  v_want text[];
  v_trk text;
  i integer;
begin
  -- an active store with several lines that are really on offer at the platform
  select sp.store_id into v_store
  from public.store_products sp
  join public.catalog_platform_offers po on po.store_product_id = sp.id and po.store_id = sp.store_id and po.product_size_id = sp.product_size_id and po.price = sp.price and po.currency = sp.currency
  join public.stores s on s.id = sp.store_id
  where s.status = 'active' and sp.currency = 'EGP'
  group by sp.store_id having count(*) >= 3 order by count(*) desc limit 1;
  assert v_store is not null, 'a store with three offered products exists to test with';

  select array_agg(x.id) into v_ids from (
    select sp.id from public.store_products sp
    join public.catalog_platform_offers po on po.store_product_id = sp.id and po.store_id = sp.store_id and po.product_size_id = sp.product_size_id and po.price = sp.price and po.currency = sp.currency
    where sp.store_id = v_store and sp.currency = 'EGP' order by sp.id limit 3) x;
  update public.store_products set is_available = true, stock_quantity = 50 where id = any (v_ids);

  insert into auth.users (id, aud, role, email, raw_user_meta_data) values (v_u, 'authenticated', 'authenticated', 'lines-1@example.invalid', '{"full_name":"Lines One"}'::jsonb);
  insert into public.customer_details (user_id, full_name, phone, governorate, city, address, building_no, ship_same)
  values (v_u, 'احمد محمد علي حسن', '01012345678', 'القاهرة', 'القاهرة', 'شارع التحرير', '5', true);
  insert into public.store_integrations (store_id, enabled, base_url, cart_url, api_base_url, catalog_endpoint, api_key, webhook_secret, notes, order_endpoint)
  values (v_store, true, 'https://merchant.example.invalid', 'https://merchant.example.invalid/cart', 'https://merchant.example.invalid/api',
          '/catalog', 'fake-api-key-for-test', 'fake-webhook-secret-for-test-0000000000', '', 'https://merchant.example.invalid/elan/orders')
  on conflict (store_id) do update set enabled = true, order_endpoint = 'https://merchant.example.invalid/elan/orders', webhook_secret = 'fake-webhook-secret-for-test-0000000000';

  -- the cart rows are added in the REVERSE of byte order, with quantities that differ
  for i in reverse 3..1 loop
    insert into public.cart_items (user_id, store_product_id, quantity) values (v_u, v_ids[i], i);
    v_sub := v_sub + (select price from public.store_products where id = v_ids[i]) * i;
  end loop;

  v_res := public.place_store_order_server(jsonb_build_object('storeId', v_store, 'idempotencyKey', 'lines-order-key-0001', 'expectedSubtotal', v_sub), v_u);
  v_trk := v_res->>'trackingNumber';
  assert v_trk is not null, 'the order was placed';

  select array_agg(ri.store_product_id::text order by ri.platform_order_number) into v_got
  from public.store_order_request_items ri where ri.request_id = (v_res->>'id')::uuid;
  select array_agg(x::text order by x::text collate "C") into v_want from unnest(v_ids) x;
  assert v_got = v_want, 'the lines are numbered in the byte order of their store product id: ' || v_got::text || ' vs ' || v_want::text;

  for i in 1..3 loop
    assert exists (
      select 1 from public.store_order_request_items ri
      where ri.request_id = (v_res->>'id')::uuid and ri.platform_order_number = v_trk || '-' || lpad(i::text, 2, '0') and ri.store_product_id::text = v_want[i]),
      'line ' || i || ' carries ' || v_trk || '-0' || i || ' and the ' || i || 'th product in byte order';
  end loop;

  raise exception 'ALL CHECKS PASSED';
end $$;

rollback;
