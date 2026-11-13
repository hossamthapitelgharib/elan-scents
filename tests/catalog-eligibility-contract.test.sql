-- Real-database test of the catalog ELIGIBILITY contract (migration 20261110081953_catalog_offer_stock_and_announcement_contract,
-- the owner's rules of 2026-11-12). Run on the live database as the project owner inside this one transaction; every fixture row is
-- synthetic and the final ROLLBACK discards all of it.
--
--   * a sale offer needs stock_quantity > 0: NULL (unconfirmed) and 0 are not eligible, whatever their price;
--   * the platform offer is the cheapest ELIGIBLE offer, one per size, each size on its own (50 ml and 100 ml never mix);
--   * a cheaper store that sells out hands the size to the next-cheapest eligible store; a cheaper store that merely has LESS
--     stock than a customer wants stays the offer (the move to a dearer store never happens because of the requested quantity);
--   * an inactive store, an unavailable or unsynced row, a coming-soon row, and a row without a price are never sale offers;
--   * «قريبًا» is a separate feed: no price column, no stock needed, only while the size has NO eligible sale offer,
--     and `stock_unknown` says whether the stock was never confirmed;
--   * the visitor (anon) and the signed-in customer read all of it.
begin;

create function pg_temp.must(ok boolean, msg text) returns void language plpgsql as $f$
begin
  if ok is not true then raise exception 'catalog eligibility contract: %', msg; end if;
end $f$;

do $test$
declare
  v_brand uuid := gen_random_uuid();
  v_product uuid := gen_random_uuid();
  v_s50 uuid := gen_random_uuid();
  v_s100 uuid := gen_random_uuid();
  v_soon uuid := gen_random_uuid();
  v_both uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();      -- Store A
  v_b uuid := gen_random_uuid();      -- Store B
  v_null uuid := gen_random_uuid();   -- reports no stock (NULL)
  v_stale uuid := gen_random_uuid();
  v_off uuid := gen_random_uuid();    -- inactive store
  v_c uuid := gen_random_uuid();      -- announces
  v_row record;
  v_anon_platform integer; v_anon_eligible integer; v_anon_soon integer; v_auth_platform integer; v_auth_soon integer;
  v_cols text;
begin
  insert into public.brands (id, name, slug) values (v_brand, 'Eligibility Contract', 'eligibility-contract-' || v_brand::text);
  insert into public.stores (id, name, slug, status, commission_rate, priority_rank) values
    (v_a, 'Eligibility A', 'elig-a-' || v_a::text, 'active', 15, 100),
    (v_b, 'Eligibility B', 'elig-b-' || v_b::text, 'active', 15, 100),
    (v_null, 'Eligibility NULL stock', 'elig-n-' || v_null::text, 'active', 15, 100),
    (v_stale, 'Eligibility stale', 'elig-s-' || v_stale::text, 'active', 15, 100),
    (v_off, 'Eligibility inactive', 'elig-o-' || v_off::text, 'inactive', 15, 100),
    (v_c, 'Eligibility announcer', 'elig-c-' || v_c::text, 'active', 15, 100);
  insert into public.products (id, brand_id, name, slug, gender, status, is_active)
    values (v_product, v_brand, 'Eligibility Perfume', 'eligibility-' || v_product::text, 'men', 'published', true);
  insert into public.product_sizes (id, product_id, size_ml, size_label) values
    (v_s50, v_product, 50, '50 ml'), (v_s100, v_product, 100, '100 ml'), (v_soon, v_product, 75, '75 ml'), (v_both, v_product, 30, '30 ml');

  -- 50 ml : A 100 / stock 0 (out), B 120 / stock 5, NULL-stock store 50 (cheapest of all, but unconfirmed),
  --         stale 40, inactive-store 30 -> only B is eligible
  -- 100 ml: A 180 / stock 3, B 200 / stock 8 -> A is the platform offer, B is eligible but not shown
  insert into public.store_products (store_id, product_size_id, price, currency, stock_quantity, is_available, sync_status) values
    (v_a, v_s50, 100, 'EGP', 0, true, 'synced'),
    (v_b, v_s50, 120, 'EGP', 5, true, 'synced'),
    (v_null, v_s50, 50, 'EGP', null, true, 'synced'),
    (v_stale, v_s50, 40, 'EGP', 5, true, 'stale'),
    (v_off, v_s50, 30, 'EGP', 5, true, 'synced'),
    (v_a, v_s100, 180, 'EGP', 3, true, 'synced'),
    (v_b, v_s100, 200, 'EGP', 8, true, 'synced');

  -- 1. NULL and zero stock are not sale offers, whatever their price ----------------------------------------------------------
  perform pg_temp.must(not exists (select 1 from public.catalog_eligible_offers where product_size_id = v_s50 and store_id = v_null),
    'a NULL stock offer (unconfirmed) must not be eligible');
  perform pg_temp.must(not exists (select 1 from public.catalog_eligible_offers where product_size_id = v_s50 and store_id = v_a),
    'a zero stock offer must not be eligible');
  perform pg_temp.must(not exists (select 1 from public.catalog_eligible_offers where product_size_id = v_s50 and store_id in (v_stale, v_off)),
    'an unsynced row and an inactive store are never eligible');
  perform pg_temp.must((select count(*) from public.catalog_eligible_offers where product_size_id = v_s50) = 1, '50 ml: B is the only eligible offer');
  select * into v_row from public.catalog_platform_offers where product_size_id = v_s50;
  perform pg_temp.must(v_row.store_id = v_b and v_row.price = 120 and v_row.stock_quantity = 5,
    '50 ml: the platform offer is B at 120 with stock 5, not the cheaper NULL/zero-stock rows');

  -- 2. cheapest per size, each size on its own ---------------------------------------------------------------------------------
  select * into v_row from public.catalog_platform_offers where product_size_id = v_s100;
  perform pg_temp.must(v_row.store_id = v_a and v_row.price = 180 and v_row.stock_quantity = 3, '100 ml: the platform offer is A at 180');
  perform pg_temp.must((select count(*) from public.catalog_eligible_offers where product_size_id = v_s100) = 2, '100 ml: both stores are eligible');
  perform pg_temp.must((select count(*) from public.catalog_platform_offers where product_size_id = v_s100) = 1, 'exactly one platform offer per size');
  perform pg_temp.must(not exists (select 1 from public.catalog_platform_offers where product_size_id = v_s100 and store_id = v_b),
    'B is eligible for 100 ml but is not the offer shown');

  -- 3. less stock than wanted is NOT a reason to move to the dearer store ---------------------------------------------------------
  update public.store_products set stock_quantity = 2 where store_id = v_a and product_size_id = v_s100;
  select * into v_row from public.catalog_platform_offers where product_size_id = v_s100;
  perform pg_temp.must(v_row.store_id = v_a and v_row.price = 180 and v_row.stock_quantity = 2,
    'A still has stock (2): it stays the offer, with the maximum quantity 2 (a customer asking 5 is told "max 2", never moved to B)');
  perform pg_temp.must((select stock_quantity from public.catalog_platform_offers where product_size_id = v_s50) = 5,
    'the other size is untouched');

  -- 4. the cheapest sells out: the same size moves to the next-cheapest eligible store ------------------------------------------
  update public.store_products set stock_quantity = 0 where store_id = v_a and product_size_id = v_s100;
  select * into v_row from public.catalog_platform_offers where product_size_id = v_s100;
  perform pg_temp.must(v_row.store_id = v_b and v_row.price = 200 and v_row.stock_quantity = 8, '100 ml: A sold out -> B at 200');
  perform pg_temp.must((select store_id from public.catalog_platform_offers where product_size_id = v_s50) = v_b,
    '50 ml is independent: still B');
  -- unconfirmed stock behaves like sold out for selling purposes (not like available)
  update public.store_products set stock_quantity = null where store_id = v_a and product_size_id = v_s100;
  perform pg_temp.must((select store_id from public.catalog_platform_offers where product_size_id = v_s100) = v_b,
    'A with NULL stock is not eligible either');
  -- everyone out: the size has no sale offer at all
  update public.store_products set stock_quantity = 0 where store_id = v_b and product_size_id = v_s100;
  perform pg_temp.must(not exists (select 1 from public.catalog_platform_offers where product_size_id = v_s100)
    and not exists (select 1 from public.catalog_eligible_offers where product_size_id = v_s100), '100 ml: no eligible offer left');
  -- and back: the cheapest eligible store takes the size again
  update public.store_products set stock_quantity = 3 where store_id = v_a and product_size_id = v_s100;
  update public.store_products set stock_quantity = 8 where store_id = v_b and product_size_id = v_s100;
  perform pg_temp.must((select store_id from public.catalog_platform_offers where product_size_id = v_s100) = v_a, 'restocked A is the offer again');

  -- 5. other ways a row stops being a sale offer ---------------------------------------------------------------------------------
  update public.store_products set is_available = false where store_id = v_a and product_size_id = v_s100;
  perform pg_temp.must((select store_id from public.catalog_platform_offers where product_size_id = v_s100) = v_b, 'an unavailable row is not eligible');
  update public.store_products set is_available = true, is_coming_soon = true where store_id = v_a and product_size_id = v_s100;
  perform pg_temp.must((select store_id from public.catalog_platform_offers where product_size_id = v_s100) = v_b,
    'a row flagged coming soon is an announcement, never a sale offer, even with price and stock');
  update public.store_products set is_coming_soon = false where store_id = v_a and product_size_id = v_s100;
  begin
    insert into public.store_products (store_id, product_size_id, price, currency, stock_quantity, is_available, sync_status)
      values (v_c, v_s100, null, 'EGP', 5, true, 'synced');
    raise exception 'a sale row without a price was accepted';
  exception when check_violation then null; end;

  -- 6. «قريبًا»: a separate feed, no price, no stock needed, only while no sale offer exists ------------------------------------
  select string_agg(column_name::text, ',' order by ordinal_position) into v_cols
    from information_schema.columns where table_schema = 'public' and table_name = 'catalog_coming_soon_announcements';
  perform pg_temp.must(v_cols = 'product_size_id,product_id,store_id,store_name,stock_unknown',
    'the announcements feed has no price, no stock figure and no offer identifier: ' || coalesce(v_cols, '(none)'));
  insert into public.store_products (store_id, product_size_id, price, currency, stock_quantity, is_available, sync_status, is_coming_soon)
    values (v_c, v_soon, null, 'EGP', null, true, 'synced', true);
  select * into v_row from public.catalog_coming_soon_announcements where product_size_id = v_soon;
  perform pg_temp.must(v_row.store_id = v_c and v_row.stock_unknown is true and v_row.product_id = v_product,
    'a coming-soon row with no price and no stock is announced, with stock_unknown = true');
  perform pg_temp.must(not exists (select 1 from public.catalog_eligible_offers where product_size_id = v_soon)
    and not exists (select 1 from public.catalog_platform_offers where product_size_id = v_soon), 'an announcement is never a sale offer');
  perform pg_temp.must(exists (select 1 from public.public_products where id = v_product), 'the perfume is listed');
  update public.store_products set stock_quantity = 7, price = 99 where store_id = v_c and product_size_id = v_soon;
  perform pg_temp.must((select stock_unknown from public.catalog_coming_soon_announcements where product_size_id = v_soon) is false,
    'a known stock figure makes stock_unknown false; the row is still only an announcement');
  perform pg_temp.must(not exists (select 1 from public.catalog_platform_offers where product_size_id = v_soon),
    'still not a sale offer');
  -- a size that has a sale offer is not announced any more
  insert into public.store_products (store_id, product_size_id, price, currency, stock_quantity, is_available, sync_status)
    values (v_b, v_soon, 300, 'EGP', 4, true, 'synced');
  perform pg_temp.must(not exists (select 1 from public.catalog_coming_soon_announcements where product_size_id = v_soon),
    'once the size has an eligible sale offer the announcement is gone');
  perform pg_temp.must((select store_id from public.catalog_platform_offers where product_size_id = v_soon) = v_b, 'and the sale offer is B');
  update public.store_products set stock_quantity = 0 where store_id = v_b and product_size_id = v_soon;
  perform pg_temp.must(exists (select 1 from public.catalog_coming_soon_announcements where product_size_id = v_soon),
    'when the sale offer sells out the announcement is back: it never disappears for lack of an offer');
  -- an inactive store cannot announce
  insert into public.store_products (store_id, product_size_id, price, currency, stock_quantity, is_available, sync_status, is_coming_soon)
    values (v_off, v_both, null, 'EGP', null, true, 'synced', true);
  perform pg_temp.must(not exists (select 1 from public.catalog_coming_soon_announcements where product_size_id = v_both),
    'an inactive store does not announce');

  -- 7. the visitor and the signed-in customer read all of it -------------------------------------------------------------------
  -- (the checks run after RESET ROLE: a temp function of this session is not callable by the API roles)
  set local role anon;
  select count(*) into v_anon_platform from public.catalog_platform_offers where product_size_id in (v_s50, v_s100);
  select count(*) into v_anon_eligible from public.catalog_eligible_offers where product_size_id in (v_s50, v_s100);
  select count(*) into v_anon_soon from public.catalog_coming_soon_announcements where product_size_id = v_soon;
  reset role;
  set local role authenticated;
  select count(*) into v_auth_platform from public.catalog_platform_offers where product_size_id in (v_s50, v_s100);
  select count(*) into v_auth_soon from public.catalog_coming_soon_announcements where product_size_id = v_soon;
  reset role;
  perform pg_temp.must(v_anon_platform = 2, 'anon reads the platform offers (got ' || v_anon_platform || ')');
  perform pg_temp.must(v_anon_eligible = 3, 'anon reads the eligible offers (got ' || v_anon_eligible || ')');
  perform pg_temp.must(v_anon_soon = 1, 'anon reads the announcements (got ' || v_anon_soon || ')');
  perform pg_temp.must(v_auth_platform = 2, 'a signed-in customer reads the platform offers (got ' || v_auth_platform || ')');
  perform pg_temp.must(v_auth_soon = 1, 'a signed-in customer reads the announcements (got ' || v_auth_soon || ')');
end
$test$;

rollback;
