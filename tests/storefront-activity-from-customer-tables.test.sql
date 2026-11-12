-- Real-database test for supabase/migrations/20261106080837_storefront_activity_from_customer_tables.sql, as changed by
-- 20261109060420_final_product_stats_table.sql (all-time figures, no 365-day window, read through the final table) and
-- 20261110060252_product_stats_mean_of_customers_and_stores.sql (each figure is round((customers + the active stores) / 2)).
-- Run AFTER the migrations, as the project owner, inside one transaction. Every fixture is synthetic
-- (example.invalid user, one fixture perfume, fixture orders and events) and everything is rolled back at the end.
--
-- Proves that the three figures the storefront reads from public.public_products (sales_count, views_count, search_count)
-- come from the real customer tables (through the final table public.product_stats, refreshed by
-- private.refresh_product_stats()) and not from a hand-edited number, that only the right rows count, that NOTHING expires
-- after a year,
-- and that the visitor roles still cannot read any customer table.
begin;

do $fixture$
declare
  v_user uuid := gen_random_uuid();
  v_store uuid;
  v_brand uuid;
  v_product uuid;
  v_other_product uuid;
  v_size uuid;
  v_offer uuid;
  v_guest uuid;
  v_sid_user uuid := gen_random_uuid();
  v_sid_guest uuid := gen_random_uuid();
  v_slug text := 'fixture-' || replace(gen_random_uuid()::text, '-', '');
  v_price numeric := 100;
  v_payload jsonb;
  v_request uuid;
  v_row record;
  v_denied boolean;
