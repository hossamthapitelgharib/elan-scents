-- Real-database test for supabase/migrations/20261109060420_final_product_stats_table.sql
-- Run AFTER the migration, as the project owner, inside one transaction. Every fixture is synthetic (example.invalid users,
-- fixture stores / brand / perfumes) and everything is rolled back at the end.
--
-- Proves that public.product_stats is the FINAL, cumulative table:
--   * request_count is gone; every figure says its source and the table refuses a figure without (or a source without) one;
--   * the customers' figures are ALL TIME - a view from two years ago still counts;
--   * a stores' catalog figure is used only when the customers have none (never summed), inactive stores never count;
--   * retention (purge_expired_guest_fingerprints) folds a deleted browser's views and searches into the anonymous archive, so
--     the total does not drop; the archive is not readable by any client role; "forget me" leaves no trace on purpose;
--   * registering (claim) neither loses nor doubles a guest's views;
--   * a review changes the perfume's rating in the table at once, and the "at least 3 ratings" rule holds;
--   * a hand-edited figure is overwritten by the next refresh; nothing is written when nothing changed.
begin;

create function pg_temp.fx_fs_size(p_brand uuid, p_tag text) returns uuid language plpgsql as $f$
declare v_product uuid; v_size uuid;
begin
  insert into public.products(brand_id, name, slug, short_description, official_description, gender, notes_source, content_source, status, is_active)
  values (p_brand, 'Final stats fixture ' || p_tag, 'fs-' || p_tag, 'fixture', 'fixture', 'unisex', 'store_catalog', 'final_stats_fixture', 'published', true) returning id into v_product;
  insert into public.product_sizes(product_id, size_ml, size_label, sku) values (v_product, 50, '50 ml', 'FS-' || p_tag) returning id into v_size;
  return v_size;
end $f$;

create function pg_temp.fx_fs_offer(p_store uuid, p_size uuid) returns uuid language plpgsql as $f$
declare v_offer uuid;
begin
  insert into public.store_products(store_id, product_size_id, price, original_price, stock_quantity, is_available, currency, data_source, sync_status, product_url)
  values (p_store, p_size, 100, 120, 100, true, 'EGP', 'store_catalog', 'synced', 'https://example.invalid/final-stats-fixture') returning id into v_offer;
  return v_offer;
end $f$;

do $fixture$
declare
  v_tag text := replace(gen_random_uuid()::text, '-', '');
  v_brand uuid; sa uuid; sc uuid;
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid(); u_claim uuid := gen_random_uuid();
  z1 uuid; z2 uuid; z3 uuid; z4 uuid; p1 uuid; p2 uuid; p3 uuid; p4 uuid;
  o1 uuid; o2 uuid; o2c uuid; o4 uuid;
  sid uuid := gen_random_uuid(); sid_guest uuid := gen_random_uuid(); v_guest uuid;
  fp_claim text := repeat('7', 64); an_claim text := repeat('8', 64);
  a record; n integer; v_denied boolean; v_archive bigint; v_changed integer;
