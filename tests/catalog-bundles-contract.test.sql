-- Real-database test of the BUNDLES contract
--   migration 20261115074256 catalog_bundles (owner rules of 2026-11-14) and
--   migration 20261119112905 catalog_bundles_standalone (owner rules of 2026-11-17).
-- Run on the live database as the project owner inside this one transaction; every fixture row is synthetic and the final
-- ROLLBACK discards all of it.
--
--   * a bundle STANDS ON ITS OWN: its pieces are text exactly as the store lists them (brand, name, size in ml, quantity) with no link
--     to the perfume catalog; a hidden, deleted or never-listed perfume never hides a bundle and a bundle never blocks deleting a perfume;
--   * the bundle shows the store's OWN title and its FULL description; the platform proposes no description;
--   * two stores' bundles are compared by CONTENT only: the same pieces in the same sizes and quantities (composition_key, derived by the
--     database from the pieces, case / spacing / punctuation / accents ignored, never typed by hand and never reading a word of the text);
--     a package with an extra piece, or with a single piece, never gets a key and so never merges with another;
--   * a bundle offer needs the stock as a NUMBER greater than zero, a price greater than zero, EGP, a title, an active store, a published
--     and active bundle, an available and synced row;
--   * the platform offer is the cheapest eligible offer of a bundle with the same tie-break as a perfume (commission, priority, store, id)
--     and carries that store's own words; a sold-out cheapest hands over to the next store;
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
  v_ph uuid := gen_random_uuid();       -- a perfume that is NOT published
  v_phs uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();        -- Store A (commission 15)
  v_b uuid := gen_random_uuid();        -- Store B (commission 20)
  v_zero uuid := gen_random_uuid();
  v_stale uuid := gen_random_uuid();
  v_off uuid := gen_random_uuid();      -- inactive store
  v_una uuid := gen_random_uuid();      -- unavailable row
  v_c uuid := gen_random_uuid();        -- sells the extras bundle alone
  v_d uuid := gen_random_uuid();
  v_b1 uuid := gen_random_uuid();       -- pure package: two pieces
  v_b2 uuid := gen_random_uuid();       -- the same two pieces plus an extra piece
  v_b3 uuid := gen_random_uuid();       -- a single piece
  v_b4 uuid := gen_random_uuid();       -- a package naming a hidden perfume, an exclusive size and a perfume the platform never lists
  v_b5 uuid := gen_random_uuid();       -- a package nobody sells
  v_b6 uuid := gen_random_uuid();       -- a draft package
  v_key text; v_key2 text; v_row record; v_cols text;
  v_desc text := E'Line one\nLine two <b>bold</b> & more\n\n' || repeat('long ', 400);
  v_dup boolean := false; v_null_stock boolean := false; v_zero_price boolean := false; v_usd boolean := false;
  v_neg boolean := false; v_twice boolean := false; v_qty0 boolean := false; v_qty21 boolean := false; v_piece_twice boolean := false;
  v_no_title boolean := false; v_long_desc boolean := false; v_blank_name boolean := false; v_size0 boolean := false;
  v_anon_views integer; v_auth_views integer; v_anon_read boolean := false; v_anon_write boolean := false; v_auth_read boolean := false;
  v_auth_write boolean := false; v_server_write boolean := false; v_pieces integer;
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
  -- a perfume of the catalog that is NOT published: the old model hid every package that named it
  insert into public.products (id, brand_id, name, slug, gender, status, is_active) values
    (v_ph, v_brand, 'Bundles Hidden Perfume', 'bnd-ph-' || v_ph::text, 'men', 'draft', true);
  insert into public.product_sizes (id, product_id, size_ml, size_label) values (v_phs, v_ph, 100, '100 ml');

  -- 1. the composition key is derived from the pieces ------------------------------------------------------------------------------
  insert into public.bundles (id, brand_id, name, slug, status) values (v_b1, v_brand, 'Pure package', 'bnd-b1-' || v_b1::text, 'published');
  insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_b1, 'Lattafa Test', 'Beta Perfume', 50, 1);
  perform pg_temp.must((select composition_key from public.bundles where id = v_b1) is null, 'a single piece never gets a composition key');
  insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_b1, 'Lattafa Test', 'Alpha Perfume', 100, 1);
  select composition_key into v_key from public.bundles where id = v_b1;
  perform pg_temp.must(v_key = 'lattafatest|alphaperfume|100x1,lattafatest|betaperfume|50x1',
    'two pieces give a composition key made of the normalised brand, name, size and quantity (got ' || coalesce(v_key, 'NULL') || ')');

  -- the same pieces spelled differently (case, spaces, punctuation, accents) are the same package: two rows may never exist
  declare v_dupbundle uuid := gen_random_uuid();
  begin
    begin
      insert into public.bundles (id, brand_id, name, slug, status) values (v_dupbundle, v_brand, 'Same package again', 'bnd-dup2-' || v_dupbundle::text, 'published');
      insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_dupbundle, 'LATTAFA  test', 'alpha-perfume', 100, 1);
      insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_dupbundle, 'Lattafa Test', 'BETA perfumé', 50, 1);
    exception when unique_violation then
      v_dup := true;
    end;
  end;
  perform pg_temp.must(v_dup, 'the same pieces and quantities must not exist as two bundles, whatever the case, spacing, punctuation or accents (unique composition key)');

  -- other quantities, another size, another brand: each is another package with another key
  declare v_other uuid := gen_random_uuid();
  begin
    insert into public.bundles (id, brand_id, name, slug, status) values (v_other, v_brand, 'Two of the first', 'bnd-oth-' || v_other::text, 'published');
    insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_other, 'Lattafa Test', 'Alpha Perfume', 100, 2), (v_other, 'Lattafa Test', 'Beta Perfume', 50, 1);
    select composition_key into v_key2 from public.bundles where id = v_other;
    perform pg_temp.must(v_key2 is not null and v_key2 <> v_key, 'other quantities make another package with another key');
  end;
  declare v_size uuid := gen_random_uuid();
  begin
    insert into public.bundles (id, brand_id, name, slug, status) values (v_size, v_brand, 'Alpha in 30 ml', 'bnd-size-' || v_size::text, 'published');
    insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_size, 'Lattafa Test', 'Alpha Perfume', 30, 1), (v_size, 'Lattafa Test', 'Beta Perfume', 50, 1);
    select composition_key into v_key2 from public.bundles where id = v_size;
    perform pg_temp.must(v_key2 is not null and v_key2 <> v_key, 'the same perfume in another size is another package');
  end;
  declare v_brand2 uuid := gen_random_uuid();
  begin
    insert into public.bundles (id, brand_id, name, slug, status) values (v_brand2, v_brand, 'Alpha of another brand', 'bnd-brand-' || v_brand2::text, 'published');
    insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_brand2, 'Other Brand', 'Alpha Perfume', 100, 1), (v_brand2, 'Lattafa Test', 'Beta Perfume', 50, 1);
    select composition_key into v_key2 from public.bundles where id = v_brand2;
    perform pg_temp.must(v_key2 is not null and v_key2 <> v_key, 'the same name under another brand is another package');
  end;

  -- an extra piece (sample, deodorant, pouch...) means the package can never be proven identical to another store's
  insert into public.bundles (id, brand_id, name, slug, status, has_extra_items) values (v_b2, v_brand, 'Package with an extra piece', 'bnd-b2-' || v_b2::text, 'published', true);
  insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_b2, 'Lattafa Test', 'Alpha Perfume', 100, 1), (v_b2, 'Lattafa Test', 'Beta Perfume', 50, 1);
  perform pg_temp.must((select composition_key from public.bundles where id = v_b2) is null, 'a package with an extra piece never gets a key, even with the same pieces');
  perform pg_temp.must((select count(*) from public.bundles where id in (v_b1, v_b2)) = 2, 'both packages exist side by side');
  -- turning the flag on removes an existing key, turning it off derives it again
  declare v_flip uuid := gen_random_uuid();
  begin
    insert into public.bundles (id, brand_id, name, slug, status) values (v_flip, v_brand, 'Flip', 'bnd-flip-' || v_flip::text, 'draft');
    insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_flip, 'Flip Brand', 'Gamma', 100, 3);
    perform pg_temp.must((select composition_key from public.bundles where id = v_flip) is not null, 'three pieces of one size get a key');
    update public.bundles set has_extra_items = true where id = v_flip;
    perform pg_temp.must((select composition_key from public.bundles where id = v_flip) is null, 'raising has_extra_items drops the key');
    update public.bundle_items set quantity = 4 where bundle_id = v_flip;
    perform pg_temp.must((select composition_key from public.bundles where id = v_flip) is null, 'a package with extras keeps no key when its pieces change');
    update public.bundles set has_extra_items = false where id = v_flip;
    perform pg_temp.must((select composition_key from public.bundles where id = v_flip) = 'flipbrand|gamma|100x4', 'lowering has_extra_items derives the key from the pieces again');
    delete from public.bundle_items where bundle_id = v_flip;
    perform pg_temp.must((select composition_key from public.bundles where id = v_flip) is null, 'a package with no pieces has no key');
    delete from public.bundles where id = v_flip;
  end;
  insert into public.bundles (id, brand_id, name, slug, status) values (v_b3, v_brand, 'One piece', 'bnd-b3-' || v_b3::text, 'published');
  insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_b3, 'Lattafa Test', 'Alpha Perfume', 100, 1);
  perform pg_temp.must((select composition_key from public.bundles where id = v_b3) is null, 'one piece of one size is a perfume, not a package, so no key');

  -- the table refuses what must never exist -----------------------------------------------------------------------------------------
  begin insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_b3, 'Lattafa Test', 'Beta Perfume', 50, 0); exception when check_violation then v_qty0 := true; end;
  begin insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_b3, 'Lattafa Test', 'Beta Perfume', 50, 21); exception when check_violation then v_qty21 := true; end;
  perform pg_temp.must(v_qty0 and v_qty21, 'a quantity outside 1..20 is refused');
  begin insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_b3, 'LATTAFA TEST', 'alpha  perfume', 100, 1); exception when unique_violation then v_piece_twice := true; end;
  perform pg_temp.must(v_piece_twice, 'the same piece twice in one bundle is refused, however it is spelled');
  begin insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_b3, 'Lattafa Test', '   ', 50, 1); exception when check_violation then v_blank_name := true; end;
  begin insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_b3, 'Lattafa Test', 'Zero size', 0, 1); exception when check_violation then v_size0 := true; end;
  perform pg_temp.must(v_blank_name and v_size0, 'a piece needs a name and, when a size is given, a size above zero');
  begin insert into public.store_bundles (store_id, bundle_id, title, price, stock_quantity, is_available, sync_status) values (v_a, v_b1, 'Title', 300, null, true, 'synced'); exception when not_null_violation then v_null_stock := true; end;
  perform pg_temp.must(v_null_stock, 'a bundle offer without a stock NUMBER is refused (the store must send it)');
  begin insert into public.store_bundles (store_id, bundle_id, title, price, stock_quantity, is_available, sync_status) values (v_a, v_b1, 'Title', 300, -1, true, 'synced'); exception when check_violation then v_neg := true; end;
  perform pg_temp.must(v_neg, 'a negative stock is refused');
  begin insert into public.store_bundles (store_id, bundle_id, title, price, stock_quantity, is_available, sync_status) values (v_a, v_b1, 'Title', 0, 5, true, 'synced'); exception when check_violation then v_zero_price := true; end;
  perform pg_temp.must(v_zero_price, 'a bundle priced 0 is refused');
  begin insert into public.store_bundles (store_id, bundle_id, title, price, currency, stock_quantity, is_available, sync_status) values (v_a, v_b1, 'Title', 300, 'USD', 5, true, 'synced'); exception when check_violation then v_usd := true; end;
  perform pg_temp.must(v_usd, 'only EGP is accepted');
  begin insert into public.store_bundles (store_id, bundle_id, title, price, stock_quantity, is_available, sync_status) values (v_a, v_b1, null, 300, 5, true, 'synced'); exception when not_null_violation then v_no_title := true; end;
  perform pg_temp.must(v_no_title, 'a bundle offer must carry the store''s own title');
  begin insert into public.store_bundles (store_id, bundle_id, title, description, price, stock_quantity, is_available, sync_status) values (v_a, v_b1, 'Title', repeat('x', 20001), 300, 5, true, 'synced'); exception when check_violation then v_long_desc := true; end;
  perform pg_temp.must(v_long_desc, 'a description over 20000 characters is refused');

  -- 2. eligibility ------------------------------------------------------------------------------------------------------------------
  -- b1 (published, pure): A 300 / 5, B 320 / 5 are eligible; zero stock, stale, inactive store, unavailable are not.
  -- Store A and store B describe the SAME package in different words (the second store even leaves the description out).
  insert into public.store_bundles (store_id, bundle_id, title, description, price, stock_quantity, is_available, sync_status) values
    (v_a, v_b1, 'STORE A: the gift box', v_desc, 300, 5, true, 'synced'),
    (v_b, v_b1, 'Store B — duo set', null, 320, 5, true, 'synced'),
    (v_zero, v_b1, 'zero', null, 100, 0, true, 'synced'),
    (v_stale, v_b1, 'stale', null, 90, 5, true, 'stale'),
    (v_off, v_b1, 'inactive', null, 80, 5, true, 'synced'),
    (v_una, v_b1, 'unavailable', null, 70, 5, false, 'synced');
  begin insert into public.store_bundles (store_id, bundle_id, title, price, stock_quantity, is_available, sync_status) values (v_a, v_b1, 'again', 299, 5, true, 'synced'); exception when unique_violation then v_twice := true; end;
  perform pg_temp.must(v_twice, 'a store has one offer per bundle');
  perform pg_temp.must((select count(*) from public.catalog_eligible_bundle_offers where bundle_id = v_b1) = 2, 'only A and B are eligible for the pure package');
  perform pg_temp.must(not exists (select 1 from public.catalog_eligible_bundle_offers where bundle_id = v_b1 and store_id in (v_zero, v_stale, v_off, v_una)),
    'zero stock, unsynced, inactive store and unavailable rows are never eligible, whatever their price');
  perform pg_temp.must((select count(*) from public.public_bundles where id = v_b1) = 1 and (select composition_key from public.bundles where id = v_b1) = v_key,
    'two stores with different words on the same package are one bundle');

  -- 3. the platform offer: cheapest eligible, one per bundle, with that store's own words -----------------------------------------------
  select * into v_row from public.catalog_platform_bundle_offers where bundle_id = v_b1;
  perform pg_temp.must(v_row.store_id = v_a and v_row.price = 300 and v_row.stock_quantity = 5, 'the platform offer is A at 300, not the cheaper ineligible rows');
  perform pg_temp.must(v_row.title = 'STORE A: the gift box' and v_row.description = v_desc,
    'the platform offer carries the cheapest store''s own title and its full description, untouched (line breaks, markup characters and length kept)');
  perform pg_temp.must((select count(*) from public.catalog_platform_bundle_offers where bundle_id = v_b1) = 1, 'one platform offer per bundle');
  update public.store_bundles set stock_quantity = 0 where store_id = v_a and bundle_id = v_b1;
  select * into v_row from public.catalog_platform_bundle_offers where bundle_id = v_b1;
  perform pg_temp.must(v_row.store_id = v_b and v_row.price = 320 and v_row.title = 'Store B — duo set' and v_row.description is null,
    'A sold out: the offer is B at 320 and shows B''s own words (and no description when B wrote none)');
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
  -- no wording can change who wins, whether the bundle shows or which bundle it is
  update public.store_bundles set title = 'x', description = 'cheap cheap SALE discount free' where store_id = v_a and bundle_id = v_b1;
  update public.store_bundles set title = 'the most expensive duo ever', description = repeat('z', 20000) where store_id = v_b and bundle_id = v_b1;
  perform pg_temp.must((select store_id from public.catalog_platform_bundle_offers where bundle_id = v_b1) = v_a
                       and exists (select 1 from public.public_bundles where id = v_b1)
                       and (select composition_key from public.bundles where id = v_b1) = v_key,
    'rewording the store''s text never changes which store wins or whether the bundle shows');

  -- a package only one store sells is the cheapest by itself, until another store sells the SAME package
  insert into public.store_bundles (store_id, bundle_id, title, price, stock_quantity, is_available, sync_status) values (v_c, v_b2, 'C extras', 500, 3, true, 'synced');
  perform pg_temp.must((select store_id from public.catalog_platform_bundle_offers where bundle_id = v_b2) = v_c, 'a solo package is the platform offer');
  insert into public.store_bundles (store_id, bundle_id, title, price, stock_quantity, is_available, sync_status) values (v_d, v_b2, 'D extras', 450, 2, true, 'synced');
  perform pg_temp.must((select store_id from public.catalog_platform_bundle_offers where bundle_id = v_b2) = v_d and (select count(*) from public.catalog_eligible_bundle_offers where bundle_id = v_b2) = 2,
    'a second store on the same package takes over when it is cheaper');

  -- different packages from different stores all appear (nothing merges when it cannot be proven)
  perform pg_temp.must((select count(*) from public.public_bundles where id in (v_b1, v_b2)) = 2, 'the pure package and the package with an extra piece both appear');

  -- 4. the perfume catalog has NO say over a bundle ---------------------------------------------------------------------------------
  insert into public.bundles (id, brand_id, name, slug, status) values (v_b4, v_brand, 'Pieces the catalog does not hold', 'bnd-b4-' || v_b4::text, 'published');
  insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values
    (v_b4, 'Bundles Contract', 'Bundles Hidden Perfume', 100, 1),   -- a perfume that is a draft in the catalog
    (v_b4, 'Lattafa Test', 'Alpha Perfume', 12, 1),                 -- an exclusive size: no catalog size has it
    (v_b4, 'Nobody Brand', 'Never Listed Perfume', 75, 2),          -- a perfume the platform never lists
    (v_b4, null, 'Piece with no brand and no size', null, 1);
  insert into public.store_bundles (store_id, bundle_id, title, price, stock_quantity, is_available, sync_status) values (v_a, v_b4, 'Exclusive set', 700, 4, true, 'synced');
  perform pg_temp.must(exists (select 1 from public.catalog_eligible_bundle_offers where bundle_id = v_b4) and exists (select 1 from public.public_bundles where id = v_b4)
                       and (select count(*) from public.public_bundle_items where bundle_id = v_b4) = 4,
    'a package naming a hidden perfume, an exclusive size and a perfume the platform never lists still shows with all its pieces');
  update public.products set status = 'published' where id = v_ph;
  perform pg_temp.must(exists (select 1 from public.public_bundles where id = v_b4), 'publishing or deactivating a perfume never changes whether a bundle shows (published)');
  update public.products set is_active = false where id = v_ph;
  perform pg_temp.must(exists (select 1 from public.public_bundles where id = v_b4), 'publishing or deactivating a perfume never changes whether a bundle shows (deactivated)');
  update public.products set status = 'draft', is_active = true where id = v_ph;
  perform pg_temp.must(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bundle_items' and column_name = 'product_size_id')
                       and not exists (select 1 from pg_constraint c where c.conrelid = 'public.bundle_items'::regclass and c.contype = 'f'
                                          and c.confrelid in ('public.product_sizes'::regclass, 'public.products'::regclass)),
    'a bundle piece is not tied to a catalog size or perfume (no column, no foreign key)');
  delete from public.product_sizes where id = v_phs;
  delete from public.products where id = v_ph;
  perform pg_temp.must(exists (select 1 from public.public_bundles where id = v_b4) and (select count(*) from public.public_bundle_items where bundle_id = v_b4) = 4,
    'a perfume can be deleted whatever the bundles say, and the bundle keeps all its pieces');

  insert into public.bundles (id, brand_id, name, slug, status) values (v_b5, v_brand, 'Nobody sells this', 'bnd-b5-' || v_b5::text, 'published');
  perform pg_temp.must(not exists (select 1 from public.public_bundles where id = v_b5), 'a package without an eligible offer is not public');
  insert into public.bundles (id, brand_id, name, slug, status) values (v_b6, v_brand, 'Draft package', 'bnd-b6-' || v_b6::text, 'draft');
  insert into public.store_bundles (store_id, bundle_id, title, price, stock_quantity, is_available, sync_status) values (v_a, v_b6, 'draft offer', 100, 5, true, 'synced');
  perform pg_temp.must(not exists (select 1 from public.public_bundles where id = v_b6) and not exists (select 1 from public.catalog_eligible_bundle_offers where bundle_id = v_b6),
    'a draft package never appears');
  update public.bundles set status = 'published', is_active = false where id = v_b6;
  perform pg_temp.must(not exists (select 1 from public.public_bundles where id = v_b6), 'an inactive package never appears');
  update public.bundles set is_active = true where id = v_b6;
  perform pg_temp.must(exists (select 1 from public.public_bundles where id = v_b6), 'a published, active package with an eligible offer appears');

  -- the pieces the storefront reads belong to public packages only, and are listed exactly as the store wrote them
  perform pg_temp.must((select count(*) from public.public_bundle_items where bundle_id = v_b1) = 2, 'the pure package lists its two pieces');
  perform pg_temp.must(not exists (select 1 from public.public_bundle_items where bundle_id = v_b5), 'a non-public package lists no pieces');
  perform pg_temp.must(exists (select 1 from public.public_bundle_items where bundle_id = v_b4 and brand_name = 'Nobody Brand' and product_name = 'Never Listed Perfume' and size_ml = 75 and quantity = 2)
                       and exists (select 1 from public.public_bundle_items where bundle_id = v_b4 and brand_name is null and size_ml is null and product_name = 'Piece with no brand and no size'),
    'a piece is listed exactly as the store wrote it (case, brand, size and quantity kept; a missing brand or size stays missing)');

  -- 5. nothing the store claims about a "price before discount", no commission leaks, and the platform writes no description -------------
  select string_agg(column_name, ',' order by ordinal_position) into v_cols from information_schema.columns
   where table_schema = 'public' and table_name = 'catalog_platform_bundle_offers';
  perform pg_temp.must(v_cols = 'store_bundle_id,bundle_id,store_id,store_name,title,description,price,currency,stock_quantity,price_includes_tax,price_includes_shipping,last_synced_at',
    'the platform bundle offer carries no commission, no priority and no claimed old price (got ' || coalesce(v_cols, 'NULL') || ')');
  select string_agg(column_name, ',' order by ordinal_position) into v_cols from information_schema.columns
   where table_schema = 'public' and table_name = 'public_bundles';
  perform pg_temp.must(v_cols = 'id,brand_id,brand_name,name,slug,has_extra_items', 'the public bundles view has no platform description (got ' || coalesce(v_cols, 'NULL') || ')');
  select string_agg(column_name, ',' order by ordinal_position) into v_cols from information_schema.columns
   where table_schema = 'public' and table_name = 'public_bundle_items';
  perform pg_temp.must(v_cols = 'bundle_id,quantity,brand_name,product_name,size_ml', 'the public pieces view has no catalog id (got ' || coalesce(v_cols, 'NULL') || ')');
  perform pg_temp.must(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'store_bundles'
                                      and column_name in ('original_price', 'discount_percentage')),
    'a store cannot claim an old price or a discount on a bundle');
  perform pg_temp.must(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bundles' and column_name = 'description'),
    'the platform proposes no description of a bundle: the description is the store''s');

  -- 6. the visitor and the signed-in customer read the views, never the tables; the server writes the pieces ----------------------------
  -- (the checks run after RESET ROLE: a temp function of this session is not callable by the API roles)
  set local role anon;
  select count(*) into v_anon_views from public.catalog_platform_bundle_offers where bundle_id in (v_b1, v_b2);
  begin perform 1 from public.bundles limit 1; exception when insufficient_privilege then v_anon_read := true; end;
  begin insert into public.store_bundles (store_id, bundle_id, title, price, stock_quantity) values (v_a, v_b5, 'x', 10, 1); exception when insufficient_privilege then v_anon_write := true; end;
  reset role;
  set local role authenticated;
  select count(*) into v_auth_views from public.public_bundles where id in (v_b1, v_b2);
  begin perform 1 from public.store_bundles limit 1; exception when insufficient_privilege then v_auth_read := true; end;
  begin update public.bundles set name = 'x' where id = v_b1; exception when insufficient_privilege then v_auth_write := true; end;
  reset role;
  set local role service_role;
  begin insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_b5, 'Server Brand', 'Server piece', 30, 1); v_server_write := true; exception when others then v_server_write := false; end;
  reset role;
  select count(*) into v_pieces from public.bundle_items where bundle_id = v_b5;
  perform pg_temp.must(v_anon_views = 2, 'anon reads the platform bundle offers (got ' || v_anon_views || ')');
  perform pg_temp.must(v_auth_views = 2, 'a signed-in customer reads the public bundles (got ' || v_auth_views || ')');
  perform pg_temp.must(v_anon_read and v_auth_read, 'neither the visitor nor the customer can read the bundle tables');
  perform pg_temp.must(v_anon_write and v_auth_write, 'neither the visitor nor the customer can write the bundle tables');
  perform pg_temp.must(v_server_write and v_pieces = 1, 'the server role can write bundle pieces');
end
$test$;

rollback;