begin
  select id into v_store from public.stores where status = 'active' order by id limit 1;
  if v_store is null then raise exception 'fixture requires an active store'; end if;

  insert into auth.users (id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, email_confirmed_at, created_at, updated_at)
  values (v_user, 'authenticated', 'authenticated', 'fixture-' || v_user::text || '@example.invalid', '', '{}'::jsonb, '{"full_name":"activity-fixture"}'::jsonb, now(), now(), now());
  perform set_config('request.jwt.claim.sub', v_user::text, true);

  insert into public.brands(name, slug, is_active) values ('Fixture brand ' || v_slug, v_slug || '-brand', true) returning id into v_brand;
  insert into public.products(brand_id, name, slug, short_description, official_description, gender, notes_source, content_source, status, is_active)
  values (v_brand, 'Activity fixture ' || v_slug, v_slug, 'fixture', 'fixture', 'unisex', 'store_catalog', 'activity_fixture', 'published', true) returning id into v_product;
  insert into public.products(brand_id, name, slug, short_description, official_description, gender, notes_source, content_source, status, is_active)
  values (v_brand, 'Activity fixture quiet ' || v_slug, v_slug || '-quiet', 'fixture', 'fixture', 'unisex', 'store_catalog', 'activity_fixture', 'published', true) returning id into v_other_product;
  insert into public.product_sizes(product_id, size_ml, size_label, sku) values (v_product, 50, '50 ml', 'AF-' || left(replace(v_product::text, '-', ''), 12)) returning id into v_size;
  insert into public.store_products(store_id, product_size_id, price, original_price, stock_quantity, is_available, currency, data_source, sync_status, product_url)
  values (v_store, v_size, v_price, 120, 100, true, 'EGP', 'store_catalog', 'synced', 'https://example.invalid/activity-fixture') returning id into v_offer;
  insert into public.product_sizes(product_id, size_ml, size_label, sku) values (v_other_product, 50, '50 ml', 'AF-' || right(replace(v_other_product::text, '-', ''), 12));
  insert into public.store_products(store_id, product_size_id, price, original_price, stock_quantity, is_available, currency, data_source, sync_status, product_url)
  select v_store, ps.id, v_price, 120, 100, true, 'EGP', 'store_catalog', 'synced', 'https://example.invalid/activity-fixture-quiet' from public.product_sizes ps where ps.product_id = v_other_product;

  -- SALES: 2 completed+matched and 3 delivered+pending count (5 units); a rejected order (7) and a new one (4) do not.
  v_payload := jsonb_build_object('storeId', v_store, 'trackingNumber', 'ACTIVITY-' || replace(gen_random_uuid()::text, '-', ''),
    'customer', jsonb_build_object('name', 'Synthetic Test', 'phone', '0000000000', 'address', 'Rollback fixture'),
    'items', jsonb_build_array(jsonb_build_object('productSizeId', v_size, 'storeProductId', v_offer, 'quantity', 2, 'unitPrice', v_price, 'total', v_price * 2)));
  v_request := (public.create_store_order_request(v_payload)->>'id')::uuid;
  update public.store_order_requests set status = 'completed', reconciliation_status = 'matched' where id = v_request;

  v_payload := jsonb_set(v_payload, '{trackingNumber}', to_jsonb('ACTIVITY-' || replace(gen_random_uuid()::text, '-', '')));
  v_payload := jsonb_set(v_payload, '{items,0,quantity}', '3'::jsonb);
  v_payload := jsonb_set(v_payload, '{items,0,total}', to_jsonb(v_price * 3));
  v_request := (public.create_store_order_request(v_payload)->>'id')::uuid;
  perform set_config('elan.pay_write', 'on', true);
  update public.store_order_requests set status = 'delivered', payment_status = 'cod_selected', payment_method = 'cod', reconciliation_status = 'pending' where id = v_request;

  v_payload := jsonb_set(v_payload, '{trackingNumber}', to_jsonb('ACTIVITY-' || replace(gen_random_uuid()::text, '-', '')));
  v_payload := jsonb_set(v_payload, '{items,0,quantity}', '7'::jsonb);
  v_payload := jsonb_set(v_payload, '{items,0,total}', to_jsonb(v_price * 7));
  v_request := (public.create_store_order_request(v_payload)->>'id')::uuid;
  update public.store_order_requests set status = 'store_rejected', reconciliation_status = 'matched' where id = v_request;

  v_payload := jsonb_set(v_payload, '{trackingNumber}', to_jsonb('ACTIVITY-' || replace(gen_random_uuid()::text, '-', '')));
  v_payload := jsonb_set(v_payload, '{items,0,quantity}', '4'::jsonb);
  v_payload := jsonb_set(v_payload, '{items,0,total}', to_jsonb(v_price * 4));
  perform public.create_store_order_request(v_payload);

  -- EVENTS of a registered customer: 4 views (one of them 400 days ago: nothing expires) and 1 search count; 2 cart additions do not.
  insert into public.guest_visitors (fingerprint_hash, status) values (repeat('a', 64), 'guest') returning id into v_guest;
  insert into public.customer_sessions (session_id, user_id) values (v_sid_user, v_user);
  insert into public.customer_sessions (session_id, guest_id) values (v_sid_guest, v_guest);
  insert into public.customer_product_events (session_id, user_id, product_id, event_type, occurred_at) values
    (v_sid_user, v_user, v_product, 'view', now() - interval '1 day'),
    (v_sid_user, v_user, v_product, 'view', now() - interval '2 days'),
    (v_sid_user, v_user, v_product, 'view', now()),
    (v_sid_user, v_user, v_product, 'view', now() - interval '400 days'),
    (v_sid_user, v_user, v_product, 'search', now() - interval '3 days'),
    (v_sid_user, v_user, v_product, 'cart_add', now()),
    (v_sid_user, v_user, v_product, 'cart_add', now());
  -- the detailed trail of a guest is a second copy of the guest's counters: it must not be counted twice
  insert into public.customer_product_events (session_id, guest_id, product_id, event_type) values
    (v_sid_guest, v_guest, v_product, 'view'), (v_sid_guest, v_guest, v_product, 'view'), (v_sid_guest, v_guest, v_product, 'search');
  -- GUEST counters: 5 views and 2 searches count, and so do the 100 views from 400 days ago (all time).
  insert into public.guest_product_analytics (visitor_hash, product_id, activity_date, event_type, event_count) values
    (repeat('b', 64), v_product, current_date, 'view', 5),
    (repeat('b', 64), v_product, current_date - 3, 'search', 2),
    (repeat('c', 64), v_product, current_date - 400, 'view', 100);

  -- a hand-edited number has no say: the next refresh writes the real figures over it
  update public.product_stats set views_count = 999, views_source = 'customers', sales_count = 999, sales_source = 'customers',
                                  search_count = 999, search_source = 'customers' where product_id = v_product;
  perform private.refresh_product_stats();

  select views_count, search_count, sales_count into v_row from public.public_products where id = v_product;
  -- no store has reported anything for this perfume yet, so the stores' half is 0: figure = round(customers / 2)
  if v_row.views_count is distinct from 55 then raise exception 'views_count expected round(109 / 2) = 55 (customers 5 + 100 guest + 4 registered, all time), got %', v_row.views_count; end if;
  if v_row.search_count is distinct from 2 then raise exception 'search_count expected round(3 / 2) = 2 (customers 2 guest + 1 registered), got %', v_row.search_count; end if;
  if v_row.sales_count is distinct from 3 then raise exception 'sales_count expected round(5 / 2) = 3 (customers: completed 2 + delivered 3; rejected and new excluded), got %', v_row.sales_count; end if;
  if (select views_source || '/' || search_source || '/' || sales_source from public.product_stats where product_id = v_product) is distinct from 'customers/customers/customers' then
    raise exception 'with no store figure every source must be customers'; end if;

  -- now the active store reports 91 views and 7 sold units for it: the two sides are averaged (and the source says so)
  set local role service_role;
  insert into public.store_catalog_most_viewed(store_product_id, store_id, product_size_id, views_count) values (v_offer, v_store, v_size, 91);
  insert into public.store_catalog_best_sellers(store_product_id, store_id, product_size_id, units_sold) values (v_offer, v_store, v_size, 7);
  reset role;
  perform private.refresh_product_stats();
  select views_count, search_count, sales_count into v_row from public.public_products where id = v_product;
  if v_row.views_count is distinct from 100 then raise exception 'views_count expected (109 customers + 91 store) / 2 = 100, got %', v_row.views_count; end if;
  if v_row.search_count is distinct from 2 then raise exception 'search_count must stay 2 (no store figure), got %', v_row.search_count; end if;
  if v_row.sales_count is distinct from 6 then raise exception 'sales_count expected (5 customers + 7 store) / 2 = 6, got %', v_row.sales_count; end if;
  if (select views_source || '/' || search_source || '/' || sales_source from public.product_stats where product_id = v_product) is distinct from 'combined/customers/combined' then
    raise exception 'sources expected combined/customers/combined'; end if;

  -- a perfume nobody touched shows zeros, never null
  select views_count, search_count, sales_count into v_row from public.public_products where id = v_other_product;
  if v_row.views_count is distinct from 0 or v_row.search_count is distinct from 0 or v_row.sales_count is distinct from 0 then
    raise exception 'an untouched perfume must show 0/0/0, got %/%/%', v_row.views_count, v_row.search_count, v_row.sales_count;
  end if;

  -- the storefront's own role sees the same numbers and still cannot read any customer table
  set local role anon;
  select views_count, search_count, sales_count into v_row from public.public_products where id = v_product;
  if v_row.views_count is distinct from 100 or v_row.search_count is distinct from 2 or v_row.sales_count is distinct from 6 then
    raise exception 'anon sees %/%/% instead of 100/2/6', v_row.views_count, v_row.search_count, v_row.sales_count;
  end if;
  v_denied := false; begin perform 1 from public.customer_product_events limit 1; exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'anon can read customer_product_events'; end if;
  v_denied := false; begin perform 1 from public.guest_product_analytics limit 1; exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'anon can read guest_product_analytics'; end if;
  v_denied := false; begin perform 1 from public.registered_customer_best_sellers limit 1; exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'anon can read registered_customer_best_sellers'; end if;
  reset role;

  -- nothing new is exposed: the helper lives in the private schema and returns only an id and three counts
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'fn_product_public_activity') then
    raise exception 'the helper must not exist in the public schema (it would become a client RPC)';
  end if;
  if (select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'fn_product_public_activity')
     is distinct from 'TABLE(product_id uuid, views_count integer, search_count integer, sales_count integer)' then
    raise exception 'the helper must return only a product id and the three counts';
  end if;
  if not exists (select 1 from pg_class where oid = 'public.public_products'::regclass and reloptions @> array['security_invoker=true']) then
    raise exception 'public_products must stay a security_invoker view';
  end if;
end;
$fixture$;

rollback;
