-- Real-database test of the BUNDLES contract (migration 20261115074256 catalog_bundles, owner rules of 2026-11-14).
-- Run on the live database as the project owner inside this one transaction; every fixture row is synthetic and the final
-- ROLLBACK discards all of it.
--
--   * two stores' bundles are compared only when they are provably the same package: the same catalog sizes in the same
--     quantities and nothing else (composition_key, derived by the database from the items, never typed by hand);
--     a package with an extra piece, or with a single piece, never gets a key and so never merges with another;
--   * a bundle offer needs the stock as a NUMBER greater than zero (NULL and negative are refused by the table itself), a price
--     greater than zero, EGP, an active store, a published and active bundle, an available and synced row;
--   * the platform offer is the cheapest eligible offer of a bundle with the same tie-break as a perfume (commission, priority,
--     store, id); a bundle that only one store sells is the cheapest by itself; a sold-out cheapest hands over to the next store;
--   * a package holding a hidden or unpublished perfume is hidden with it;
--   * the visitor and the signed-in customer read the four public views and can neither read nor write the three tables;
--   * no store-claimed "price before discount" exists on a bundle offer.
begin;

create function pg_temp.must(ok boolean, msg text) returns void language plpgsql as $f$
begin
  if ok is not true then raise exception 'catalog bundles contract: %', msg; end if;
end $f$;

do $test$
declare
  v_brand uuid := gen_random_uuid();
  v_p1 uuid := gen_random_uuid();
  v_p2 uuid := gen_random_uuid();
  v_ph uuid := gen_random_uuid();       -- a perfume that is NOT published
  v_s1 uuid := gen_random_uuid();
  v_s2 uuid := gen_random_uuid();
  v_sh uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();        -- Store A (commission 15)
  v_b uuid := gen_random_uuid();        -- Store B (commission 20)
  v_zero uuid := gen_random_uuid();
  v_stale uuid := gen_random_uuid();
  v_off uuid := gen_random_uuid();      -- inactive store
  v_una uuid := gen_random_uuid();      -- unavailable row
  v_c uuid := gen_random_uuid();        -- sells the extras bundle alone
  v_d uuid := gen_random_uuid();
  v_b1 uuid := gen_random_uuid();       -- pure catalog package: s1 + s2
  v_b2 uuid := gen_random_uuid();       -- same two sizes plus an extra piece
  v_b3 uuid := gen_random_uuid();       -- a single piece
  v_b4 uuid := gen_random_uuid();       -- a package holding the unpublished perfume
  v_b5 uuid := gen_random_uuid();       -- a package nobody sells
  v_b6 uuid := gen_random_uuid();       -- a draft package
  v_key text; v_key2 text; v_row record; v_cols text;
  v_dup boolean := false; v_null_stock boolean := false; v_zero_price boolean := false; v_usd boolean := false;
  v_neg boolean := false; v_twice boolean := false; v_qty0 boolean := false; v_qty21 boolean := false; v_size_gone boolean := false;
  v_anon_views integer; v_auth_views integer; v_anon_read boolean := false; v_anon_write boolean := false; v_auth_read boolean := false;
  v_auth_write boolean := false;
