-- Live Supabase integration regression for registered-customer best-seller counting.
-- Every fixture is synthetic and the transaction is rolled back at the end.
begin;

do $best_seller_fixture$
declare
  v_user_id uuid := gen_random_uuid();
  v_store_id uuid;
  v_brand_id uuid;
  v_product_id uuid;
  v_size_1 uuid;
  v_size_2 uuid;
  v_offer_1 uuid;
  v_offer_2 uuid;
  v_request_1 uuid;
  v_request_2 uuid;
  v_request_3 uuid;
  v_request_4 uuid;
  v_payload jsonb;
  v_result jsonb;
  v_product_row jsonb;
  v_units numeric;
  v_purchases numeric;
  v_audit jsonb;
  v_name text := 'Best seller fixture ' || gen_random_uuid()::text;
  v_brand text := 'Fixture brand ' || gen_random_uuid()::text;
  v_slug text := 'fixture-' || replace(gen_random_uuid()::text,'-','');
  v_price_1 numeric := 123.45;
  v_price_2 numeric := 234.56;
begin
  select id into v_store_id from public.stores where status='active' order by id limit 1;
  if v_store_id is null then raise exception 'fixture requires an active store'; end if;

  insert into auth.users (
    id, aud, role, email, encrypted_password, raw_app_meta_data,
    raw_user_meta_data, email_confirmed_at, created_at, updated_at
  ) values (
    v_user_id, 'authenticated', 'authenticated',
    'fixture-' || v_user_id::text || '@example.invalid', '', '{}'::jsonb,
    '{"full_name":"best-seller-fixture"}'::jsonb, now(), now(), now()
  );
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);

  insert into public.brands(name, slug, is_active)
  values (v_brand, v_slug || '-brand', true) returning id into v_brand_id;
  insert into public.products(brand_id, name, slug, short_description, official_description, gender, notes_source, content_source, status, is_active)
  values (v_brand_id, v_name, v_slug, 'fixture', 'fixture', 'unisex', 'store_catalog', 'transactional_fixture', 'published', true)
  returning id into v_product_id;
  insert into public.product_sizes(product_id, size_ml, size_label, sku)
  values (v_product_id, 37, '37 ml', 'BS-' || left(replace(v_product_id::text,'-',''),12)) returning id into v_size_1;
  insert into public.product_sizes(product_id, size_ml, size_label, sku)
  values (v_product_id, 75, '75 ml', 'BS-' || right(replace(v_product_id::text,'-',''),12)) returning id into v_size_2;
  insert into public.store_products(store_id, product_size_id, price, original_price, stock_quantity, is_available, currency, data_source, sync_status, product_url)
  values (v_store_id, v_size_1, v_price_1, 150, 100, true, 'EGP', 'store_catalog', 'synced', 'https://example.invalid/best-seller-1')
  returning id into v_offer_1;
  insert into public.store_products(store_id, product_size_id, price, original_price, stock_quantity, is_available, currency, data_source, sync_status, product_url)
  values (v_store_id, v_size_2, v_price_2, 270, 100, true, 'EGP', 'store_catalog', 'synced', 'https://example.invalid/best-seller-2')
  returning id into v_offer_2;

  v_payload := jsonb_build_object(
    'storeId',v_store_id,
    'trackingNumber','BESTSELLER-' || replace(gen_random_uuid()::text,'-',''),
    'customer',jsonb_build_object('name','Synthetic Test','phone','0000000000','address','Rollback fixture'),
    'items',jsonb_build_array(jsonb_build_object(
      'productSizeId',v_size_1,'storeProductId',v_offer_1,'quantity',2,
      'unitPrice',v_price_1,'total',v_price_1*2,
      'name','untrusted client name','brand','untrusted brand','size','wrong size'
    ))
  );
  v_request_1 := (public.create_store_order_request(v_payload)->>'id')::uuid;
  update public.store_order_requests set status='completed', reconciliation_status='matched' where id=v_request_1;

  v_payload := jsonb_build_object(
    'storeId',v_store_id,
    'trackingNumber','BESTSELLER-' || replace(gen_random_uuid()::text,'-',''),
    'customer',jsonb_build_object('name','Synthetic Test','phone','0000000000','address','Rollback fixture'),
    'items',jsonb_build_array(jsonb_build_object(
      'productSizeId',v_size_2,'storeProductId',v_offer_2,'quantity',3,
      'unitPrice',v_price_2,'total',v_price_2*3,'name','untrusted client name'
    ))
  );
  v_request_2 := (public.create_store_order_request(v_payload)->>'id')::uuid;
  update public.store_order_requests set status='delivered', reconciliation_status='pending' where id=v_request_2;

  v_payload := jsonb_build_object(
    'storeId',v_store_id,
    'trackingNumber','BESTSELLER-' || replace(gen_random_uuid()::text,'-',''),
    'customer',jsonb_build_object('name','Synthetic Test','phone','0000000000','address','Rollback fixture'),
    'items',jsonb_build_array(jsonb_build_object(
      'productSizeId',v_size_1,'storeProductId',v_offer_1,'quantity',7,
      'unitPrice',v_price_1,'total',v_price_1*7,'name','untrusted client name'
    ))
  );
  v_request_3 := (public.create_store_order_request(v_payload)->>'id')::uuid;
  update public.store_order_requests set status='store_rejected', reconciliation_status='matched' where id=v_request_3;

  v_payload := jsonb_build_object(
    'storeId',v_store_id,
    'trackingNumber','BESTSELLER-' || replace(gen_random_uuid()::text,'-',''),
    'customer',jsonb_build_object('name','Synthetic Test','phone','0000000000','address','Rollback fixture'),
    'items',jsonb_build_array(jsonb_build_object(
      'productSizeId',v_size_1,'storeProductId',v_offer_1,'quantity',4,
      'unitPrice',v_price_1,'total',v_price_1*4,'name','untrusted client name'
    ))
  );
  v_request_4 := (public.create_store_order_request(v_payload)->>'id')::uuid;

  if not exists (
    select 1 from public.store_order_request_items i
    where i.request_id=v_request_1 and i.product_id=v_product_id
      and i.product_name=v_name and i.brand_name=v_brand and i.size_label='37 ml'
    limit 1
  ) then raise exception 'order line did not capture authoritative immutable catalog identity'; end if;

  v_result := public.platform_registered_customer_best_sellers('all',100,0);
  select item into v_product_row
  from jsonb_array_elements(v_result->'records') as e(item)
  where item->'product'->>'id'=v_product_id::text
  limit 1;
  if v_product_row is null then raise exception 'fixture perfume missing from best-seller ranking'; end if;
  v_units := (v_product_row->>'unitsSold')::numeric;
  v_purchases := (v_product_row->>'purchases')::numeric;
  if v_units <> 5 or v_purchases <> 2 then
    raise exception 'best-seller aggregation expected 5 units in 2 purchases; got % units in % purchases',v_units,v_purchases;
  end if;
  if jsonb_array_length(v_product_row->'sizeBreakdown') <> 2 then
    raise exception 'best-seller report did not aggregate and break down both sizes';
  end if;
  v_audit := v_result->'audit';
  if (v_audit->>'eligibleUnits')::integer <> 5
     or (v_audit->>'rankedUnits')::integer <> 5
     or (v_audit->>'excludedCancelledUnits')::integer <> 7
     or (v_audit->>'excludedInProgressUnits')::integer <> 4 then
    raise exception 'sales eligibility audit counts were not correct: %',v_audit;
  end if;
end;
$best_seller_fixture$;

rollback;
