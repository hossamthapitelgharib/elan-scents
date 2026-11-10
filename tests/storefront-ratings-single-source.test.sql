-- Real-database test for supabase/migrations/20261108061117_storefront_ratings_single_source.sql (as changed by
-- 20261109060420_final_product_stats_table.sql: the card and the ranking read the final table public.product_stats, and by
-- 20261110060252_product_stats_mean_of_customers_and_stores.sql: the rating averages customers' and stores' ratings together).
-- Run AFTER the migrations, as the project owner, inside one transaction. Every fixture is synthetic (example.invalid users,
-- fixture stores / brand / perfumes) and everything is rolled back at the end.
--
-- Proves that a perfume's rating has ONE source:
--   * public.public_products.average_rating / reviews_count equal what private.fn_product_rating_sources() says, and that is
--     what the "most rated" ranking uses: every approved customer review and every rating of the active stores, weighted by how
--     many ratings stand behind each, from 3 together; fewer than 3 (or an unapproved review, or an inactive store) gives NULL -
--     never a rating built from one or two votes;
--   * the three columns nothing can back (request_count, distinctiveness_score, catalog_bestseller) are gone, so a
--     store-editable "bestseller" flag decides nothing about the storefront;
--   * public_products is still a security_invoker view that visitors read and nobody writes.
begin;

create function pg_temp.fx_rt_size(p_brand uuid, p_tag text) returns uuid language plpgsql as $f$
declare v_product uuid; v_size uuid;
begin
  insert into public.products(brand_id, name, slug, short_description, official_description, gender, notes_source, content_source, status, is_active)
  values (p_brand, 'Rating fixture ' || p_tag, 'rt-' || p_tag, 'fixture', 'fixture', 'unisex', 'store_catalog', 'rating_fixture', 'published', true) returning id into v_product;
  insert into public.product_sizes(product_id, size_ml, size_label, sku) values (v_product, 50, '50 ml', 'RT-' || p_tag) returning id into v_size;
  return v_size;
end $f$;

create function pg_temp.fx_rt_offer(p_store uuid, p_size uuid) returns uuid language plpgsql as $f$
declare v_offer uuid;
begin
  insert into public.store_products(store_id, product_size_id, price, original_price, stock_quantity, is_available, currency, data_source, sync_status, product_url)
  values (p_store, p_size, 100, 120, 100, true, 'EGP', 'store_catalog', 'synced', 'https://example.invalid/rating-fixture') returning id into v_offer;
  return v_offer;
end $f$;

do $fixture$
declare
  v_tag text := replace(gen_random_uuid()::text, '-', '');
  v_brand uuid; sa uuid; sb uuid; sc uuid;
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid(); u4 uuid := gen_random_uuid();
  z1 uuid; z2 uuid; z3 uuid; z4 uuid; z5 uuid; z6 uuid; z7 uuid;
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid; p6 uuid; p7 uuid;
  o1 uuid; o2a uuid; o2b uuid; o3 uuid; o4 uuid; o5 uuid; o5c uuid; o6 uuid; o7 uuid;
  a record; n integer; v_denied boolean; v_stats_before bigint; v_stats_after bigint;
