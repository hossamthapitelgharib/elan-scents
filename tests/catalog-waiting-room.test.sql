-- Real-database test of the CATALOG WAITING ROOM (migration catalog_waiting_room, owner's agreement of 17-20 Nov 2026).
-- Run on the live database as the project owner inside this one transaction; every fixture row is synthetic and the final ROLLBACK
-- discards all of it.
--
--   * a perfume whose brand is not on the platform WAITS: no product is created, nothing is lost, the visitor sees nothing;
--   * the moment a brand card exists (created, renamed, re-activated) or an alias is added, the waiting perfumes are placed by themselves
--     and from then on the normal visibility rules decide: the cheapest eligible offer per size wins, a brand at one store makes that
--     store the cheapest, a sold-out cheapest hands over to the next store;
--   * ONE entry point, public.catalog_receive_items, for the trial loader today and the real store sync later; re-sending the same batch
--     creates nothing twice; a bad item is refused with its reason and never stops the others;
--   * the same perfume at two stores is ONE product (brand + normalized name); an ALL-CAPS name is shown in Title Case;
--   * an offer that came from another data source is never overwritten; two brand cards with the same normalized name are never guessed between;
--   * creating a brand card never fails because of the waiting room;
--   * everything is server-only: neither the visitor nor a signed-in customer can read or write the two tables or call any of the functions.
begin;

create function pg_temp.must(ok boolean, msg text) returns void language plpgsql as $f$
begin
  if ok is not true then raise exception 'catalog waiting room: %', msg; end if;
end $f$;

do $test$
declare
  v_a uuid := gen_random_uuid();        -- Store A
  v_b uuid := gen_random_uuid();        -- Store B
  v_tag text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_brand text := 'Zzwait ' || v_tag;                    -- the brand every store spells the same way
  v_brand_id uuid;
  v_res jsonb; v_res2 jsonb; v_row record;
  v_prod uuid; v_prod2 uuid; v_size uuid;
  v_n integer; v_n2 integer; v_cnt_before integer; v_cnt_after integer;
  v_price numeric; v_store uuid; v_visible integer; v_denied boolean;
  v_items jsonb;
  v_snapshot_products integer := (select count(*) from public.products);
  v_snapshot_offers integer := (select count(*) from public.store_products);
  v_snapshot_brands integer := (select count(*) from public.brands);
  v_snapshot_public integer := (select count(*) from public.public_products);
begin
  insert into public.stores (id, name, slug, status, commission_rate, priority_rank) values
    (v_a, 'Waiting A', 'wr-a-' || v_a::text, 'active', 15, 100),
    (v_b, 'Waiting B', 'wr-b-' || v_b::text, 'active', 15, 100);

  -----------------------------------------------------------------------------------------------------------------------
  -- 1. A brand that is not on the platform: its perfumes wait, nothing else is created.
  -----------------------------------------------------------------------------------------------------------------------
  v_res := public.catalog_receive_items(v_a, jsonb_build_array(
    jsonb_build_object('brand', v_brand, 'name', 'NIGHT BLOOM', 'size_ml', 100, 'price', 1500, 'stock_quantity', 10, 'gender', 'unisex', 'product_url', 'https://a.example/night-bloom'),
    jsonb_build_object('brand', v_brand, 'name', 'NIGHT BLOOM', 'size_ml', 50, 'price', 900, 'stock_quantity', 4),
    jsonb_build_object('brand', v_brand, 'name', 'Desert Rose', 'size_ml', 100, 'price', 2100, 'stock_quantity', 0)), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'received')::int = 3 and (v_res ->> 'waiting')::int = 3 and (v_res ->> 'placed')::int = 0, 'three perfumes of an unknown brand wait: ' || v_res::text);
  perform pg_temp.must((select count(*) from public.products) = v_snapshot_products, 'waiting creates no product');
  perform pg_temp.must((select count(*) from public.store_products) = v_snapshot_offers, 'waiting creates no offer');
  perform pg_temp.must((select count(*) from public.catalog_waiting_items where store_id = v_a and released_at is null and status = 'waiting') = 3, 'three open waiting rows');

  -- re-sending the same perfume updates its row, never adds one (and keeps the latest price and stock)
  v_res := public.catalog_receive_items(v_a, jsonb_build_array(
    jsonb_build_object('brand', upper(v_brand), 'name', 'Night  Bloom', 'size_ml', 100, 'price', 1450, 'stock_quantity', 9, 'gender', 'unisex')), 'trial_catalog');
  perform pg_temp.must((select count(*) from public.catalog_waiting_items where store_id = v_a) = 3, 'the same perfume spelled differently is the same waiting row');
  perform pg_temp.must((select price from public.catalog_waiting_items where store_id = v_a and size_ml = 100 and name_norm = 'nightbloom') = 1450, 'the waiting row holds the latest price');

  -----------------------------------------------------------------------------------------------------------------------
  -- 2. Bad items are refused with the reason and never stop the good ones; nothing is completed or guessed.
  -----------------------------------------------------------------------------------------------------------------------
  v_res := public.catalog_receive_items(v_a, jsonb_build_array(
    '"just a string"'::jsonb,
    jsonb_build_object('name', 'No Brand', 'size_ml', 100, 'price', 10, 'stock_quantity', 1),
    jsonb_build_object('brand', v_brand, 'size_ml', 100, 'price', 10, 'stock_quantity', 1),
    jsonb_build_object('brand', v_brand, 'name', 'No Size', 'price', 10, 'stock_quantity', 1),
    jsonb_build_object('brand', v_brand, 'name', 'Fraction Size', 'size_ml', 99.5, 'price', 10, 'stock_quantity', 1),
    jsonb_build_object('brand', v_brand, 'name', 'Text Size', 'size_ml', '100', 'price', 10, 'stock_quantity', 1),
    jsonb_build_object('brand', v_brand, 'name', 'Free', 'size_ml', 100, 'price', 0, 'stock_quantity', 1),
    jsonb_build_object('brand', v_brand, 'name', 'No Stock', 'size_ml', 100, 'price', 10),
    jsonb_build_object('brand', v_brand, 'name', 'Negative Stock', 'size_ml', 100, 'price', 10, 'stock_quantity', -1),
    jsonb_build_object('brand', v_brand, 'name', 'Dollars', 'size_ml', 100, 'price', 10, 'stock_quantity', 1, 'currency', 'USD'),
    jsonb_build_object('brand', v_brand, 'name', 'Odd Gender', 'size_ml', 100, 'price', 10, 'stock_quantity', 1, 'gender', 'kids'),
    jsonb_build_object('brand', v_brand, 'name', 'Bad Link', 'size_ml', 100, 'price', 10, 'stock_quantity', 1, 'product_url', 'javascript:alert(1)'),
    jsonb_build_object('brand', '  !!  ', 'name', 'Symbols Only Brand', 'size_ml', 100, 'price', 10, 'stock_quantity', 1),
    jsonb_build_object('brand', v_brand, 'name', 'Good One', 'size_ml', 30, 'price', 300, 'stock_quantity', 2)), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'rejected')::int = 13 and (v_res ->> 'waiting')::int = 1, 'thirteen refused, the good one waits: ' || v_res::text);
  perform pg_temp.must((v_res -> 'items' -> 0 ->> 'reason') = 'not_an_object', 'a string is not an item');
  perform pg_temp.must((v_res -> 'items' -> 1 ->> 'reason') = 'brand_missing', 'no brand');
  perform pg_temp.must((v_res -> 'items' -> 2 ->> 'reason') = 'name_missing', 'no name');
  perform pg_temp.must((v_res -> 'items' -> 3 ->> 'reason') = 'size_invalid' and (v_res -> 'items' -> 4 ->> 'reason') = 'size_invalid' and (v_res -> 'items' -> 5 ->> 'reason') = 'size_invalid', 'no size, a fraction of a ml and a text size are refused');
  perform pg_temp.must((v_res -> 'items' -> 6 ->> 'reason') = 'price_invalid', 'a free perfume is refused');
  perform pg_temp.must((v_res -> 'items' -> 7 ->> 'reason') = 'stock_invalid' and (v_res -> 'items' -> 8 ->> 'reason') = 'stock_invalid', 'the stock must be sent as a number, never negative');
  perform pg_temp.must((v_res -> 'items' -> 9 ->> 'reason') = 'currency_not_egp', 'only EGP');
  perform pg_temp.must((v_res -> 'items' -> 10 ->> 'reason') = 'gender_invalid', 'only men, women or unisex');
  perform pg_temp.must((v_res -> 'items' -> 11 ->> 'reason') = 'url_invalid', 'only an http(s) link');
  perform pg_temp.must((v_res -> 'items' -> 12 ->> 'reason') = 'brand_missing', 'a brand of symbols only is no brand');
  perform pg_temp.must((v_res -> 'items' -> 13 ->> 'status') = 'waiting', 'the good item after thirteen bad ones is still received');
  perform pg_temp.must(public.catalog_receive_items(v_a, '[]'::jsonb) ->> 'received' = '0', 'an empty batch is fine');
  begin perform public.catalog_receive_items(v_a, '{"a":1}'::jsonb); perform pg_temp.must(false, 'a non-array is refused'); exception when sqlstate '22023' then null; end;
  begin perform public.catalog_receive_items(gen_random_uuid(), '[]'::jsonb); perform pg_temp.must(false, 'an unknown store is refused'); exception when sqlstate '22023' then null; end;
  begin perform public.catalog_receive_items(v_a, '[]'::jsonb, 'something_else'); perform pg_temp.must(false, 'an unknown data source is refused'); exception when sqlstate '22023' then null; end;
  begin
    select jsonb_agg(jsonb_build_object('brand', v_brand, 'name', 'N' || g, 'size_ml', 100, 'price', 10, 'stock_quantity', 1)) into v_items from generate_series(1, 1001) g;
    perform public.catalog_receive_items(v_a, v_items);
    perform pg_temp.must(false, 'more than 1000 items in one call are refused');
  exception when sqlstate '22023' then null; end;

  -----------------------------------------------------------------------------------------------------------------------
  -- 3. The brand card is created: the waiting perfumes are placed by themselves, nobody calls anything.
  -----------------------------------------------------------------------------------------------------------------------
  select count(*) into v_n from public.catalog_waiting_items where store_id = v_a and released_at is null and status = 'waiting';
  insert into public.brands (name, slug) values (v_brand, 'zzwait-' || v_tag) returning id into v_brand_id;
  perform pg_temp.must((select count(*) from public.products where brand_id = v_brand_id) = 3, 'the brand card brings its four waiting sizes as three perfumes: Night Bloom, Desert Rose, Good One');
  perform pg_temp.must((select count(*) from public.store_products sp join public.product_sizes ps on ps.id = sp.product_size_id join public.products p on p.id = ps.product_id where p.brand_id = v_brand_id) = v_n, 'one offer per waiting row');
  perform pg_temp.must((select count(*) from public.catalog_waiting_items where store_id = v_a and released_at is null) = 0, 'nothing is left waiting');
  perform pg_temp.must((select count(*) from public.catalog_waiting_items where store_id = v_a and released_at is not null) = v_n, 'the rows are kept as history with their release time, not deleted');
  select id, name, gender, status, is_active into v_row from public.products where brand_id = v_brand_id and name = 'Night Bloom';
  perform pg_temp.must(v_row.id is not null, 'an ALL-CAPS name is shown in Title Case: Night Bloom');
  perform pg_temp.must(v_row.gender = 'unisex' and v_row.status = 'published' and v_row.is_active, 'the perfume is published with the gender the store sent');
  perform pg_temp.must((select price from public.store_products sp join public.product_sizes ps on ps.id = sp.product_size_id where ps.product_id = v_row.id and ps.size_ml = 100) = 1450, 'the offer carries the LATEST price (1450, not the first 1500)');
  perform pg_temp.must((select data_source from public.store_products sp join public.product_sizes ps on ps.id = sp.product_size_id where ps.product_id = v_row.id and ps.size_ml = 100) = 'trial_catalog', 'the offer keeps the data source the loader declared');

  -- what the visitor sees: the brand's perfumes with stock; the sold-out Desert Rose (stock 0) stays hidden
  set local role anon;
  select count(*) into v_visible from public.public_products where brand_id = v_brand_id;
  reset role;
  perform pg_temp.must(v_visible = 2, 'the visitor sees the two perfumes that have stock (Night Bloom, Good One), not the sold-out one: ' || v_visible);

  -----------------------------------------------------------------------------------------------------------------------
  -- 4. Same perfume at two stores: ONE product, the cheapest eligible offer per size, a sold-out cheapest hands over.
  -----------------------------------------------------------------------------------------------------------------------
  select count(*) into v_cnt_before from public.products where brand_id = v_brand_id;
  v_res := public.catalog_receive_items(v_b, jsonb_build_array(
    jsonb_build_object('brand', v_brand, 'name', 'NIGHT  BLOOM', 'size_ml', 100, 'price', 1300, 'stock_quantity', 5, 'gender', 'unisex'),
    jsonb_build_object('brand', v_brand, 'name', 'Night Bloom', 'size_ml', 200, 'price', 2500, 'stock_quantity', 3)), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'placed')::int = 2, 'the second store''s two sizes are placed straight away (the brand exists): ' || v_res::text);
  select count(*) into v_cnt_after from public.products where brand_id = v_brand_id;
  perform pg_temp.must(v_cnt_after = v_cnt_before, 'the same perfume at the second store is the same product (brand + normalized name)');
  select id into v_prod from public.products where brand_id = v_brand_id and name = 'Night Bloom';
  perform pg_temp.must((select count(*) from public.product_sizes where product_id = v_prod) = 3, 'sizes 50, 100 and 200');
  set local role anon;
  select store_id, price into v_store, v_price from public.catalog_platform_offers where product_id = v_prod and product_size_id = (select id from public.product_sizes where product_id = v_prod and size_ml = 100);
  reset role;
  perform pg_temp.must(v_store = v_b and v_price = 1300, 'size 100: the platform offer is the cheaper store B at 1300');
  set local role anon;
  select store_id, price into v_store, v_price from public.catalog_platform_offers where product_id = v_prod and product_size_id = (select id from public.product_sizes where product_id = v_prod and size_ml = 200);
  reset role;
  perform pg_temp.must(v_store = v_b and v_price = 2500, 'size 200: only store B sells it, so B is the cheapest by itself');
  -- the cheapest store sells out: the next store takes over
  v_res := public.catalog_receive_items(v_b, jsonb_build_array(
    jsonb_build_object('brand', v_brand, 'name', 'Night Bloom', 'size_ml', 100, 'price', 1300, 'stock_quantity', 0)), 'trial_catalog');
  set local role anon;
  select store_id, price into v_store, v_price from public.catalog_platform_offers where product_id = v_prod and product_size_id = (select id from public.product_sizes where product_id = v_prod and size_ml = 100);
  reset role;
  perform pg_temp.must(v_store = v_a and v_price = 1450, 'B sold out: the platform offer is A at 1450');
  -- an explicit available = false from the store hides the offer even with stock
  v_res := public.catalog_receive_items(v_a, jsonb_build_array(
    jsonb_build_object('brand', v_brand, 'name', 'Night Bloom', 'size_ml', 100, 'price', 1450, 'stock_quantity', 9, 'available', false)), 'trial_catalog');
  set local role anon;
  select count(*) into v_n from public.catalog_platform_offers where product_id = v_prod and product_size_id = (select id from public.product_sizes where product_id = v_prod and size_ml = 100);
  reset role;
  perform pg_temp.must(v_n = 0, 'an offer the store marks unavailable is not shown even with stock');
  v_res := public.catalog_receive_items(v_a, jsonb_build_array(
    jsonb_build_object('brand', v_brand, 'name', 'Night Bloom', 'size_ml', 100, 'price', 1450, 'stock_quantity', 9)), 'trial_catalog');

  -----------------------------------------------------------------------------------------------------------------------
  -- 5. Re-sending the whole batch creates nothing twice.
  -----------------------------------------------------------------------------------------------------------------------
  select count(*) into v_n from public.products; select count(*) into v_n2 from public.store_products;
  select count(*) into v_cnt_before from public.product_sizes;
  v_res2 := public.catalog_receive_items(v_a, jsonb_build_array(
    jsonb_build_object('brand', v_brand, 'name', 'NIGHT BLOOM', 'size_ml', 100, 'price', 1450, 'stock_quantity', 9, 'gender', 'unisex'),
    jsonb_build_object('brand', v_brand, 'name', 'NIGHT BLOOM', 'size_ml', 50, 'price', 900, 'stock_quantity', 4),
    jsonb_build_object('brand', v_brand, 'name', 'Desert Rose', 'size_ml', 100, 'price', 2100, 'stock_quantity', 0)), 'trial_catalog');
  perform pg_temp.must((v_res2 ->> 'placed')::int = 3, 'the same three are accepted again');
  perform pg_temp.must((select count(*) from public.products) = v_n and (select count(*) from public.store_products) = v_n2 and (select count(*) from public.product_sizes) = v_cnt_before, 're-sending creates no product, size or offer');

  -----------------------------------------------------------------------------------------------------------------------
  -- 6. An alias, a rename and a re-activation also release the waiting perfumes.
  -----------------------------------------------------------------------------------------------------------------------
  -- alias
  v_res := public.catalog_receive_items(v_a, jsonb_build_array(
    jsonb_build_object('brand', 'Zzalias ' || v_tag || ' Perfumes', 'name', 'Alias Perfume', 'size_ml', 100, 'price', 700, 'stock_quantity', 5)), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'waiting')::int = 1, 'a brand spelled "X Perfumes" waits while the card is called X');
  insert into public.brands (name, slug) values ('Zzalias ' || v_tag, 'zzalias-' || v_tag) returning id into v_brand_id;
  perform pg_temp.must((select count(*) from public.products where brand_id = v_brand_id) = 0, 'the card X does not take "X Perfumes" by guessing');
  insert into public.catalog_brand_aliases (brand_id, alias_text) values (v_brand_id, 'Zzalias ' || v_tag || ' Perfumes');
  perform pg_temp.must((select count(*) from public.products where brand_id = v_brand_id) = 1, 'adding the alias releases the waiting perfume');
  v_res := public.catalog_receive_items(v_b, jsonb_build_array(
    jsonb_build_object('brand', 'ZZALIAS ' || v_tag || ' perfumes', 'name', 'Alias Perfume', 'size_ml', 100, 'price', 650, 'stock_quantity', 5)), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'placed')::int = 1, 'once the alias exists a store''s spelling is placed straight away');
  begin insert into public.catalog_brand_aliases (brand_id, alias_text) values (v_brand_id, 'zzalias ' || v_tag || ' PERFUMES'); perform pg_temp.must(false, 'an alias is unique after normalizing'); exception when unique_violation then null; end;
  -- rename
  v_res := public.catalog_receive_items(v_a, jsonb_build_array(
    jsonb_build_object('brand', 'Zzrenamed ' || v_tag, 'name', 'Renamed Perfume', 'size_ml', 100, 'price', 700, 'stock_quantity', 5)), 'trial_catalog');
  insert into public.brands (name, slug) values ('Zzold ' || v_tag, 'zzold-' || v_tag) returning id into v_brand_id;
  perform pg_temp.must((select count(*) from public.products where brand_id = v_brand_id) = 0, 'a brand card with another name takes nothing');
  update public.brands set name = 'Zzrenamed ' || v_tag where id = v_brand_id;
  perform pg_temp.must((select count(*) from public.products where brand_id = v_brand_id) = 1, 'renaming the card to the store''s brand releases the waiting perfume');
  -- inactive brand = not on the platform; re-activating releases
  update public.brands set is_active = false where id = v_brand_id;
  v_res := public.catalog_receive_items(v_b, jsonb_build_array(
    jsonb_build_object('brand', 'Zzrenamed ' || v_tag, 'name', 'Second Renamed', 'size_ml', 100, 'price', 800, 'stock_quantity', 5)), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'waiting')::int = 1, 'an inactive brand card is not on the platform: the perfume waits');
  update public.brands set is_active = true where id = v_brand_id;
  perform pg_temp.must((select count(*) from public.products where brand_id = v_brand_id) = 2, 're-activating the card releases it');

  -----------------------------------------------------------------------------------------------------------------------
  -- 7. Never guessed: two active cards with the same normalized name hold the item; an offer of another source is never overwritten.
  -----------------------------------------------------------------------------------------------------------------------
  insert into public.brands (name, slug) values ('Zzdup ' || v_tag, 'zzdup-1-' || v_tag), ('ZZ-DUP ' || v_tag, 'zzdup-2-' || v_tag);
  v_res := public.catalog_receive_items(v_a, jsonb_build_array(
    jsonb_build_object('brand', 'zzdup ' || v_tag, 'name', 'Which Brand', 'size_ml', 100, 'price', 500, 'stock_quantity', 5)), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'held')::int = 1 and (v_res -> 'items' -> 0 ->> 'reason') = 'ambiguous_brand', 'two cards with the same normalized name: the item is held, not guessed: ' || v_res::text);
  perform pg_temp.must((select status from public.catalog_waiting_items where store_id = v_a and name_norm = 'whichbrand') = 'held', 'the held item is kept in the waiting room with status held');
  perform pg_temp.must(public.catalog_release_waiting(null) >= 0, 'the server can run the release again');
  perform pg_temp.must((select status from public.catalog_waiting_items where store_id = v_a and name_norm = 'whichbrand') = 'held', 'a held item is never released by itself');

  v_res := public.catalog_receive_items(v_a, jsonb_build_array(
    jsonb_build_object('brand', v_brand, 'name', 'Night Bloom', 'size_ml', 100, 'price', 1, 'stock_quantity', 1)), 'store_catalog');
  perform pg_temp.must((v_res ->> 'held')::int = 1 and (v_res -> 'items' -> 0 ->> 'reason') = 'source_conflict', 'a store_catalog item never overwrites a trial_catalog offer: ' || v_res::text);
  perform pg_temp.must((select price from public.store_products sp join public.product_sizes ps on ps.id = sp.product_size_id where ps.product_id = v_prod and ps.size_ml = 100 and sp.store_id = v_a) = 1450, 'the trial offer is untouched');

  -----------------------------------------------------------------------------------------------------------------------
  -- 8. Creating a brand card never fails because of the waiting room, even with many perfumes waiting.
  -----------------------------------------------------------------------------------------------------------------------
  select jsonb_agg(jsonb_build_object('brand', 'Zzbulk ' || v_tag, 'name', 'BULK PERFUME ' || g, 'size_ml', 100, 'price', 100 + g, 'stock_quantity', 3)) into v_items from generate_series(1, 300) g;
  v_res := public.catalog_receive_items(v_a, v_items, 'trial_catalog');
  perform pg_temp.must((v_res ->> 'waiting')::int = 300, 'three hundred perfumes wait');
  insert into public.brands (name, slug) values ('Zzbulk ' || v_tag, 'zzbulk-' || v_tag) returning id into v_brand_id;
  perform pg_temp.must((select count(*) from public.products where brand_id = v_brand_id) = 300, 'three hundred perfumes are placed by one brand insert');
  perform pg_temp.must((select count(*) from public.catalog_waiting_items where store_id = v_a and brand_norm = private.bundle_norm('Zzbulk ' || v_tag) and released_at is null) = 0, 'none is left waiting');
  perform pg_temp.must((select max(char_length(slug)) from public.products where brand_id = v_brand_id) < 120, 'slugs stay sane');

  -----------------------------------------------------------------------------------------------------------------------
  -- 9. Names: the display rule and the slug of a name with no Latin letters.
  -----------------------------------------------------------------------------------------------------------------------
  perform pg_temp.must(private.catalog_display_name('SUPREMACY GALA') = 'Supremacy Gala', 'ALL CAPS -> Title Case');
  perform pg_temp.must(private.catalog_display_name('9 PM NIGHT OUT') = '9 PM Night Out', 'a token with a digit or AM/PM stays');
  perform pg_temp.must(private.catalog_display_name('AL-RAWDAH') = 'Al-Rawdah', 'hyphenated parts are each capitalized');
  perform pg_temp.must(private.catalog_display_name('COLLECTOR''S EDITION') = 'Collector''s Edition', 'an apostrophe does not split a word');
  perform pg_temp.must(private.catalog_display_name('Kiaana Vibes') = 'Kiaana Vibes' and private.catalog_display_name('9AM dive') = '9AM dive', 'a name with a lower-case letter is the store''s own spelling');
  perform pg_temp.must(private.catalog_display_name('  extra   spaces ') = 'extra spaces', 'spaces are collapsed');
  insert into public.brands (name, slug) values ('Zzarabic ' || v_tag, 'zzarabic-' || v_tag) returning id into v_brand_id;
  v_res := public.catalog_receive_items(v_a, jsonb_build_array(
    jsonb_build_object('brand', 'Zzarabic ' || v_tag, 'name', 'عود ملكي', 'size_ml', 100, 'price', 900, 'stock_quantity', 5)), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'placed')::int = 1, 'an Arabic name is placed');
  perform pg_temp.must((select slug from public.products where brand_id = v_brand_id) like 'zzarabic-' || v_tag || '-p-%', 'an Arabic name gets a safe slug');

  -----------------------------------------------------------------------------------------------------------------------
  -- 10. Server-only: neither the visitor nor a signed-in customer reaches the tables or the functions.
  -----------------------------------------------------------------------------------------------------------------------
  perform pg_temp.must(not has_function_privilege('anon', 'public.catalog_receive_items(uuid,jsonb,text)', 'execute')
                   and not has_function_privilege('authenticated', 'public.catalog_receive_items(uuid,jsonb,text)', 'execute')
                   and has_function_privilege('service_role', 'public.catalog_receive_items(uuid,jsonb,text)', 'execute'), 'only the server receives items');
  perform pg_temp.must(not has_function_privilege('anon', 'public.catalog_release_waiting(uuid)', 'execute')
                   and not has_function_privilege('authenticated', 'public.catalog_release_waiting(uuid)', 'execute')
                   and has_function_privilege('service_role', 'public.catalog_release_waiting(uuid)', 'execute'), 'only the server runs the release');
  perform pg_temp.must(not has_function_privilege('anon', 'private.catalog_place_item(uuid,uuid,text,text,integer,numeric,integer,boolean,text,text)', 'execute')
                   and not has_function_privilege('authenticated', 'private.catalog_place_item(uuid,uuid,text,text,integer,numeric,integer,boolean,text,text)', 'execute')
                   and not has_function_privilege('authenticated', 'private.catalog_release_waiting(uuid)', 'execute'), 'the private helpers are closed too');
  set local role anon;
  v_denied := false; begin perform 1 from public.catalog_waiting_items limit 1; exception when insufficient_privilege then v_denied := true; end;
  reset role; perform pg_temp.must(v_denied, 'a visitor cannot read the waiting room');
  set local role authenticated;
  v_denied := false; begin perform 1 from public.catalog_waiting_items limit 1; exception when insufficient_privilege then v_denied := true; end;
  reset role; perform pg_temp.must(v_denied, 'a signed-in customer cannot read the waiting room');
  set local role authenticated;
  v_denied := false; begin insert into public.catalog_waiting_items (store_id, data_source, brand_text, name, size_ml, price, stock_quantity, is_available) values (v_a, 'trial_catalog', 'x', 'y', 1, 1, 1, true); exception when insufficient_privilege then v_denied := true; end;
  reset role; perform pg_temp.must(v_denied, 'a customer cannot write the waiting room');
  set local role authenticated;
  v_denied := false; begin perform 1 from public.catalog_brand_aliases limit 1; exception when insufficient_privilege then v_denied := true; end;
  reset role; perform pg_temp.must(v_denied, 'a customer cannot read the brand aliases');
  set local role anon;
  v_denied := false; begin insert into public.catalog_brand_aliases (brand_id, alias_text) values (v_brand_id, 'forged alias'); exception when insufficient_privilege then v_denied := true; end;
  reset role; perform pg_temp.must(v_denied, 'a visitor cannot add a brand alias');
  set local role anon;
  v_denied := false; begin perform public.catalog_receive_items(v_a, '[]'::jsonb); exception when insufficient_privilege then v_denied := true; end;
  reset role; perform pg_temp.must(v_denied, 'a visitor calling the entry point is refused');
  set local role authenticated;
  v_denied := false; begin perform public.catalog_release_waiting(null); exception when insufficient_privilege then v_denied := true; end;
  reset role; perform pg_temp.must(v_denied, 'a customer calling the release is refused');
  perform pg_temp.must((select relrowsecurity from pg_class where oid = 'public.catalog_waiting_items'::regclass) and (select relrowsecurity from pg_class where oid = 'public.catalog_brand_aliases'::regclass), 'row level security is on for both tables');

  -----------------------------------------------------------------------------------------------------------------------
  -- 11. The seeded spellings point at the right cards, and the live catalog was not touched by the checks above (they are rolled back).
  -----------------------------------------------------------------------------------------------------------------------
  perform pg_temp.must((select count(*) from public.catalog_brand_aliases a join public.brands b on b.id = a.brand_id where b.slug = 'afnan') = 2, 'Afnan keeps its two agreed spellings');
  perform pg_temp.must((select count(*) from public.brands) > v_snapshot_brands and (select count(*) from public.public_brands) >= 0, 'fixture brands exist only inside this transaction');

  -----------------------------------------------------------------------------------------------------------------------
  -- 12. The real path of the owner's brand card: the editor creates it through the server (service_role), not as the project owner.
  --     The release must run from the trigger there too, and the card must be created whatever the waiting room does.
  -----------------------------------------------------------------------------------------------------------------------
  v_res := public.catalog_receive_items(v_a, jsonb_build_array(
    jsonb_build_object('brand', 'Zzserver ' || v_tag, 'name', 'SERVER PERFUME', 'size_ml', 100, 'price', 800, 'stock_quantity', 5, 'gender', 'women'),
    jsonb_build_object('brand', 'Zzserver ' || v_tag, 'name', 'SERVER PERFUME TWO', 'size_ml', 50, 'price', 500, 'stock_quantity', 5)), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'waiting')::int = 2, 'two perfumes wait for a card that does not exist yet');
  set local role service_role;
  insert into public.brands (name, slug) values ('Zzserver ' || v_tag, 'zzserver-' || v_tag) returning id into v_brand_id;
  reset role;
  perform pg_temp.must((select count(*) from public.products where brand_id = v_brand_id) = 2, 'a card created by the server role releases the waiting perfumes by itself');
  perform pg_temp.must((select count(*) from public.catalog_waiting_items where brand_norm = private.bundle_norm('Zzserver ' || v_tag) and released_at is null) = 0, 'nothing is left waiting after the server role created the card');
  set local role anon;
  select count(*) into v_visible from public.public_products where brand_id = v_brand_id;
  reset role;
  perform pg_temp.must(v_visible = 2, 'the visitor sees both perfumes of the new card');
end
$test$;

rollback;