begin
  insert into public.brands (id, name, slug) values (v_brand, 'Bundles Contract', 'bundles-contract-' || v_brand::text);
  insert into public.stores (id, name, slug, status, commission_rate, priority_rank) values
    (v_a, 'Bundles A', 'bnd-a-' || v_a::text, 'active', 15, 100),
    (v_b, 'Bundles B', 'bnd-b-' || v_b::text, 'active', 20, 100),
    (v_zero, 'Bundles zero stock', 'bnd-z-' || v_zero::text, 'active', 15, 100),
    (v_stale, 'Bundles stale', 'bnd-s-' || v_stale::text, 'active', 15, 100),
    (v_off, 'Bundles inactive', 'bnd-o-' || v_off::text, 'inactive', 15, 100),
    (v_una, 'Bundles unavailable', 'bnd-u-' || v_una::text, 'active', 15, 100),
    (v_c, 'Bundles C', 'bnd-c-' || v_c::text, 'active', 15, 100),
    (v_d, 'Bundles D', 'bnd-d-' || v_d::text, 'active', 15, 100);
  insert into public.products (id, brand_id, name, slug, gender, status, is_active) values
    (v_p1, v_brand, 'Bundles Perfume One', 'bnd-p1-' || v_p1::text, 'men', 'published', true),
    (v_p2, v_brand, 'Bundles Perfume Two', 'bnd-p2-' || v_p2::text, 'men', 'published', true),
    (v_ph, v_brand, 'Bundles Hidden Perfume', 'bnd-ph-' || v_ph::text, 'men', 'draft', true);
  insert into public.product_sizes (id, product_id, size_ml, size_label) values
    (v_s1, v_p1, 100, '100 ml'), (v_s2, v_p2, 50, '50 ml'), (v_sh, v_ph, 100, '100 ml');

  -- 1. the composition key is derived from the items --------------------------------------------------------------------------
  insert into public.bundles (id, brand_id, name, slug, status) values (v_b1, v_brand, 'Pure package', 'bnd-b1-' || v_b1::text, 'published');
  insert into public.bundle_items (bundle_id, product_size_id, quantity) values (v_b1, v_s2, 1);
  perform pg_temp.must((select composition_key from public.bundles where id = v_b1) is null, 'a single piece never gets a composition key');
  insert into public.bundle_items (bundle_id, product_size_id, quantity) values (v_b1, v_s1, 1);
  select composition_key into v_key from public.bundles where id = v_b1;
  perform pg_temp.must(v_key is not null and v_key like '%x1,%x1', 'two catalog sizes give a composition key (got ' || coalesce(v_key, 'NULL') || ')');

  -- the same package built in the OTHER order must collide: it is the same package, so two rows may never exist
  declare v_dupbundle uuid := gen_random_uuid();
  begin
    begin
      insert into public.bundles (id, brand_id, name, slug, status) values (v_dupbundle, v_brand, 'Same package again', 'bnd-dup2-' || v_dupbundle::text, 'published');
      insert into public.bundle_items (bundle_id, product_size_id, quantity) values (v_dupbundle, v_s1, 1);
      insert into public.bundle_items (bundle_id, product_size_id, quantity) values (v_dupbundle, v_s2, 1);
    exception when unique_violation then
      v_dup := true;
    end;
  end;
  perform pg_temp.must(v_dup, 'the same sizes and quantities must not exist as two bundles (unique composition key)');

  -- the same sizes with other quantities are a different package
  declare v_other uuid := gen_random_uuid();
  begin
    insert into public.bundles (id, brand_id, name, slug, status) values (v_other, v_brand, 'Two of the first', 'bnd-oth-' || v_other::text, 'published');
    insert into public.bundle_items (bundle_id, product_size_id, quantity) values (v_other, v_s1, 2), (v_other, v_s2, 1);
    select composition_key into v_key2 from public.bundles where id = v_other;
    perform pg_temp.must(v_key2 is not null and v_key2 <> v_key, 'other quantities make another package with another key');
  end;

  -- an extra piece (sample, deodorant, pouch...) means the package can never be proven identical to another store's
  insert into public.bundles (id, brand_id, name, slug, status, has_extra_items) values (v_b2, v_brand, 'Package with an extra piece', 'bnd-b2-' || v_b2::text, 'published', true);
  insert into public.bundle_items (bundle_id, product_size_id, quantity) values (v_b2, v_s1, 1), (v_b2, v_s2, 1);
  perform pg_temp.must((select composition_key from public.bundles where id = v_b2) is null, 'a package with an extra piece never gets a key, even with the same sizes');
  perform pg_temp.must((select count(*) from public.bundles where id in (v_b1, v_b2)) = 2, 'both packages exist side by side');
  -- turning the flag on removes an existing key, turning it off derives it again (and would collide with b1, so it is refused)
  declare v_flip uuid := gen_random_uuid();
  begin
    insert into public.bundles (id, brand_id, name, slug, status) values (v_flip, v_brand, 'Flip', 'bnd-flip-' || v_flip::text, 'draft');
    insert into public.bundle_items (bundle_id, product_size_id, quantity) values (v_flip, v_s1, 3);
    perform pg_temp.must((select composition_key from public.bundles where id = v_flip) is not null, 'three pieces of one size get a key');
    update public.bundles set has_extra_items = true where id = v_flip;
    perform pg_temp.must((select composition_key from public.bundles where id = v_flip) is null, 'raising has_extra_items drops the key');
    update public.bundle_items set quantity = 4 where bundle_id = v_flip and product_size_id = v_s1;
    perform pg_temp.must((select composition_key from public.bundles where id = v_flip) is null, 'a package with extras keeps no key when its items change');
    update public.bundles set has_extra_items = false where id = v_flip;
    perform pg_temp.must((select composition_key from public.bundles where id = v_flip) like '%x4', 'lowering has_extra_items derives the key from the items again');
    delete from public.bundle_items where bundle_id = v_flip;
    perform pg_temp.must((select composition_key from public.bundles where id = v_flip) is null, 'a package with no items has no key');
    delete from public.bundles where id = v_flip;
  end;
  insert into public.bundles (id, brand_id, name, slug, status) values (v_b3, v_brand, 'One piece', 'bnd-b3-' || v_b3::text, 'published');
  insert into public.bundle_items (bundle_id, product_size_id, quantity) values (v_b3, v_s1, 1);
  perform pg_temp.must((select composition_key from public.bundles where id = v_b3) is null, 'one piece of one size is a perfume, not a package, so no key');

  -- the table refuses what must never exist ------------------------------------------------------------------------------------
  begin insert into public.bundle_items (bundle_id, product_size_id, quantity) values (v_b3, v_s2, 0); exception when check_violation then v_qty0 := true; end;
  begin insert into public.bundle_items (bundle_id, product_size_id, quantity) values (v_b3, v_s2, 21); exception when check_violation then v_qty21 := true; end;
  begin delete from public.product_sizes where id = v_s1; exception when foreign_key_violation then v_size_gone := true; end;
  perform pg_temp.must(v_qty0 and v_qty21, 'a quantity outside 1..20 is refused');
  perform pg_temp.must(v_size_gone, 'a size that sits in a package cannot be deleted from under it');
  begin insert into public.store_bundles (store_id, bundle_id, price, stock_quantity, is_available, sync_status) values (v_a, v_b1, 300, null, true, 'synced'); exception when not_null_violation then v_null_stock := true; end;
  perform pg_temp.must(v_null_stock, 'a bundle offer without a stock NUMBER is refused (the store must send it)');
  begin insert into public.store_bundles (store_id, bundle_id, price, stock_quantity, is_available, sync_status) values (v_a, v_b1, 300, -1, true, 'synced'); exception when check_violation then v_neg := true; end;
  perform pg_temp.must(v_neg, 'a negative stock is refused');
  begin insert into public.store_bundles (store_id, bundle_id, price, stock_quantity, is_available, sync_status) values (v_a, v_b1, 0, 5, true, 'synced'); exception when check_violation then v_zero_price := true; end;
  perform pg_temp.must(v_zero_price, 'a bundle priced 0 is refused');
  begin insert into public.store_bundles (store_id, bundle_id, price, currency, stock_quantity, is_available, sync_status) values (v_a, v_b1, 300, 'USD', 5, true, 'synced'); exception when check_violation then v_usd := true; end;
  perform pg_temp.must(v_usd, 'only EGP is accepted');

  -- 2. eligibility ---------------------------------------------------------------------------------------------------------------
  -- b1 (published, pure): A 300 / 5, B 320 / 5 are eligible; zero stock, stale, inactive store, unavailable are not
  insert into public.store_bundles (store_id, bundle_id, price, stock_quantity, is_available, sync_status) values
    (v_a, v_b1, 300, 5, true, 'synced'),
    (v_b, v_b1, 320, 5, true, 'synced'),
    (v_zero, v_b1, 100, 0, true, 'synced'),
    (v_stale, v_b1, 90, 5, true, 'stale'),
    (v_off, v_b1, 80, 5, true, 'synced'),
    (v_una, v_b1, 70, 5, false, 'synced');
  begin insert into public.store_bundles (store_id, bundle_id, price, stock_quantity, is_available, sync_status) values (v_a, v_b1, 299, 5, true, 'synced'); exception when unique_violation then v_twice := true; end;
  perform pg_temp.must(v_twice, 'a store has one offer per bundle');
  perform pg_temp.must((select count(*) from public.catalog_eligible_bundle_offers where bundle_id = v_b1) = 2, 'only A and B are eligible for the pure package');
  perform pg_temp.must(not exists (select 1 from public.catalog_eligible_bundle_offers where bundle_id = v_b1 and store_id in (v_zero, v_stale, v_off, v_una)),
    'zero stock, unsynced, inactive store and unavailable rows are never eligible, whatever their price');

  -- 3. the platform offer: cheapest eligible, one per bundle ------------------------------------------------------------------------
  select * into v_row from public.catalog_platform_bundle_offers where bundle_id = v_b1;
  perform pg_temp.must(v_row.store_id = v_a and v_row.price = 300 and v_row.stock_quantity = 5, 'the platform offer is A at 300, not the cheaper ineligible rows');
  perform pg_temp.must((select count(*) from public.catalog_platform_bundle_offers where bundle_id = v_b1) = 1, 'one platform offer per bundle');
  update public.store_bundles set stock_quantity = 0 where store_id = v_a and bundle_id = v_b1;
  perform pg_temp.must((select store_id from public.catalog_platform_bundle_offers where bundle_id = v_b1) = v_b, 'A sold out: the offer is B at 320');
  update public.store_bundles set stock_quantity = 5 where store_id = v_a and bundle_id = v_b1;
  update public.store_bundles set is_available = false where store_id = v_a and bundle_id = v_b1;
  perform pg_temp.must((select store_id from public.catalog_platform_bundle_offers where bundle_id = v_b1) = v_b, 'A unavailable: the offer is B');
  update public.store_bundles set is_available = true, sync_status = 'stale' where store_id = v_a and bundle_id = v_b1;
  perform pg_temp.must((select store_id from public.catalog_platform_bundle_offers where bundle_id = v_b1) = v_b, 'A stale: the offer is B');
  update public.store_bundles set sync_status = 'synced' where store_id = v_a and bundle_id = v_b1;
  update public.store_bundles set price = 320 where store_id = v_a and bundle_id = v_b1;
  perform pg_temp.must((select store_id from public.catalog_platform_bundle_offers where bundle_id = v_b1) = v_b, 'equal prices: the higher commission (B, 20) wins the tie-break');
  update public.store_bundles set price = 300 where store_id = v_a and bundle_id = v_b1;
  perform pg_temp.must((select store_id from public.catalog_platform_bundle_offers where bundle_id = v_b1) = v_a, 'A is the offer again');

  -- a package only one store sells is the cheapest by itself, until another store sells the SAME package
  insert into public.store_bundles (store_id, bundle_id, price, stock_quantity, is_available, sync_status) values (v_c, v_b2, 500, 3, true, 'synced');
  perform pg_temp.must((select store_id from public.catalog_platform_bundle_offers where bundle_id = v_b2) = v_c, 'a solo package is the platform offer');
  insert into public.store_bundles (store_id, bundle_id, price, stock_quantity, is_available, sync_status) values (v_d, v_b2, 450, 2, true, 'synced');
  perform pg_temp.must((select store_id from public.catalog_platform_bundle_offers where bundle_id = v_b2) = v_d and (select count(*) from public.catalog_eligible_bundle_offers where bundle_id = v_b2) = 2,
    'a second store on the same package takes over when it is cheaper');

  -- different packages from different stores all appear (nothing merges when it cannot be proven)
  perform pg_temp.must((select count(*) from public.public_bundles where id in (v_b1, v_b2)) = 2, 'the pure package and the package with an extra piece both appear');

  -- 4. what hides a package ---------------------------------------------------------------------------------------------------------
  insert into public.bundles (id, brand_id, name, slug, status) values (v_b4, v_brand, 'Holds a hidden perfume', 'bnd-b4-' || v_b4::text, 'published');
  insert into public.bundle_items (bundle_id, product_size_id, quantity) values (v_b4, v_sh, 1), (v_b4, v_s2, 1);
  insert into public.store_bundles (store_id, bundle_id, price, stock_quantity, is_available, sync_status) values (v_a, v_b4, 700, 4, true, 'synced');
  perform pg_temp.must(not exists (select 1 from public.catalog_eligible_bundle_offers where bundle_id = v_b4) and not exists (select 1 from public.public_bundles where id = v_b4),
    'a package that holds an unpublished perfume is hidden');
  update public.products set status = 'published' where id = v_ph;
  perform pg_temp.must(exists (select 1 from public.public_bundles where id = v_b4), 'it appears when the perfume is published');
  update public.products set is_active = false where id = v_ph;
  perform pg_temp.must(not exists (select 1 from public.public_bundles where id = v_b4), 'and hides again when the perfume is deactivated');
  update public.products set is_active = true where id = v_ph;

  insert into public.bundles (id, brand_id, name, slug, status) values (v_b5, v_brand, 'Nobody sells this', 'bnd-b5-' || v_b5::text, 'published');
  perform pg_temp.must(not exists (select 1 from public.public_bundles where id = v_b5), 'a package without an eligible offer is not public');
  insert into public.bundles (id, brand_id, name, slug, status) values (v_b6, v_brand, 'Draft package', 'bnd-b6-' || v_b6::text, 'draft');
  insert into public.store_bundles (store_id, bundle_id, price, stock_quantity, is_available, sync_status) values (v_a, v_b6, 100, 5, true, 'synced');
  perform pg_temp.must(not exists (select 1 from public.public_bundles where id = v_b6) and not exists (select 1 from public.catalog_eligible_bundle_offers where bundle_id = v_b6),
    'a draft package never appears');
  update public.bundles set status = 'published', is_active = false where id = v_b6;
  perform pg_temp.must(not exists (select 1 from public.public_bundles where id = v_b6), 'an inactive package never appears');
  update public.bundles set is_active = true where id = v_b6;
  perform pg_temp.must(exists (select 1 from public.public_bundles where id = v_b6), 'a published, active package with an eligible offer appears');

  -- the items the storefront reads belong to public packages only
  perform pg_temp.must((select count(*) from public.public_bundle_items where bundle_id = v_b1) = 2, 'the pure package lists its two items');
  perform pg_temp.must(not exists (select 1 from public.public_bundle_items where bundle_id = v_b5), 'a non-public package lists no items');

  -- 5. nothing the store claims about a "price before discount", and no commission leaks -----------------------------------------------
  select string_agg(column_name, ',' order by ordinal_position) into v_cols from information_schema.columns
   where table_schema = 'public' and table_name = 'catalog_platform_bundle_offers';
  perform pg_temp.must(v_cols = 'store_bundle_id,bundle_id,store_id,store_name,price,currency,stock_quantity,price_includes_tax,price_includes_shipping,last_synced_at',
    'the platform bundle offer carries no commission, no priority and no claimed old price (got ' || coalesce(v_cols, 'NULL') || ')');
  perform pg_temp.must(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'store_bundles'
                                      and column_name in ('original_price', 'discount_percentage')),
    'a store cannot claim an old price or a discount on a bundle');

  -- 6. the visitor and the signed-in customer read the views, never the tables -----------------------------------------------------
  -- (the checks run after RESET ROLE: a temp function of this session is not callable by the API roles)
  set local role anon;
  select count(*) into v_anon_views from public.catalog_platform_bundle_offers where bundle_id in (v_b1, v_b2);
  begin perform 1 from public.bundles limit 1; exception when insufficient_privilege then v_anon_read := true; end;
  begin insert into public.store_bundles (store_id, bundle_id, price, stock_quantity) values (v_a, v_b5, 10, 1); exception when insufficient_privilege then v_anon_write := true; end;
  reset role;
  set local role authenticated;
  select count(*) into v_auth_views from public.public_bundles where id in (v_b1, v_b2);
  begin perform 1 from public.store_bundles limit 1; exception when insufficient_privilege then v_auth_read := true; end;
  begin update public.bundles set name = 'x' where id = v_b1; exception when insufficient_privilege then v_auth_write := true; end;
  reset role;
  perform pg_temp.must(v_anon_views = 2, 'anon reads the platform bundle offers (got ' || v_anon_views || ')');
  perform pg_temp.must(v_auth_views = 2, 'a signed-in customer reads the public bundles (got ' || v_auth_views || ')');
  perform pg_temp.must(v_anon_read and v_auth_read, 'neither the visitor nor the customer can read the bundle tables');
  perform pg_temp.must(v_anon_write and v_auth_write, 'neither the visitor nor the customer can write the bundle tables');
end
$test$;

rollback;
