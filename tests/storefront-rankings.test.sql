-- Real-database test for supabase/migrations/20261107135337_storefront_rankings_from_store_catalogs.sql, as changed by
-- 20261109060420_final_product_stats_table.sql (the rankings read the final table) and
-- 20261110060252_product_stats_mean_of_customers_and_stores.sql (the final figure is the average of customers and stores).
-- Run AFTER the migrations, as the project owner, inside one transaction. Every fixture is synthetic (example.invalid users,
-- fixture stores / brand / perfumes, one fixture order) and everything is rolled back at the end.
--
-- Proves that the four Masterpieces rankings (most rated / best sellers / most viewed / most searched):
--   * rank only perfumes the platform offers right now (an out-of-stock offer or an inactive store's offer never ranks);
--   * rank the FINAL figure, the average of the customers' real figures and the stores' catalog figures, and say which side(s)
--     it came from (customers / store_catalog / combined); ties share a rank;
--   * add the figures of several stores, ignore inactive stores, and need at least 3 ratings (approved reviews + store ratings);
--   * leave the stores' tables writable only by the server (service_role): customers, store members and even the platform
--     admin cannot insert, update or delete; a store's team reads only its own rows, the admin reads all, visitors nothing;
--   * copy store_id / product_size_id from the offer, so a row can never claim another store's offer;
--   * expose only ranks and their source through a security_invoker view, with the helpers kept in the private schema.
begin;

create function pg_temp.fx_size(p_brand uuid, p_tag text) returns uuid language plpgsql as $f$
declare v_product uuid; v_size uuid;
begin
  insert into public.products(brand_id, name, slug, short_description, official_description, gender, notes_source, content_source, status, is_active)
  values (p_brand, 'Ranking fixture ' || p_tag, 'rk-' || p_tag, 'fixture', 'fixture', 'unisex', 'store_catalog', 'ranking_fixture', 'published', true) returning id into v_product;
  insert into public.product_sizes(product_id, size_ml, size_label, sku) values (v_product, 50, '50 ml', 'RK-' || p_tag) returning id into v_size;
  return v_size;
end $f$;

create function pg_temp.fx_offer(p_store uuid, p_size uuid, p_stock integer) returns uuid language plpgsql as $f$
declare v_offer uuid;
begin
  insert into public.store_products(store_id, product_size_id, price, original_price, stock_quantity, is_available, currency, data_source, sync_status, product_url)
  values (p_store, p_size, 100, 120, p_stock, true, 'EGP', 'store_catalog', 'synced', 'https://example.invalid/ranking-fixture') returning id into v_offer;
  return v_offer;
end $f$;

do $fixture$
declare
  v_tag text := replace(gen_random_uuid()::text, '-', '');
  v_brand uuid;
  sa uuid; sb uuid; sc uuid;                       -- store A and B active, store C inactive
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid();
  u_member uuid := gen_random_uuid(); u_admin uuid := gen_random_uuid(); u_other uuid := gen_random_uuid();
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid; p6 uuid; p7 uuid;
  z1 uuid; z2 uuid; z3 uuid; z4 uuid; z5 uuid; z6 uuid; z7 uuid;
  o1a uuid; o2a uuid; o2b uuid; o3b uuid; o4a uuid; o4c uuid; o5a uuid; o7c uuid;
  sid1 uuid := gen_random_uuid(); v_request uuid; v_payload jsonb;
  a record; b record; c record; d record; e record;
  n integer; v_denied boolean; v_ok boolean;
begin
  insert into public.stores(name, slug, status) values ('Ranking fixture A', 'rk-a-' || v_tag, 'active') returning id into sa;
  insert into public.stores(name, slug, status) values ('Ranking fixture B', 'rk-b-' || v_tag, 'active') returning id into sb;
  insert into public.stores(name, slug, status) values ('Ranking fixture C', 'rk-c-' || v_tag, 'inactive') returning id into sc;

  insert into auth.users (id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, email_confirmed_at, created_at, updated_at)
  select x, 'authenticated', 'authenticated', 'fixture-' || x::text || '@example.invalid', '', '{}'::jsonb, '{"full_name":"ranking-fixture"}'::jsonb, now(), now(), now()
    from unnest(array[u1, u2, u3, u_member, u_admin, u_other]) x;
  insert into public.profiles(id, role) select x, 'customer' from unnest(array[u1, u2, u3, u_member, u_admin, u_other]) x on conflict (id) do nothing;
  update public.profiles set role = 'platform_admin' where id = u_admin;
  insert into public.store_accounts(store_id, user_id, role) values (sa, u_member, 'store_admin');

  insert into public.brands(name, slug, is_active) values ('Ranking brand ' || v_tag, 'rk-brand-' || v_tag, true) returning id into v_brand;
  z1 := pg_temp.fx_size(v_brand, 'p1-' || v_tag); z2 := pg_temp.fx_size(v_brand, 'p2-' || v_tag); z3 := pg_temp.fx_size(v_brand, 'p3-' || v_tag);
  z4 := pg_temp.fx_size(v_brand, 'p4-' || v_tag); z5 := pg_temp.fx_size(v_brand, 'p5-' || v_tag); z6 := pg_temp.fx_size(v_brand, 'p6-' || v_tag);
  z7 := pg_temp.fx_size(v_brand, 'p7-' || v_tag);
  select product_id into p1 from public.product_sizes where id = z1; select product_id into p2 from public.product_sizes where id = z2;
  select product_id into p3 from public.product_sizes where id = z3; select product_id into p4 from public.product_sizes where id = z4;
  select product_id into p5 from public.product_sizes where id = z5; select product_id into p6 from public.product_sizes where id = z6;
  select product_id into p7 from public.product_sizes where id = z7;

  o1a := pg_temp.fx_offer(sa, z1, 100);
  o2a := pg_temp.fx_offer(sa, z2, 100); o2b := pg_temp.fx_offer(sb, z2, 100);     -- P2 is offered by two stores
  o3b := pg_temp.fx_offer(sb, z3, 100);
  o4a := pg_temp.fx_offer(sa, z4, 100); o4c := pg_temp.fx_offer(sc, z4, 100);      -- P4 also has an offer in the inactive store
  o5a := pg_temp.fx_offer(sa, z5, 0);                                              -- P5: out of stock -> not offered
  perform pg_temp.fx_offer(sa, z6, 100);                                           -- P6: offered, but nobody did anything
  o7c := pg_temp.fx_offer(sc, z7, 100);                                            -- P7: only an inactive store -> not offered

  ---------------------------------------------------------------- customers' real figures
  perform set_config('request.jwt.claim.sub', u1::text, true);
  insert into public.customer_sessions (session_id, user_id) values (sid1, u1);
  insert into public.customer_product_events (session_id, user_id, product_id, event_type, occurred_at) values
    (sid1, u1, p1, 'view', now()), (sid1, u1, p1, 'view', now()), (sid1, u1, p1, 'view', now()),   -- P1: 3 real views
    (sid1, u1, p5, 'view', now()), (sid1, u1, p7, 'view', now());                                    -- P5, P7: real views but not offered
  -- P4: 2 real sold units (completed + matched)
  v_payload := jsonb_build_object('storeId', sa, 'trackingNumber', 'RK-' || replace(gen_random_uuid()::text, '-', ''),
    'customer', jsonb_build_object('name', 'Synthetic Test', 'phone', '0000000000', 'address', 'Rollback fixture'),
    'items', jsonb_build_array(jsonb_build_object('productSizeId', z4, 'storeProductId', o4a, 'quantity', 2, 'unitPrice', 100, 'total', 200)));
  v_request := (public.create_store_order_request(v_payload)->>'id')::uuid;
  update public.store_order_requests set status = 'completed', reconciliation_status = 'matched' where id = v_request;
  -- reviews: P1 3 approved (5,5,4) + 1 unapproved (1); P4 3 approved (3,3,3); P2 only 2 approved (5,5)
  insert into public.reviews(user_id, product_id, rating, is_approved) values
    (u1, p1, 5, true), (u2, p1, 5, true), (u3, p1, 4, true), (u_other, p1, 1, false),
    (u1, p4, 3, true), (u2, p4, 3, true), (u3, p4, 3, true),
    (u1, p2, 5, true), (u2, p2, 5, true);

  ---------------------------------------------------------------- stores' catalog figures (written by the server only)
  set local role service_role;
  -- a wrong store_id / product_size_id on purpose: the trigger must copy the right ones from the offer
  insert into public.store_catalog_best_sellers(store_product_id, store_id, product_size_id, units_sold) values
    (o1a, sb, z7, 3), (o2a, sa, z2, 4), (o2b, sb, z2, 3), (o3b, sb, z3, 7), (o4a, sa, z4, 1), (o5a, sa, z5, 999);
  insert into public.store_catalog_most_viewed(store_product_id, store_id, product_size_id, views_count) values
    (o1a, sa, z1, 5), (o2a, sa, z2, 600), (o2b, sb, z2, 400), (o3b, sb, z3, 50), (o4c, sc, z4, 9999), (o7c, sc, z7, 5000);
  insert into public.store_catalog_most_searched(store_product_id, store_id, product_size_id, searches_count) values (o3b, sb, z3, 4);
  insert into public.store_catalog_ratings(store_product_id, store_id, product_size_id, average_rating, ratings_count) values
    (o2a, sa, z2, 4.80, 5), (o2b, sb, z2, 5.00, 5),       -- P2: with the customers' (5,5) weighted 4.92 over 12 ratings
    (o3b, sb, z3, 5.00, 2),                                 -- P3: only 2 ratings -> does not qualify
    (o1a, sa, z1, 1.00, 50);                                -- P1: a bad store rating weighs 50 ratings against the customers' 3
  reset role;

  -- the trigger copied store_id / product_size_id from the offer
  select store_id, product_size_id into a from public.store_catalog_best_sellers where store_product_id = o1a;
  if a.store_id is distinct from sa or a.product_size_id is distinct from z1 then
    raise exception 'store_id/product_size_id must come from the offer (got % / %)', a.store_id, a.product_size_id;
  end if;
  v_denied := false;
  begin set local role service_role; insert into public.store_catalog_best_sellers(store_product_id, units_sold) values (gen_random_uuid(), 1);
  exception when foreign_key_violation then v_denied := true; end;
  reset role;
  if not v_denied then raise exception 'a row for a store offer that does not exist must be refused'; end if;

  ---------------------------------------------------------------- the rankings (read from the final table, refreshed by the 5-minute job)
  perform private.refresh_product_stats();
  select * into a from private.fn_storefront_product_rankings() where product_id = p1;
  select * into b from private.fn_storefront_product_rankings() where product_id = p2;
  select * into c from private.fn_storefront_product_rankings() where product_id = p3;
  select * into d from private.fn_storefront_product_rankings() where product_id = p4;
  select count(*) into n from private.fn_storefront_product_rankings() where product_id in (p5, p6, p7);
  if n <> 0 then raise exception 'perfumes that are not offered right now (out of stock / inactive store) or have no figure must not be ranked (% rows)', n; end if;

  -- SALES (final = round((customers + stores) / 2)): P2 and P3 store 7 -> 4 and tie; P4 customers 2 + store 1 -> 2 combined;
  -- P1 store 3 -> 2 (the same total 3 as P4, so the same rank)
  if d.sales_source is distinct from 'combined' or b.sales_source is distinct from 'store_catalog' or c.sales_source is distinct from 'store_catalog'
     or a.sales_source is distinct from 'store_catalog' then
    raise exception 'sales sources wrong: P4 %, P2 %, P3 %, P1 %', d.sales_source, b.sales_source, c.sales_source, a.sales_source; end if;
  if not (b.sales_rank = c.sales_rank and b.sales_rank < d.sales_rank and d.sales_rank = a.sales_rank) then
    raise exception 'sales ranks wrong: P2 %, P3 %, P4 %, P1 %', b.sales_rank, c.sales_rank, d.sales_rank, a.sales_rank; end if;

  -- VIEWS: P2 (stores 600+400 -> 500) above P3 (50 -> 25) above P1 (customers 3 + store 5 -> 4 combined); the inactive store's 9999 for P4 does not count
  if a.views_source is distinct from 'combined' or b.views_source is distinct from 'store_catalog' or c.views_source is distinct from 'store_catalog' then
    raise exception 'views sources wrong: P1 %, P2 %, P3 %', a.views_source, b.views_source, c.views_source; end if;
  if not (b.views_rank < c.views_rank and c.views_rank < a.views_rank) then
    raise exception 'views ranks wrong: P2 %, P3 %, P1 %', b.views_rank, c.views_rank, a.views_rank; end if;
  if d.views_rank is not null then raise exception 'views of an inactive store must be ignored (P4 rank %)', d.views_rank; end if;

  -- SEARCHES: only P3 has a (store) figure
  if c.searches_rank is null or c.searches_source is distinct from 'store_catalog' or a.searches_rank is not null or b.searches_rank is not null or d.searches_rank is not null then
    raise exception 'searches wrong: P3 % (%), P1 %, P2 %, P4 %', c.searches_rank, c.searches_source, a.searches_rank, b.searches_rank, d.searches_rank; end if;

  -- RATING: P2 (customers' 5,5 + stores' 4.80 x 5 and 5.00 x 5 = 4.92 over 12) above P4 (customers 3.00) above P1 (customers 4,5,5 + a store's 1.00 x 50 = 1.21 over 53); P3 (2 ratings) none
  if a.rating_source is distinct from 'combined' or d.rating_source is distinct from 'customers' or b.rating_source is distinct from 'combined' then
    raise exception 'rating sources wrong: P1 %, P4 %, P2 %', a.rating_source, d.rating_source, b.rating_source; end if;
  if not (b.rating_rank < d.rating_rank and d.rating_rank < a.rating_rank) then
    raise exception 'rating ranks wrong: P2 %, P4 %, P1 % (best final rating first)', b.rating_rank, d.rating_rank, a.rating_rank; end if;
  if c.rating_rank is not null then raise exception 'a rating from fewer than 3 ratings must not qualify (P3 rank %)', c.rating_rank; end if;

  ---------------------------------------------------------------- what the storefront (anon) sees
  set local role anon;
  select * into e from public.storefront_product_rankings where product_id = p1;
  if e.sales_rank is distinct from a.sales_rank or e.views_rank is distinct from a.views_rank or e.rating_rank is distinct from a.rating_rank then
    raise exception 'anon sees different ranks than the function'; end if;
  select count(*) into n from public.storefront_product_rankings where product_id in (p5, p6, p7);
  if n <> 0 then raise exception 'anon sees a perfume that is not offered'; end if;
  if (select string_agg(attname, ',' order by attnum) from pg_attribute where attrelid = 'public.storefront_product_rankings'::regclass and attnum > 0 and not attisdropped)
     is distinct from 'product_id,sales_rank,sales_source,views_rank,views_source,searches_rank,searches_source,rating_rank,rating_source' then
    raise exception 'the view must expose only the product id, the four ranks and their sources'; end if;
  v_denied := false; begin perform 1 from public.store_catalog_best_sellers limit 1; exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'anon can read store_catalog_best_sellers'; end if;
  v_denied := false; begin perform 1 from public.store_catalog_most_viewed limit 1; exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'anon can read store_catalog_most_viewed'; end if;
  v_denied := false; begin perform 1 from public.store_catalog_most_searched limit 1; exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'anon can read store_catalog_most_searched'; end if;
  v_denied := false; begin perform 1 from public.store_catalog_ratings limit 1; exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'anon can read store_catalog_ratings'; end if;
  reset role;

  ---------------------------------------------------------------- who can read / write the store tables
  -- a signed-in customer (not a store member) sees nothing; a store member sees only his own store's rows; the platform admin sees all
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', u_other::text, true);
  select count(*) into n from public.store_catalog_best_sellers where store_product_id in (o1a, o2a, o2b, o3b, o4a, o5a);
  if n <> 0 then raise exception 'a customer reads % store rows', n; end if;
  perform set_config('request.jwt.claim.sub', u_member::text, true);
  select count(*) into n from public.store_catalog_best_sellers where store_product_id in (o1a, o2a, o2b, o3b, o4a, o5a);
  if n <> 4 then raise exception 'the member of store A must read exactly store A rows (o1a, o2a, o4a, o5a) but reads %', n; end if;
  select count(*) into n from public.store_catalog_most_viewed where store_id = sb;
  if n <> 0 then raise exception 'the member of store A reads store B''s views'; end if;
  perform set_config('request.jwt.claim.sub', u_admin::text, true);
  select count(*) into n from public.store_catalog_best_sellers where store_product_id in (o1a, o2a, o2b, o3b, o4a, o5a);
  if n <> 6 then raise exception 'the platform admin must read all 6 rows but reads %', n; end if;
  -- nobody can write through the API: not the member, not even the admin
  foreach v_ok in array array[true, false] loop
    perform set_config('request.jwt.claim.sub', (case when v_ok then u_member else u_admin end)::text, true);
    v_denied := false; begin insert into public.store_catalog_best_sellers(store_product_id, units_sold) values (o3b, 1) on conflict do nothing; exception when insufficient_privilege then v_denied := true; end;
    if not v_denied then raise exception 'a signed-in user could insert a store ranking row'; end if;
    v_denied := false; begin update public.store_catalog_best_sellers set units_sold = 999999 where store_product_id = o1a; exception when insufficient_privilege then v_denied := true; end;
    if not v_denied then raise exception 'a signed-in user could update a store ranking row'; end if;
    v_denied := false; begin delete from public.store_catalog_ratings where store_product_id = o1a; exception when insufficient_privilege then v_denied := true; end;
    if not v_denied then raise exception 'a signed-in user could delete a store ranking row'; end if;
  end loop;
  reset role;

  ---------------------------------------------------------------- nothing leaks into the public API
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('fn_storefront_product_rankings', 'store_ranking_sync_keys')) then
    raise exception 'ranking helpers must live in the private schema (a public one would become a client RPC)'; end if;
  if not exists (select 1 from pg_class where oid = 'public.storefront_product_rankings'::regclass and reloptions @> array['security_invoker=true']) then
    raise exception 'storefront_product_rankings must stay a security_invoker view'; end if;
  if not has_function_privilege('anon', 'private.fn_storefront_product_rankings()', 'execute') or not has_function_privilege('authenticated', 'private.fn_storefront_product_rankings()', 'execute') then
    raise exception 'anon/authenticated must keep EXECUTE on the ranking function (the security_invoker view runs it with their rights)'; end if;
  if has_function_privilege('anon', 'private.store_ranking_sync_keys()', 'execute') then raise exception 'the key-sync trigger function must not be executable by anon'; end if;
end;
$fixture$;

rollback;
