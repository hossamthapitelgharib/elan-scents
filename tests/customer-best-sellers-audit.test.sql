-- Real-database regression test for platform_registered_customer_best_sellers after migration
-- 20261020101127_restore_best_seller_audit_breakdown.sql (net units, returns and refunds, audit buckets).
-- Run it on the live project or a scratch database exactly as it is: everything happens inside BEGIN ... ROLLBACK,
-- the fixture is synthetic, and nothing is left behind. It needs one active store. It passed on the live project
-- (inside an aborted transaction) before the migration was applied.
--
-- Fixture (registered customer, one perfume with two sizes):
--   request 1: 2 units of size A, completed + matched      -> eligible, then 1 unit returned
--   request 2: 3 units of size B, delivered + pending      -> eligible, then fully refunded (net 0)
--   request 3: 7 units of size A, store_rejected           -> excluded as cancelled
--   request 4: 4 units of size A, awaiting confirmation    -> excluded as in progress
--   request 5: 1 unit of size A, completed + pending       -> excluded as review (not yet reconciled)
-- Expected: 1 net unit in 1 purchase; reversed 4; cancelled 7; in progress 4; review 1; registered 17 = 1 + 4 + 7 + 4 + 1.
begin;
do $audit_fixture$
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
  v_request_5 uuid;
  v_item_1 uuid;
  v_item_2 uuid;
  v_payload jsonb;
  v_result jsonb;
  v_product_row jsonb;
  v_audit jsonb;
  v_sum numeric;
  v_name text := 'Audit fixture ' || gen_random_uuid()::text;
  v_brand text := 'Fixture brand ' || gen_random_uuid()::text;
  v_slug text := 'fixture-' || replace(gen_random_uuid()::text,'-','');
  v_price_1 numeric := 123.45;
  v_price_2 numeric := 234.56;
