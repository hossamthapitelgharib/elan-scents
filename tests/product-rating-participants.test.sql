-- Real-database test for supabase/migrations/20261111122138_product_rating_participants_mean.sql.
-- Run AFTER the migration, as the project owner, inside one transaction. Every fixture is synthetic (example.invalid users,
-- fixture stores / brand / perfumes) and everything is rolled back at the end.
--
-- Proves the owner's rating design of 2026-11-10:
--   * participants = the customers (>= 1 approved review) and every ACTIVE store with >= 1 rating for the perfume;
--     an inactive store, and a store without a rating for the perfume, are not participants;
--   * count = round((customers' ratings + all stores' ratings) / 2), stars = plain mean of the participants' own averages
--     (divisor = number of participants), no minimum for either; nobody rated -> no count and no stars;
--   * the owner's three examples: x -> 305 / 4.00, y -> 310 / 3.33, z -> 320 / 2.67 (customers 10/20/40 at 5 stars, store A
--     100 at 4/3/2, store B 500 at 3/2/1, store C nothing);
--   * «الأكثر تقييمًا» (storefront_product_rankings.rating_rank) needs BOTH one participant with >= 3 ratings AND stored stars
--     >= 3.00; it orders by stars, then by count; ties share a rank; a perfume outside it still shows count + stars;
--   * a store's several sizes of one perfume are ONE participant;
--   * the new column rating_top_source_count is tied to the rating by a check, and a review moves the figures at once.
begin;

create function pg_temp.fx_rp_size(p_brand uuid, p_tag text) returns uuid language plpgsql as $f$
declare v_product uuid; v_size uuid;
begin
  insert into public.products(brand_id, name, slug, short_description, official_description, gender, notes_source, content_source, status, is_active)
  values (p_brand, 'Rating fixture ' || p_tag, 'rp-' || p_tag, 'fixture', 'fixture', 'unisex', 'store_catalog', 'rating_participants_fixture', 'published', true) returning id into v_product;
  insert into public.product_sizes(product_id, size_ml, size_label, sku) values (v_product, 50, '50 ml', 'RP-' || p_tag) returning id into v_size;
  return v_size;
end $f$;

create function pg_temp.fx_rp_offer(p_store uuid, p_size uuid) returns uuid language plpgsql as $f$
declare v_offer uuid;
begin
  insert into public.store_products(store_id, product_size_id, price, original_price, stock_quantity, is_available, currency, data_source, sync_status, product_url)
  values (p_store, p_size, 100, 120, 100, true, 'EGP', 'store_catalog', 'synced', 'https://example.invalid/rating-participants-fixture') returning id into v_offer;
  return v_offer;
end $f$;

-- store rating helper: one row per (store offer), written the way the ingestion writes it
create function pg_temp.fx_rp_rate(p_offer uuid, p_store uuid, p_size uuid, p_avg numeric, p_n integer) returns void language plpgsql as $f$
begin
  set local role service_role;
  insert into public.store_catalog_ratings(store_product_id, store_id, product_size_id, average_rating, ratings_count) values (p_offer, p_store, p_size, p_avg, p_n);
  reset role;
end $f$;

do $fixture$
declare
  v_tag text := replace(gen_random_uuid()::text, '-', '');
  v_brand uuid; sa uuid; sb uuid; sc uuid; sd uuid;
  users uuid[] := array(select gen_random_uuid() from generate_series(1, 40));
  zx uuid; zy uuid; zz uuid; zg uuid; zh uuid; zk uuid; zn uuid; zm uuid; zm2 uuid; zm3 uuid; zt1 uuid; zt2 uuid; zw1 uuid; zw2 uuid;
  px uuid; py uuid; pz uuid; pg uuid; ph uuid; pk uuid; pn uuid; pm uuid; pm2 uuid; pm3 uuid; pt1 uuid; pt2 uuid; pw uuid;
  a record; v_denied boolean;
  r_x integer; r_y integer; r_w integer; r_t1 integer; r_t2 integer; r_m3 integer; r_m2 integer;