begin
  select count(*) into v_stats_before from public.product_stats;

  insert into public.stores(name, slug, status) values ('Rating fixture A', 'rt-a-' || v_tag, 'active') returning id into sa;
  insert into public.stores(name, slug, status) values ('Rating fixture B', 'rt-b-' || v_tag, 'active') returning id into sb;
  insert into public.stores(name, slug, status) values ('Rating fixture C', 'rt-c-' || v_tag, 'inactive') returning id into sc;
  insert into auth.users (id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, email_confirmed_at, created_at, updated_at)
  select x, 'authenticated', 'authenticated', 'fixture-' || x::text || '@example.invalid', '', '{}'::jsonb, '{"full_name":"rating-fixture"}'::jsonb, now(), now(), now()
    from unnest(array[u1, u2, u3, u4]) x;
  insert into public.profiles(id, role) select x, 'customer' from unnest(array[u1, u2, u3, u4]) x on conflict (id) do nothing;
  insert into public.brands(name, slug, is_active) values ('Rating brand ' || v_tag, 'rt-brand-' || v_tag, true) returning id into v_brand;

  z1 := pg_temp.fx_rt_size(v_brand, 'p1-' || v_tag); z2 := pg_temp.fx_rt_size(v_brand, 'p2-' || v_tag); z3 := pg_temp.fx_rt_size(v_brand, 'p3-' || v_tag);
  z4 := pg_temp.fx_rt_size(v_brand, 'p4-' || v_tag); z5 := pg_temp.fx_rt_size(v_brand, 'p5-' || v_tag); z6 := pg_temp.fx_rt_size(v_brand, 'p6-' || v_tag);
  z7 := pg_temp.fx_rt_size(v_brand, 'p7-' || v_tag);
  select product_id into p1 from public.product_sizes where id = z1; select product_id into p2 from public.product_sizes where id = z2;
  select product_id into p3 from public.product_sizes where id = z3; select product_id into p4 from public.product_sizes where id = z4;
  select product_id into p5 from public.product_sizes where id = z5; select product_id into p6 from public.product_sizes where id = z6;
  select product_id into p7 from public.product_sizes where id = z7;
  o1 := pg_temp.fx_rt_offer(sa, z1); o2a := pg_temp.fx_rt_offer(sa, z2); o2b := pg_temp.fx_rt_offer(sb, z2); o3 := pg_temp.fx_rt_offer(sb, z3);
  o4 := pg_temp.fx_rt_offer(sa, z4); o5 := pg_temp.fx_rt_offer(sb, z5); o6 := pg_temp.fx_rt_offer(sa, z6); o7 := pg_temp.fx_rt_offer(sa, z7);

  -- P1: 3 approved (5,5,4) + 1 unapproved (1)  -> customers 4.67 over 3
  -- P2: 2 approved reviews (5,5) + its stores report 4.80x5 + 5.00x5 -> combined (10 + 24 + 25) / 12 = 4.92 over 12
  -- P3: 2 store ratings only -> no rating
  -- P4: 3 approved (3,3,3) -> customers 3.00 over 3
  -- P5: 3 store ratings at 4.00 -> store catalog 4.00 over 3 (the boundary), plus an inactive store's 5.00 x 50 that must not count
  -- P6: nothing, but its offer carries the store-editable "bestseller" flag
  -- P7: one approved five-star review only -> no rating (the old card showed five stars)
  insert into public.reviews(user_id, product_id, rating, is_approved) values
    (u1, p1, 5, true), (u2, p1, 5, true), (u3, p1, 4, true), (u4, p1, 1, false),
    (u1, p2, 5, true), (u2, p2, 5, true),
    (u1, p4, 3, true), (u2, p4, 3, true), (u3, p4, 3, true),
    (u1, p7, 5, true);
  insert into public.store_catalog_ratings(store_product_id, store_id, product_size_id, average_rating, ratings_count) values
    (o2a, sa, z2, 4.80, 5), (o2b, sb, z2, 5.00, 5), (o3, sb, z3, 5.00, 2), (o5, sb, z5, 4.00, 3);
  o5c := pg_temp.fx_rt_offer(sc, z5);                          -- the inactive store C also offers P5 and reports a glowing rating
  insert into public.store_catalog_ratings(store_product_id, store_id, product_size_id, average_rating, ratings_count) values (o5c, sc, z5, 5.00, 50);
  update public.store_products set is_catalog_bestseller = true where id = o6;
  -- the final table is refreshed by the 5-minute job; the review trigger already did the customers' ratings
  perform private.refresh_product_stats();

  ---------------------------------------------------------------- 1. the one function
  select * into a from private.fn_product_rating_sources() where product_id = p1;
  if a.average_rating is distinct from 4.67 or a.ratings_count <> 3 or a.rating_source <> 'customers' then
    raise exception 'P1 must be 4.67 over 3 customer reviews (the unapproved 1 does not count), got % / % / %', a.average_rating, a.ratings_count, a.rating_source;
  end if;
  select * into a from private.fn_product_rating_sources() where product_id = p2;
  if a.average_rating is distinct from 4.92 or a.ratings_count <> 12 or a.rating_source <> 'combined' then
    raise exception 'P2 must be 4.92 over 12 ratings (2 customer reviews + 10 store ratings, weighted), got % / % / %', a.average_rating, a.ratings_count, a.rating_source;
  end if;
  select * into a from private.fn_product_rating_sources() where product_id = p4;
  if a.average_rating is distinct from 3.00 or a.ratings_count <> 3 or a.rating_source <> 'customers' then raise exception 'P4 must be 3.00 over 3 customer reviews'; end if;
  select * into a from private.fn_product_rating_sources() where product_id = p5;
  if a.average_rating is distinct from 4.00 or a.ratings_count <> 3 or a.rating_source <> 'store_catalog' then
    raise exception 'P5 must be 4.00 over 3 (the inactive store does not count), got % / %', a.average_rating, a.ratings_count;
  end if;
  select count(*) into n from private.fn_product_rating_sources() where product_id in (p3, p6, p7);
  if n <> 0 then raise exception 'perfumes with fewer than 3 ratings must have none (got % rows)', n; end if;

  ---------------------------------------------------------------- 2. the card reads the same function
  set local role anon;
  select average_rating, reviews_count into a from public.public_products where id = p1;
  if a.average_rating is distinct from 4.67 or a.reviews_count is distinct from 3 then raise exception 'P1 on the card: % / %', a.average_rating, a.reviews_count; end if;
  select average_rating, reviews_count into a from public.public_products where id = p2;
  if a.average_rating is distinct from 4.92 or a.reviews_count is distinct from 12 then raise exception 'P2 on the card: % / %', a.average_rating, a.reviews_count; end if;
  select count(*) into n from public.public_products where id in (p3, p6, p7) and average_rating is null and reviews_count is null;
  if n <> 3 then raise exception 'P3 / P6 / P7 must be listed with no rating (got % of 3)', n; end if;
  reset role;

  ---------------------------------------------------------------- 3. the ranking uses the same figures: the best rating first, no matter which side it came from
  select count(*) into n from public.storefront_product_rankings where product_id in (p1, p2, p3, p4, p5, p6, p7) and rating_rank is not null;
  if n <> 4 then raise exception 'exactly P1, P2, P4, P5 are rated (got %)', n; end if;
  select r.rating_rank as r1, (select rating_rank from public.storefront_product_rankings where product_id = p4) as r4,
         (select rating_rank from public.storefront_product_rankings where product_id = p2) as r2,
         (select rating_rank from public.storefront_product_rankings where product_id = p5) as r5,
         r.rating_source as s1
    into a from public.storefront_product_rankings r where r.product_id = p1;
  if not (a.r2 < a.r1 and a.r1 < a.r5 and a.r5 < a.r4) then raise exception 'order must be P2 (4.92 combined), P1 (4.67 customers), P5 (4.00 stores), P4 (3.00 customers): %', a; end if;
  if a.s1 <> 'customers' then raise exception 'P1 source must be customers'; end if;
  if (select rating_source from public.storefront_product_rankings where product_id = p2) <> 'combined' then raise exception 'P2 source must be combined'; end if;
  if (select rating_source from public.storefront_product_rankings where product_id = p5) <> 'store_catalog' then raise exception 'P5 source must be store_catalog'; end if;
  -- a rank exists exactly where the card shows a rating
  select count(*) into n from public.storefront_product_rankings k join public.public_products pp on pp.id = k.product_id
   where (k.rating_rank is not null) <> (pp.average_rating is not null);
  if n <> 0 then raise exception 'the card and the ranking disagree for % perfumes', n; end if;
  -- the store-editable flag changes nothing
  if exists (select 1 from public.storefront_product_rankings where product_id = p6) then raise exception 'a bestseller flag must not rank a perfume'; end if;

  ---------------------------------------------------------------- 4. the removed columns and the view's safety
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'public_products'
              and column_name in ('request_count', 'distinctiveness_score', 'catalog_bestseller')) then
    raise exception 'request_count / distinctiveness_score / catalog_bestseller must be gone from public_products';
  end if;
  if not exists (select 1 from pg_class where oid = 'public.public_products'::regclass and reloptions @> array['security_invoker=true']) then
    raise exception 'public_products must stay a security_invoker view';
  end if;
  if not has_table_privilege('anon', 'public.public_products', 'select') or not has_table_privilege('authenticated', 'public.public_products', 'select') then
    raise exception 'visitors must read public_products';
  end if;
  if has_table_privilege('anon', 'public.public_products', 'insert') or has_table_privilege('authenticated', 'public.public_products', 'update')
     or has_table_privilege('authenticated', 'public.public_products', 'delete') then
    raise exception 'nobody writes through public_products';
  end if;
  v_denied := false;
  begin set local role anon; perform 1 from private.fn_product_rating_sources() limit 1; exception when insufficient_privilege then v_denied := true; end;
  reset role;
  if v_denied then raise exception 'the view runs as the caller, so the caller needs execute on the private rating function (like the activity function)'; end if;

  ---------------------------------------------------------------- 5. the final table holds the same ratings, each with its source
  select count(*) into v_stats_after from public.product_stats;
  if v_stats_after < v_stats_before then raise exception 'product_stats must keep its rows'; end if;
  select average_rating, reviews_count, rating_source into a from public.product_stats where product_id = p1;
  if a.average_rating is distinct from 4.67 or a.reviews_count <> 3 or a.rating_source <> 'customers' then raise exception 'product_stats P1: %', a; end if;
  select average_rating, reviews_count, rating_source into a from public.product_stats where product_id = p2;
  if a.average_rating is distinct from 4.92 or a.reviews_count <> 12 or a.rating_source <> 'combined' then raise exception 'product_stats P2: %', a; end if;
  select count(*) into n from public.product_stats where product_id in (p3, p6, p7) and average_rating is null and reviews_count = 0 and rating_source is null;
  if n <> 3 then raise exception 'product_stats must hold no rating for P3 / P6 / P7 (got % of 3)', n; end if;
end
$fixture$;

rollback;