begin
  insert into public.stores(name, slug, status) values ('Final stats fixture A', 'fs-a-' || v_tag, 'active') returning id into sa;
  insert into public.stores(name, slug, status) values ('Final stats fixture C', 'fs-c-' || v_tag, 'inactive') returning id into sc;
  insert into auth.users (id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, email_confirmed_at, created_at, updated_at)
  select x, 'authenticated', 'authenticated', 'fixture-' || x::text || '@example.invalid', '', '{}'::jsonb, '{"full_name":"final-stats-fixture"}'::jsonb, now(), now(), now()
    from unnest(array[u1, u2, u3, u_claim]) x;
  insert into public.profiles(id, role) select x, 'customer' from unnest(array[u1, u2, u3, u_claim]) x on conflict (id) do update set role = 'customer';
  insert into public.brands(name, slug, is_active) values ('Final stats brand ' || v_tag, 'fs-brand-' || v_tag, true) returning id into v_brand;
  z1 := pg_temp.fx_fs_size(v_brand, 'p1-' || v_tag); z2 := pg_temp.fx_fs_size(v_brand, 'p2-' || v_tag);
  z3 := pg_temp.fx_fs_size(v_brand, 'p3-' || v_tag); z4 := pg_temp.fx_fs_size(v_brand, 'p4-' || v_tag);
  select product_id into p1 from public.product_sizes where id = z1; select product_id into p2 from public.product_sizes where id = z2;
  select product_id into p3 from public.product_sizes where id = z3; select product_id into p4 from public.product_sizes where id = z4;
  o1 := pg_temp.fx_fs_offer(sa, z1); o2 := pg_temp.fx_fs_offer(sa, z2); o2c := pg_temp.fx_fs_offer(sc, z2);
  perform pg_temp.fx_fs_offer(sa, z3); o4 := pg_temp.fx_fs_offer(sa, z4);

  ---------------------------------------------------------------- 1. the shape of the table
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'product_stats' and column_name = 'request_count') then
    raise exception 'request_count must be gone from product_stats';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'product_stats'
       and column_name in ('views_source', 'sales_source', 'search_source', 'rating_source')) <> 4 then
    raise exception 'product_stats must carry the source of every figure';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'product_stats' and column_name = 'distinctiveness_score') then
    raise exception 'distinctiveness_score must be left alone';
  end if;
  v_denied := false; begin update public.product_stats set views_count = 5 where product_id = p3; exception when check_violation then v_denied := true; end;
  if not v_denied then raise exception 'a figure without a source must be refused'; end if;
  v_denied := false; begin update public.product_stats set views_source = 'customers' where product_id = p3; exception when check_violation then v_denied := true; end;
  if not v_denied then raise exception 'a source without a figure must be refused'; end if;
  v_denied := false; begin update public.product_stats set views_count = 5, views_source = 'somebody' where product_id = p3; exception when check_violation then v_denied := true; end;
  if not v_denied then raise exception 'an unknown source must be refused'; end if;
  v_denied := false; begin update public.product_stats set average_rating = 4 where product_id = p3; exception when check_violation then v_denied := true; end;
  if not v_denied then raise exception 'a rating without a source must be refused'; end if;

  ---------------------------------------------------------------- 2. customers' figures are all time
  insert into public.customer_sessions (session_id, user_id) values (sid, u1);
  insert into public.customer_product_events (session_id, user_id, product_id, event_type, occurred_at) values
    (sid, u1, p1, 'view', now()), (sid, u1, p1, 'view', now() - interval '800 days'), (sid, u1, p1, 'search', now() - interval '700 days');
  insert into public.guest_product_analytics (visitor_hash, product_id, activity_date, event_type, event_count) values
    (repeat('b', 64), p1, current_date, 'view', 5),
    (repeat('c', 64), p1, current_date - 800, 'view', 100);                -- an old day of a browser that is still alive
  -- the stores also report figures for P1 and P2; P1's are ignored (the customers have numbers), P2's are used
  set local role service_role;
  insert into public.store_catalog_most_viewed(store_product_id, store_id, product_size_id, views_count) values (o1, sa, z1, 5000), (o2, sa, z2, 40), (o2c, sc, z2, 9999);
  insert into public.store_catalog_best_sellers(store_product_id, store_id, product_size_id, units_sold) values (o2, sa, z2, 6), (o2c, sc, z2, 9999);
  reset role;
  v_changed := private.refresh_product_stats();
  if v_changed < 2 then raise exception 'the first refresh must write the changed rows (wrote %)', v_changed; end if;

  select * into a from public.product_stats where product_id = p1;
  if a.views_count <> 107 or a.views_source <> 'customers' then
    raise exception 'P1 views: 5 + 100 guest + 2 registered (one from 2 years ago) = 107 from customers (the store 5000 must not be added), got % / %', a.views_count, a.views_source; end if;
  if a.search_count <> 1 or a.search_source <> 'customers' then raise exception 'P1 searches: the 700-day-old search still counts, got % / %', a.search_count, a.search_source; end if;
  if a.sales_count <> 0 or a.sales_source is not null then raise exception 'P1 has no sales from anybody, got % / %', a.sales_count, a.sales_source; end if;
  select * into a from public.product_stats where product_id = p2;
  if a.views_count <> 40 or a.views_source <> 'store_catalog' then raise exception 'P2 views come from the active store only (40), got % / %', a.views_count, a.views_source; end if;
  if a.sales_count <> 6 or a.sales_source <> 'store_catalog' then raise exception 'P2 sales come from the active store only (6), got % / %', a.sales_count, a.sales_source; end if;
  select * into a from public.product_stats where product_id = p3;
  if a.views_count <> 0 or a.views_source is not null or a.sales_count <> 0 or a.search_count <> 0 or a.average_rating is not null or a.reviews_count <> 0 or a.rating_source is not null then
    raise exception 'an untouched perfume must be all zeros with no source, got %', a; end if;

  -- nothing changed -> nothing is written (the realtime publication and the WAL stay quiet)
  if private.refresh_product_stats(array[p1, p2, p3, p4]) <> 0 then raise exception 'a refresh with nothing new must write no row'; end if;

  -- the cards and the rankings read this table
  select views_count, sales_count, search_count into a from public.public_products where id = p2;
  if a.views_count <> 40 or a.sales_count <> 6 then raise exception 'the card of P2 must show the final figures, got %', a; end if;
  select views_rank, views_source, sales_rank, sales_source into a from public.storefront_product_rankings where product_id = p2;
  if a.views_source <> 'store_catalog' or a.sales_source <> 'store_catalog' or a.views_rank is null then raise exception 'the ranking of P2 must read the final table: %', a; end if;
  if (select views_rank from public.storefront_product_rankings where product_id = p1) >= a.views_rank then
    raise exception 'customers-sourced views (P1, 107) rank above stores-sourced views (P2, 40)'; end if;

  -- a hand-edited figure is written over by the next refresh
  update public.product_stats set views_count = 999999, views_source = 'customers' where product_id = p2;
  perform private.refresh_product_stats();
  if (select views_count from public.product_stats where product_id = p2) <> 40 then raise exception 'a hand edit must be overwritten by the next refresh'; end if;

  ---------------------------------------------------------------- 3. retention keeps the total (P4)
  insert into public.guest_product_analytics (visitor_hash, product_id, activity_date, event_type, event_count, first_seen_at, last_seen_at) values
    (repeat('e', 64), p4, current_date - 600, 'view', 7, now() - interval '600 days', now() - interval '500 days'),    -- idle browsers: deleted by retention
    (repeat('e', 64), p4, current_date - 600, 'search', 3, now() - interval '600 days', now() - interval '500 days'),
    (repeat('d', 64), p4, current_date - 550, 'view', 5, now() - interval '550 days', now() - interval '480 days'),
    (repeat('f', 64), p4, current_date, 'view', 2, now(), now());                                                       -- an alive browser
  perform private.refresh_product_stats();
  select * into a from public.product_stats where product_id = p4;
  if a.views_count <> 14 or a.search_count <> 3 then raise exception 'P4 before retention: 7+5+2 views and 3 searches, got % / %', a.views_count, a.search_count; end if;

  perform public.purge_expired_guest_fingerprints();
  if exists (select 1 from public.guest_product_analytics where visitor_hash in (repeat('e', 64), repeat('d', 64))) then raise exception 'the idle browsers must be deleted'; end if;
  if not exists (select 1 from public.guest_product_analytics where visitor_hash = repeat('f', 64)) then raise exception 'the alive browser must stay'; end if;
  select event_count into v_archive from private.product_activity_archive where product_id = p4 and event_type = 'view';
  if v_archive is distinct from 12 then raise exception 'the archive must hold 12 views of P4 (7+5), got %', v_archive; end if;
  select event_count into v_archive from private.product_activity_archive where product_id = p4 and event_type = 'search';
  if v_archive is distinct from 3 then raise exception 'the archive must hold 3 searches of P4, got %', v_archive; end if;
  perform private.refresh_product_stats();
  select * into a from public.product_stats where product_id = p4;
  if a.views_count <> 14 or a.search_count <> 3 or a.views_source <> 'customers' then
    raise exception 'retention must not lower the total: P4 views 14 / searches 3, got % / %', a.views_count, a.search_count; end if;
  perform public.purge_expired_guest_fingerprints();
  if (select event_count from private.product_activity_archive where product_id = p4 and event_type = 'view') <> 12 then raise exception 'a second purge must not fold anything twice'; end if;
  -- the archive holds only perfumes and counts, and no client role can read it
  if exists (select 1 from information_schema.columns where table_schema = 'private' and table_name = 'product_activity_archive'
              and column_name not in ('product_id', 'event_type', 'event_count', 'updated_at')) then raise exception 'the archive must not hold a visitor'; end if;
  foreach n in array array[1, 2] loop
    v_denied := false;
    begin
      if n = 1 then set local role anon; else set local role authenticated; end if;
      perform 1 from private.product_activity_archive limit 1;
    exception when insufficient_privilege then v_denied := true; end;
    reset role;
    if not v_denied then raise exception 'a visitor / signed-in role can read the archive'; end if;
  end loop;
  -- deleting a perfume deletes its archive rows
  delete from public.store_products where product_size_id = z4;
  delete from public.product_sizes where id = z4;
  delete from public.products where id = p4;
  if exists (select 1 from private.product_activity_archive where product_id = p4) then raise exception 'archive rows must follow the deleted perfume'; end if;

  ---------------------------------------------------------------- 4. registering keeps the views, once
  perform public.resolve_guest_browser(fp_claim, an_claim);
  select id into v_guest from public.guest_visitors where fingerprint_hash = fp_claim;
  insert into public.customer_sessions (session_id, guest_id) values (sid_guest, v_guest);
  -- exactly what record_guest_product_activity writes: the detailed event AND the guest's counter, for each of 3 views of P3
  insert into public.customer_product_events (session_id, guest_id, product_id, event_type) values
    (sid_guest, v_guest, p3, 'view'), (sid_guest, v_guest, p3, 'view'), (sid_guest, v_guest, p3, 'view');
  insert into public.guest_product_analytics (visitor_hash, product_id, activity_date, event_type, event_count) values (an_claim, p3, current_date, 'view', 3);
  perform private.refresh_product_stats();
  if (select views_count from public.product_stats where product_id = p3) <> 3 then raise exception 'P3: the guest''s 3 views before registering'; end if;
  if not (public.claim_guest_browser_cart(fp_claim, an_claim, u_claim)->>'claimed')::boolean then raise exception 'the claim should succeed'; end if;
  perform private.refresh_product_stats();
  if (select views_count from public.product_stats where product_id = p3) <> 3 then
    raise exception 'registering must neither lose nor double the 3 views (got %)', (select views_count from public.product_stats where product_id = p3); end if;

  -- "forget me" removes the counters and leaves nothing behind (a deliberate decrease)
  insert into public.guest_product_analytics (visitor_hash, product_id, activity_date, event_type, event_count) values (repeat('6', 64), p3, current_date, 'view', 4);
  perform private.refresh_product_stats();
  if (select views_count from public.product_stats where product_id = p3) <> 7 then raise exception 'P3 before forgetting: 3 + 4'; end if;
  perform public.forget_guest_browser(repeat('5', 64), repeat('6', 64));
  perform private.refresh_product_stats();
  if (select views_count from public.product_stats where product_id = p3) <> 3 then raise exception 'a forgotten browser must leave the total (P3 should be 3 again)'; end if;
  if exists (select 1 from private.product_activity_archive where product_id = p3) then raise exception 'a forgotten browser must not be folded into the archive'; end if;

  ---------------------------------------------------------------- 5. the rating follows the reviews at once
  insert into public.reviews(user_id, product_id, rating, is_approved) values (u1, p1, 5, true), (u2, p1, 4, true);
  select average_rating, reviews_count, rating_source into a from public.product_stats where product_id = p1;
  if a.average_rating is not null or a.reviews_count <> 0 then raise exception 'two reviews are not a rating (got % / %)', a.average_rating, a.reviews_count; end if;
  insert into public.reviews(user_id, product_id, rating, is_approved) values (u3, p1, 3, true), (u_claim, p1, 1, false);
  select average_rating, reviews_count, rating_source into a from public.product_stats where product_id = p1;
  if a.average_rating is distinct from 4.00 or a.reviews_count <> 3 or a.rating_source <> 'customers' then
    raise exception 'three approved reviews (5,4,3) = 4.00 immediately, the unapproved one ignored; got % / % / %', a.average_rating, a.reviews_count, a.rating_source; end if;
  delete from public.reviews where user_id = u3 and product_id = p1;
  select average_rating, reviews_count, rating_source into a from public.product_stats where product_id = p1;
  if a.average_rating is not null or a.reviews_count <> 0 or a.rating_source is not null then raise exception 'back to two reviews: no rating (got %)', a; end if;

  ---------------------------------------------------------------- 6. who can run the writers
  foreach n in array array[1, 2] loop
    v_denied := false;
    begin
      if n = 1 then set local role anon; else set local role authenticated; end if;
      perform private.refresh_product_stats();
    exception when insufficient_privilege then v_denied := true; end;
    reset role;
    if not v_denied then raise exception 'a client role ran the refresh'; end if;
  end loop;
  if has_function_privilege('anon', 'private.refresh_product_stats(uuid[])', 'execute') or has_function_privilege('authenticated', 'private.refresh_product_ratings(uuid[])', 'execute') then
    raise exception 'the refresh writers must not be executable by client roles'; end if;
  if not exists (select 1 from cron.job where jobname = 'refresh-product-stats-5min' and schedule = '*/5 * * * *' and active) then
    raise exception 'the 5-minute refresh job must be scheduled'; end if;
end
$fixture$;

rollback;