begin
  insert into public.stores(name, slug, status) values ('Rating fixture A', 'rp-a-' || v_tag, 'active') returning id into sa;
  insert into public.stores(name, slug, status) values ('Rating fixture B', 'rp-b-' || v_tag, 'active') returning id into sb;
  insert into public.stores(name, slug, status) values ('Rating fixture C', 'rp-c-' || v_tag, 'active') returning id into sc;
  insert into public.stores(name, slug, status) values ('Rating fixture D', 'rp-d-' || v_tag, 'inactive') returning id into sd;
  insert into auth.users (id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, email_confirmed_at, created_at, updated_at)
  select x, 'authenticated', 'authenticated', 'fixture-' || x::text || '@example.invalid', '', '{}'::jsonb, '{"full_name":"rating-fixture"}'::jsonb, now(), now(), now()
    from unnest(users) x;
  insert into public.profiles(id, role) select x, 'customer' from unnest(users) x on conflict (id) do update set role = 'customer';
  insert into public.brands(name, slug, is_active) values ('Rating brand ' || v_tag, 'rp-brand-' || v_tag, true) returning id into v_brand;

  zx := pg_temp.fx_rp_size(v_brand, 'x-' || v_tag);   zy := pg_temp.fx_rp_size(v_brand, 'y-' || v_tag);   zz := pg_temp.fx_rp_size(v_brand, 'z-' || v_tag);
  zg := pg_temp.fx_rp_size(v_brand, 'g-' || v_tag);   zh := pg_temp.fx_rp_size(v_brand, 'h-' || v_tag);   zk := pg_temp.fx_rp_size(v_brand, 'k-' || v_tag);
  zn := pg_temp.fx_rp_size(v_brand, 'n-' || v_tag);   zm := pg_temp.fx_rp_size(v_brand, 'm-' || v_tag);   zm2 := pg_temp.fx_rp_size(v_brand, 'm2-' || v_tag);
  zm3 := pg_temp.fx_rp_size(v_brand, 'm3-' || v_tag); zt1 := pg_temp.fx_rp_size(v_brand, 't1-' || v_tag); zt2 := pg_temp.fx_rp_size(v_brand, 't2-' || v_tag);
  zw1 := pg_temp.fx_rp_size(v_brand, 'w-' || v_tag);
  select product_id into px from public.product_sizes where id = zx;   select product_id into py from public.product_sizes where id = zy;
  select product_id into pz from public.product_sizes where id = zz;   select product_id into pg from public.product_sizes where id = zg;
  select product_id into ph from public.product_sizes where id = zh;   select product_id into pk from public.product_sizes where id = zk;
  select product_id into pn from public.product_sizes where id = zn;   select product_id into pm from public.product_sizes where id = zm;
  select product_id into pm2 from public.product_sizes where id = zm2; select product_id into pm3 from public.product_sizes where id = zm3;
  select product_id into pt1 from public.product_sizes where id = zt1; select product_id into pt2 from public.product_sizes where id = zt2;
  select product_id into pw from public.product_sizes where id = zw1;
  insert into public.product_sizes(product_id, size_ml, size_label, sku) values (pw, 100, '100 ml', 'RP-W2-' || v_tag) returning id into zw2;

  ---------------------------------------------------------------- 1. the owner's three examples
  -- x: customers 10 x 5, store A 100 x 4.00, store B 500 x 3.00, store C has the perfume but no rating, store D (inactive) 1000 x 1.00
  perform pg_temp.fx_rp_offer(sc, zx);
  insert into public.reviews(user_id, product_id, rating, is_approved) select users[i], px, 5, true from generate_series(1, 10) i;
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sa, zx), sa, zx, 4.00, 100);
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sb, zx), sb, zx, 3.00, 500);
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sd, zx), sd, zx, 1.00, 1000);
  -- y: customers 20 x 5, A 100 x 3, B 500 x 2          z: customers 40 x 5, A 100 x 2, B 500 x 1
  insert into public.reviews(user_id, product_id, rating, is_approved) select users[i], py, 5, true from generate_series(1, 20) i;
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sa, zy), sa, zy, 3.00, 100);
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sb, zy), sb, zy, 2.00, 500);
  insert into public.reviews(user_id, product_id, rating, is_approved) select users[i], pz, 5, true from generate_series(1, 40) i;
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sa, zz), sa, zz, 2.00, 100);
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sb, zz), sb, zz, 1.00, 500);
  perform private.refresh_product_stats();

  select average_rating, reviews_count, rating_top_source_count, rating_source into a from public.product_stats where product_id = px;
  if a.average_rating is distinct from 4.00 or a.reviews_count <> 305 or a.rating_top_source_count <> 500 or a.rating_source <> 'combined' then
    raise exception 'x: (5 + 4 + 3) / 3 = 4.00 stars, (10 + 100 + 500) / 2 = 305 ratings, biggest participant 500, combined; got % / % / % / %', a.average_rating, a.reviews_count, a.rating_top_source_count, a.rating_source; end if;
  select average_rating, reviews_count, rating_top_source_count into a from public.product_stats where product_id = py;
  if a.average_rating is distinct from 3.33 or a.reviews_count <> 310 or a.rating_top_source_count <> 500 then
    raise exception 'y: (5 + 3 + 2) / 3 = 3.33 stars, (20 + 100 + 500) / 2 = 310 ratings; got % / %', a.average_rating, a.reviews_count; end if;
  select average_rating, reviews_count, rating_top_source_count into a from public.product_stats where product_id = pz;
  if a.average_rating is distinct from 2.67 or a.reviews_count <> 320 then
    raise exception 'z: (5 + 2 + 1) / 3 = 2.67 stars, (40 + 100 + 500) / 2 = 320 ratings; got % / %', a.average_rating, a.reviews_count; end if;

  -- the card and the page read these numbers (the count together with the stars, whatever the ranking says)
  select average_rating, reviews_count into a from public.public_products where id = pz;
  if a.average_rating is distinct from 2.67 or a.reviews_count <> 320 then raise exception 'z shows 2.67 stars and 320 ratings on its page even outside the ranking, got %', a; end if;

  ---------------------------------------------------------------- 2. no minimum for the figures; nobody rated -> nothing shown
  -- g: only store A, 1000 ratings at 2.90 stars -> shown, but below 3.00
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sa, zg), sa, zg, 2.90, 1000);
  -- h: one customer, one 5-star review -> shown (count round(1 / 2) = 1), never ranked
  perform pg_temp.fx_rp_offer(sa, zh);
  insert into public.reviews(user_id, product_id, rating, is_approved) values (users[1], ph, 5, true);
  -- k: customers 2 x 5 and store A 2 x 5 -> four ratings in all, but nobody has 3 -> not ranked
  insert into public.reviews(user_id, product_id, rating, is_approved) values (users[1], pk, 5, true), (users[2], pk, 5, true);
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sa, zk), sa, zk, 5.00, 2);
  -- n: nobody rated it
  perform pg_temp.fx_rp_offer(sa, zn);
  perform private.refresh_product_stats();

  select average_rating, reviews_count into a from public.public_products where id = pg;
  if a.average_rating is distinct from 2.90 or a.reviews_count <> 500 then raise exception 'g: 2.90 stars and 500 ratings from the store alone, got %', a; end if;
  if (select rating_source from public.product_stats where product_id = pg) <> 'store_catalog' then raise exception 'g: the rating comes from the store alone'; end if;
  select average_rating, reviews_count, rating_top_source_count, rating_source into a from public.product_stats where product_id = ph;
  if a.average_rating is distinct from 5.00 or a.reviews_count <> 1 or a.rating_top_source_count <> 1 or a.rating_source <> 'customers' then
    raise exception 'h: one 5-star review is shown as 5.00 stars / 1 rating (round(1 / 2)), got %', a; end if;
  select average_rating, reviews_count, rating_top_source_count, rating_source into a from public.product_stats where product_id = pk;
  if a.average_rating is distinct from 5.00 or a.reviews_count <> 2 or a.rating_top_source_count <> 2 or a.rating_source <> 'combined' then
    raise exception 'k: 5.00 stars, round(4 / 2) = 2 ratings, biggest participant 2, combined; got %', a; end if;
  select average_rating, reviews_count into a from public.public_products where id = pn;
  if a.average_rating is not null or a.reviews_count is not null then raise exception 'n: nobody rated it -> no count and no stars, got %', a; end if;
  select average_rating, reviews_count, rating_top_source_count, rating_source into a from public.product_stats where product_id = pn;
  if a.average_rating is not null or a.reviews_count <> 0 or a.rating_top_source_count <> 0 or a.rating_source is not null then raise exception 'n: the table holds no rating, got %', a; end if;

  ---------------------------------------------------------------- 3. the shape: the new column is tied to the rating
  v_denied := false; begin update public.product_stats set rating_top_source_count = 0 where product_id = px; exception when check_violation then v_denied := true; end;
  if not v_denied then raise exception 'a rating without its biggest participant must be refused'; end if;
  v_denied := false; begin update public.product_stats set rating_top_source_count = 4 where product_id = pn; exception when check_violation then v_denied := true; end;
  if not v_denied then raise exception 'a participant count without a rating must be refused'; end if;
  v_denied := false; begin update public.product_stats set rating_top_source_count = -1 where product_id = pn; exception when check_violation then v_denied := true; end;
  if not v_denied then raise exception 'a negative count must be refused'; end if;
  -- a hand edit is written over by the next refresh, like the other figures
  update public.product_stats set average_rating = 1.00 where product_id = px;
  perform private.refresh_product_stats();
  if (select average_rating from public.product_stats where product_id = px) is distinct from 4.00 then raise exception 'a hand-edited rating must be overwritten'; end if;
  if private.refresh_product_stats(array[px, py, pz, pg, ph, pk, pn]) <> 0 then raise exception 'a refresh with nothing new must write no row'; end if;

  ---------------------------------------------------------------- 4. «الأكثر تقييمًا»: one participant with >= 3 ratings AND stars >= 3.00
  -- m: A 3 x 2.98, B 3 x 3.00 -> mean 2.99 (top 3): stays OUT, 2.99 is not rounded up to 3
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sa, zm), sa, zm, 2.98, 3);
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sb, zm), sb, zm, 3.00, 3);
  -- m2: A 3 x 3.00 -> exactly 3.00 (top 3, count round(3 / 2) = 2): IN
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sa, zm2), sa, zm2, 3.00, 3);
  -- m3: A 3 x 2.99, B 3 x 3.00 -> mean 2.995 is STORED as 3.00 (2 decimals), count 3: IN, ahead of m2 on the count
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sa, zm3), sa, zm3, 2.99, 3);
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sb, zm3), sb, zm3, 3.00, 3);
  -- t1, t2: identical (A 4 x 3.50) -> share a rank
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sa, zt1), sa, zt1, 3.50, 4);
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sa, zt2), sa, zt2, 3.50, 4);
  -- w: store A on two sizes of ONE perfume (10 x 5.00 and 10 x 3.00) is ONE participant: 4.00 stars, 20 ratings -> count 10
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sa, zw1), sa, zw1, 5.00, 10);
  perform pg_temp.fx_rp_rate(pg_temp.fx_rp_offer(sa, zw2), sa, zw2, 3.00, 10);
  perform private.refresh_product_stats();

  select average_rating, reviews_count, rating_top_source_count into a from public.product_stats where product_id = pm;
  if a.average_rating is distinct from 2.99 or a.reviews_count <> 3 or a.rating_top_source_count <> 3 then raise exception 'm: mean 2.99 / count 3, got %', a; end if;
  select average_rating, reviews_count into a from public.product_stats where product_id = pm3;
  if a.average_rating is distinct from 3.00 then raise exception 'm3: 2.995 is stored as 3.00 (two decimals, half up), got %', a.average_rating; end if;
  select average_rating, reviews_count, rating_top_source_count, rating_source into a from public.product_stats where product_id = pw;
  if a.average_rating is distinct from 4.00 or a.reviews_count <> 10 or a.rating_top_source_count <> 20 or a.rating_source <> 'store_catalog' then
    raise exception 'w: one store with two sizes is ONE participant: 4.00 stars, 20 ratings / 2 = 10, biggest 20; got %', a; end if;

  -- who is ranked
  if exists (select 1 from public.storefront_product_rankings where rating_rank is null and rating_source is not null) then raise exception 'a rating source without a rank'; end if;
  if exists (select 1 from public.storefront_product_rankings where product_id in (pz, pg, ph, pk, pn, pm) and (rating_rank is not null or rating_source is not null)) then
    raise exception 'z (2.67), g (2.90), h (one rating), k (nobody has 3), n (no rating) and m (2.99) must not be in the most-rated ranking'; end if;
  if exists (select 1 from public.storefront_product_rankings where product_id in (px, py, pw, pm2, pm3, pt1, pt2) and rating_rank is null) then
    raise exception 'x, y, w, m2, m3, t1 and t2 must be ranked'; end if;
  -- the perfumes outside the ranking do not need a row there at all; they still show on their pages
  select average_rating, reviews_count into a from public.public_products where id = pm;
  if a.average_rating is distinct from 2.99 or a.reviews_count <> 3 then raise exception 'm shows 2.99 stars and 3 ratings on its page, got %', a; end if;
  select rating_source into a from public.storefront_product_rankings where product_id = px;
  if a.rating_source <> 'combined' then raise exception 'the ranking carries the source of the rating, got %', a.rating_source; end if;

  -- the order: stars first, then the count; ties share a rank
  select rating_rank into r_x from public.storefront_product_rankings where product_id = px;
  select rating_rank into r_w from public.storefront_product_rankings where product_id = pw;
  select rating_rank into r_t1 from public.storefront_product_rankings where product_id = pt1;
  select rating_rank into r_t2 from public.storefront_product_rankings where product_id = pt2;
  select rating_rank into r_y from public.storefront_product_rankings where product_id = py;
  select rating_rank into r_m3 from public.storefront_product_rankings where product_id = pm3;
  select rating_rank into r_m2 from public.storefront_product_rankings where product_id = pm2;
  if not (r_x < r_w) then raise exception 'x and w both have 4.00 stars: the bigger count (305 > 10) ranks first (% vs %)', r_x, r_w; end if;
  if not (r_w < r_t1) then raise exception 'w (4.00) ranks above t1 (3.50)'; end if;
  if r_t1 is distinct from r_t2 then raise exception 'identical stars and count share a rank (% vs %)', r_t1, r_t2; end if;
  if not (r_t1 < r_y) then raise exception 't1 (3.50) ranks above y (3.33)'; end if;
  if not (r_y < r_m3) then raise exception 'y (3.33) ranks above m3 (3.00)'; end if;
  if not (r_m3 < r_m2) then raise exception 'm3 and m2 have 3.00 stars: the bigger count (3 > 2) ranks first (% vs %)', r_m3, r_m2; end if;

  ---------------------------------------------------------------- 5. a review moves the figures at once (the review trigger)
  -- h: one review shown; two more approved reviews make three at one participant (customers) and 3.67 stars -> ranked now
  insert into public.reviews(user_id, product_id, rating, is_approved) values (users[2], ph, 3, true);
  select average_rating, reviews_count, rating_top_source_count into a from public.product_stats where product_id = ph;
  if a.average_rating is distinct from 4.00 or a.reviews_count <> 1 or a.rating_top_source_count <> 2 then raise exception 'h after the second review: 4.00 stars, round(2 / 2) = 1, top 2; got %', a; end if;
  if (select rating_rank from public.storefront_product_rankings where product_id = ph) is not null then raise exception 'h with two reviews is still not ranked'; end if;
  insert into public.reviews(user_id, product_id, rating, is_approved) values (users[3], ph, 3, true), (users[4], ph, 1, false);
  select average_rating, reviews_count, rating_top_source_count into a from public.product_stats where product_id = ph;
  if a.average_rating is distinct from 3.67 or a.reviews_count <> 2 or a.rating_top_source_count <> 3 then raise exception 'h after the third approved review (the unapproved one ignored): 3.67 stars, round(3 / 2) = 2, top 3; got %', a; end if;
  if (select rating_rank from public.storefront_product_rankings where product_id = ph) is null then raise exception 'h with three approved reviews at 3.67 stars must be ranked at once'; end if;
  delete from public.reviews where product_id = ph;
  select average_rating, reviews_count, rating_top_source_count, rating_source into a from public.product_stats where product_id = ph;
  if a.average_rating is not null or a.reviews_count <> 0 or a.rating_top_source_count <> 0 or a.rating_source is not null then raise exception 'h without reviews: nothing shown, got %', a; end if;

  -- an inactive store never counts, even when it is the only one; switching a store on and off moves the figures
  update public.stores set status = 'inactive' where id = sb;
  perform private.refresh_product_stats();
  select average_rating, reviews_count into a from public.product_stats where product_id = px;
  if a.average_rating is distinct from 4.50 or a.reviews_count <> 55 then raise exception 'x without store B: (5 + 4) / 2 = 4.50 stars, (10 + 100) / 2 = 55 ratings; got %', a; end if;
  update public.stores set status = 'active' where id = sb;
  perform private.refresh_product_stats();
  if (select average_rating from public.product_stats where product_id = px) is distinct from 4.00 then raise exception 'x is back to 4.00 with store B active again'; end if;

  ---------------------------------------------------------------- 6. access
  if not has_function_privilege('anon', 'private.fn_product_rating_sources()', 'execute') or not has_function_privilege('service_role', 'private.fn_product_rating_sources()', 'execute') then
    raise exception 'the rating reader keeps the grants it had'; end if;
  if has_function_privilege('anon', 'private.refresh_product_stats(uuid[])', 'execute') or has_function_privilege('authenticated', 'private.refresh_product_ratings(uuid[])', 'execute') then
    raise exception 'the writers must not be executable by client roles'; end if;
end
$fixture$;

rollback;