begin
  select id into v_store_id from public.stores where status='active' order by id limit 1;
  if v_store_id is null then raise exception 'fixture requires an active store'; end if;

  insert into auth.users (id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, email_confirmed_at, created_at, updated_at)
  values (v_user_id, 'authenticated', 'authenticated', 'fixture-' || v_user_id::text || '@example.invalid', '', '{}'::jsonb, '{"full_name":"best-seller-fixture"}'::jsonb, now(), now(), now());
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);

  insert into public.brands(name, slug, is_active) values (v_brand, v_slug || '-brand', true) returning id into v_brand_id;
  insert into public.products(brand_id, name, slug, short_description, official_description, gender, notes_source, content_source, status, is_active)
  values (v_brand_id, v_name, v_slug, 'fixture', 'fixture', 'unisex', 'store_catalog', 'transactional_fixture', 'published', true) returning id into v_product_id;
  insert into public.product_sizes(product_id, size_ml, size_label, sku) values (v_product_id, 37, '37 ml', 'BS-' || left(replace(v_product_id::text,'-',''),12)) returning id into v_size_1;
  insert into public.product_sizes(product_id, size_ml, size_label, sku) values (v_product_id, 75, '75 ml', 'BS-' || right(replace(v_product_id::text,'-',''),12)) returning id into v_size_2;
  insert into public.store_products(store_id, product_size_id, price, original_price, stock_quantity, is_available, currency, data_source, sync_status, product_url)
  values (v_store_id, v_size_1, v_price_1, 150, 100, true, 'EGP', 'store_catalog', 'synced', 'https://example.invalid/best-seller-1') returning id into v_offer_1;
  insert into public.store_products(store_id, product_size_id, price, original_price, stock_quantity, is_available, currency, data_source, sync_status, product_url)
  values (v_store_id, v_size_2, v_price_2, 270, 100, true, 'EGP', 'store_catalog', 'synced', 'https://example.invalid/best-seller-2') returning id into v_offer_2;

  v_payload := jsonb_build_object('storeId',v_store_id,'trackingNumber','AUDIT-' || replace(gen_random_uuid()::text,'-',''),
    'customer',jsonb_build_object('name','Synthetic Test','phone','0000000000','address','Rollback fixture'),
    'items',jsonb_build_array(jsonb_build_object('productSizeId',v_size_1,'storeProductId',v_offer_1,'quantity',2,'unitPrice',v_price_1,'total',v_price_1*2)));
  v_request_1 := (public.create_store_order_request(v_payload)->>'id')::uuid;
  update public.store_order_requests set status='completed', reconciliation_status='matched' where id=v_request_1;

  v_payload := jsonb_build_object('storeId',v_store_id,'trackingNumber','AUDIT-' || replace(gen_random_uuid()::text,'-',''),
    'customer',jsonb_build_object('name','Synthetic Test','phone','0000000000','address','Rollback fixture'),
    'items',jsonb_build_array(jsonb_build_object('productSizeId',v_size_2,'storeProductId',v_offer_2,'quantity',3,'unitPrice',v_price_2,'total',v_price_2*3)));
  v_request_2 := (public.create_store_order_request(v_payload)->>'id')::uuid;
  update public.store_order_requests set status='delivered', reconciliation_status='pending' where id=v_request_2;

  v_payload := jsonb_build_object('storeId',v_store_id,'trackingNumber','AUDIT-' || replace(gen_random_uuid()::text,'-',''),
    'customer',jsonb_build_object('name','Synthetic Test','phone','0000000000','address','Rollback fixture'),
    'items',jsonb_build_array(jsonb_build_object('productSizeId',v_size_1,'storeProductId',v_offer_1,'quantity',7,'unitPrice',v_price_1,'total',v_price_1*7)));
  v_request_3 := (public.create_store_order_request(v_payload)->>'id')::uuid;
  update public.store_order_requests set status='store_rejected', reconciliation_status='matched' where id=v_request_3;

  v_payload := jsonb_build_object('storeId',v_store_id,'trackingNumber','AUDIT-' || replace(gen_random_uuid()::text,'-',''),
    'customer',jsonb_build_object('name','Synthetic Test','phone','0000000000','address','Rollback fixture'),
    'items',jsonb_build_array(jsonb_build_object('productSizeId',v_size_1,'storeProductId',v_offer_1,'quantity',4,'unitPrice',v_price_1,'total',v_price_1*4)));
  v_request_4 := (public.create_store_order_request(v_payload)->>'id')::uuid;

  -- Before any return: 5 eligible units in 2 purchases, 7 cancelled, 4 in progress.
  v_result := public.platform_registered_customer_best_sellers('all',100,0);
  select item into v_product_row from jsonb_array_elements(v_result->'records') as e(item) where item->'product'->>'id'=v_product_id::text limit 1;
  if v_product_row is null then raise exception 'STEP1 fixture perfume missing from ranking'; end if;
  if (v_product_row->>'unitsSold')::numeric <> 5 or (v_product_row->>'purchases')::numeric <> 2 then raise exception 'STEP1 expected 5 units in 2 purchases, got %', v_product_row; end if;
  v_audit := v_result->'audit';
  if (v_audit->>'eligibleUnits')::integer <> 5 or (v_audit->>'rankedUnits')::integer <> 5 or (v_audit->>'excludedCancelledUnits')::integer <> 7 or (v_audit->>'excludedInProgressUnits')::integer <> 4 then
    raise exception 'STEP1 audit wrong: %', v_audit; end if;

  -- Returns: 1 of 2 units returned on request 1, all 3 units refunded on request 2 (a fully returned line);
  -- plus a completed-but-unreconciled order of 1 unit.
  select id into v_item_1 from public.store_order_request_items where request_id=v_request_1 limit 1;
  select id into v_item_2 from public.store_order_request_items where request_id=v_request_2 limit 1;
  v_payload := jsonb_build_object('storeId',v_store_id,'trackingNumber','AUDIT-' || replace(gen_random_uuid()::text,'-',''),
    'customer',jsonb_build_object('name','Synthetic Test','phone','0000000000','address','Rollback fixture'),
    'items',jsonb_build_array(jsonb_build_object('productSizeId',v_size_1,'storeProductId',v_offer_1,'quantity',1,'unitPrice',v_price_1,'total',v_price_1)));
  v_request_5 := (public.create_store_order_request(v_payload)->>'id')::uuid;
  update public.store_order_requests set status='completed', reconciliation_status='pending' where id=v_request_5;
  insert into public.store_order_item_adjustments(request_id, request_item_id, adjustment_type, status, quantity)
  values (v_request_1, v_item_1, 'return', 'completed', 1), (v_request_2, v_item_2, 'refund', 'completed', 3);

  v_result := public.platform_registered_customer_best_sellers('all',100,0);
  select item into v_product_row from jsonb_array_elements(v_result->'records') as e(item) where item->'product'->>'id'=v_product_id::text limit 1;
  if (v_product_row->>'unitsSold')::numeric <> 1 or (v_product_row->>'purchases')::numeric <> 1 then raise exception 'STEP2 expected 1 net unit in 1 purchase, got %', v_product_row; end if;
  v_audit := v_result->'audit';
  if (v_audit->>'eligibleUnits')::integer <> 1 or (v_audit->>'reversedUnits')::integer <> 4 or (v_audit->>'excludedCancelledUnits')::integer <> 7
     or (v_audit->>'excludedInProgressUnits')::integer <> 4 or (v_audit->>'excludedReviewOrMismatchUnits')::integer <> 1
     or (v_audit->>'excludedOtherUnits')::integer <> 0 or (v_audit->>'ownerConflictUnits')::integer <> 0 or (v_audit->>'registeredUnits')::integer <> 17 then
    raise exception 'STEP2 audit wrong: %', v_audit; end if;

  -- The audit identity: every registered unit is in exactly one bucket.
  v_sum := (v_audit->>'eligibleUnits')::numeric + (v_audit->>'reversedUnits')::numeric + (v_audit->>'excludedCancelledUnits')::numeric + (v_audit->>'excludedInProgressUnits')::numeric
         + (v_audit->>'excludedReviewOrMismatchUnits')::numeric + (v_audit->>'excludedOtherUnits')::numeric + (v_audit->>'ownerConflictUnits')::numeric;
  if v_sum <> (v_audit->>'registeredUnits')::numeric then raise exception 'STEP3 identity broken: % vs %', v_sum, v_audit->>'registeredUnits'; end if;

  -- Every period filter still runs.
  perform public.platform_registered_customer_best_sellers('today',10,0);
  perform public.platform_registered_customer_best_sellers('year',10,5);
end;
$audit_fixture$;
rollback;
