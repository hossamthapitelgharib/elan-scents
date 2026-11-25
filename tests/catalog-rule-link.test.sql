-- Real-database test of the CATALOG RULE LINK (migration supabase/migrations/20261125122045_catalog_rule_link.sql, applied 2026-11-25; owner's decisions of 23-24 Nov 2026).
-- Run on the live database as the project owner inside this one transaction; every fixture row is synthetic and the final ROLLBACK discards all of it.
--
--   * ONE entry point, public.catalog_receive_items: a perfume item may carry the merchant's offer sections (`offers`): saved as offer messages on its
--     size, a perfume that waits for its brand card keeps them and writes them when it is released; a section the merchant took it out of makes the
--     message go quiet (never deleted); a message written by hand is adopted, one of another data source is never overwritten; no price is touched;
--   * an item with kind = 'bundle' is a store product the automatic rule found to be a bundle: written with the merchant's own title and FULL text,
--     its contents lines as pieces; a SURE bundle is published, a DOUBTFUL one is a draft hidden from visitors that waits in the review queue;
--   * the owner's answer on a doubtful product is kept once per store and product and wins on every later sync (bundle publishes it, not_bundle hides it);
--   * re-sending creates nothing twice; an older bundle of the same store is adopted by its product link, never duplicated; another data source's
--     bundle is never overwritten; a bad item is refused with its reason and never stops the others;
--   * everything is server-only: a visitor or a customer can neither read nor write the new table nor call any of the functions.
begin;

create function pg_temp.must(ok boolean, msg text) returns void language plpgsql as $f$
begin
  if ok is not true then raise exception 'catalog rule link: %', msg; end if;
end $f$;

do $test$
declare
  v_s uuid := gen_random_uuid();
  v_s2 uuid := gen_random_uuid();
  v_tag text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_brand text := 'Zzlink ' || v_tag;
  v_nocard text := 'Zznocard ' || v_tag;
  v_brand_id uuid; v_size uuid; v_size2 uuid; v_prod uuid;
  v_res jsonb; v_n integer; v_n2 integer; v_row record; v_sb record; v_b record;
  v_price_before numeric; v_visible integer; v_denied boolean; v_text text;
  v_snap_products integer := (select count(*) from public.products);
  v_snap_offers integer := (select count(*) from public.offers);
  v_snap_bundles integer := (select count(*) from public.bundles);
  v_snap_sb integer := (select count(*) from public.store_bundles);
  v_legacy_bundle uuid; v_legacy_item uuid;
begin
  insert into public.stores (id, name, slug, status, commission_rate, priority_rank) values
    (v_s, 'Link A', 'rl-a-' || v_s::text, 'active', 15, 100),
    (v_s2, 'Link B', 'rl-b-' || v_s2::text, 'active', 15, 100);
  insert into public.brands (name, slug) values (v_brand, 'zzlink-' || v_tag) returning id into v_brand_id;

  -----------------------------------------------------------------------------------------------------------------------
  -- 1. A perfume in the merchant's offer sections: its offer messages are written, the price is the platform's normal price.
  -----------------------------------------------------------------------------------------------------------------------
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('brand', v_brand, 'name', 'NIGHT BLOOM', 'size_ml', 100, 'price', 1500, 'stock_quantity', 10, 'gender', 'unisex',
                       'offers', jsonb_build_array('INSANE DEALS', 'Black Friday', '  insane deals ')),
    jsonb_build_object('brand', v_brand, 'name', 'Plain One', 'size_ml', 50, 'price', 700, 'stock_quantity', 5)), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'placed')::int = 2 and (v_res ->> 'rejected')::int = 0, 'both perfumes are placed: ' || v_res::text);
  select ps.id, ps.product_id into v_size, v_prod from public.product_sizes ps join public.products p on p.id = ps.product_id where p.brand_id = v_brand_id and p.name = 'Night Bloom' and ps.size_ml = 100;
  perform pg_temp.must(v_size is not null, 'the perfume and its size exist');
  perform pg_temp.must((select count(*) from public.offers where product_size_id = v_size and is_active) = 2, 'two offer messages (the repeated section name is written once): INSANE DEALS and Black Friday');
  perform pg_temp.must((select count(*) from public.offers where product_size_id = v_size and title = 'INSANE DEALS' and kind = 'offer' and catalog_source = 'trial_catalog' and store_id = v_s) = 1, 'the offer carries the merchant''s own words, the kind offer and the data source');
  perform pg_temp.must((select count(*) from public.offers o join public.product_sizes ps on ps.id = o.product_size_id where ps.product_id = (select id from public.products where brand_id = v_brand_id and name = 'Plain One')) = 0, 'a perfume the merchant did not put in an offer gets none');
  perform pg_temp.must((select price from public.store_products where product_size_id = v_size and store_id = v_s) = 1500, 'no price was touched by the offer message');
  set local role anon;
  select count(*) into v_n from public.catalog_offer_messages where product_size_id = v_size;
  select count(*) into v_visible from public.public_products where brand_id = v_brand_id;
  reset role;
  perform pg_temp.must(v_n = 2, 'the visitor reads both messages of the perfume');
  perform pg_temp.must(v_visible = 2, 'the perfume still shows by the normal visibility rules (the offer changed nothing): ' || v_visible);

  -- the merchant takes the perfume out of one section: the message goes quiet, nothing is deleted
  v_n := (select count(*) from public.offers where product_size_id = v_size);
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('brand', v_brand, 'name', 'Night Bloom', 'size_ml', 100, 'price', 1500, 'stock_quantity', 10, 'offers', jsonb_build_array('Black Friday'))), 'trial_catalog');
  perform pg_temp.must((select count(*) from public.offers where product_size_id = v_size) = v_n, 'no offer row was deleted');
  perform pg_temp.must((select is_active from public.offers where product_size_id = v_size and title = 'INSANE DEALS') = false, 'the section the merchant left goes quiet');
  perform pg_temp.must((select is_active from public.offers where product_size_id = v_size and title = 'Black Friday') = true, 'the section it is still in stays on');
  -- the section comes back: the same row is switched on again, not a second row
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('brand', v_brand, 'name', 'Night Bloom', 'size_ml', 100, 'price', 1500, 'stock_quantity', 10, 'offers', jsonb_build_array('INSANE DEALS', 'Black Friday'))), 'trial_catalog');
  perform pg_temp.must((select count(*) from public.offers where product_size_id = v_size) = v_n and (select count(*) from public.offers where product_size_id = v_size and is_active) = 2, 'the returning section reuses its row');
  -- an item sent WITHOUT the offers field never touches the messages (an older caller)
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('brand', v_brand, 'name', 'Night Bloom', 'size_ml', 100, 'price', 1500, 'stock_quantity', 10)), 'trial_catalog');
  perform pg_temp.must((select count(*) from public.offers where product_size_id = v_size and is_active) = 2, 'no offers field = the messages are left as they are');
  -- an empty list = the merchant has it in no offer section any more
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('brand', v_brand, 'name', 'Night Bloom', 'size_ml', 100, 'price', 1500, 'stock_quantity', 10, 'offers', '[]'::jsonb)), 'trial_catalog');
  perform pg_temp.must((select count(*) from public.offers where product_size_id = v_size and is_active) = 0, 'an empty offers list silences the catalog-written messages');

  -- a message written by hand with the same name is adopted; one with another name is left alone
  insert into public.offers (store_id, product_size_id, title, kind, is_active) values (v_s, v_size, 'Hand Sale', 'offer', true), (v_s, v_size, 'insane DEALS', 'offer', false);
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('brand', v_brand, 'name', 'Night Bloom', 'size_ml', 100, 'price', 1500, 'stock_quantity', 10, 'offers', jsonb_build_array('Insane Deals'))), 'trial_catalog');
  perform pg_temp.must((select count(*) from public.offers where product_size_id = v_size and lower(title) = 'insane deals') = 2, 'the by-hand message was adopted (the old catalog row and the by-hand row, none added): ' || (select count(*) from public.offers where product_size_id = v_size)::text);
  perform pg_temp.must((select is_active from public.offers where product_size_id = v_size and title = 'Hand Sale') = true and (select catalog_source from public.offers where product_size_id = v_size and title = 'Hand Sale') is null, 'a by-hand message with another name is never touched');

  -- a message another data source wrote is never overwritten
  insert into public.product_sizes (product_id, size_ml, size_label) values (v_prod, 200, '200ml') returning id into v_size2;
  insert into public.store_products (store_id, product_size_id, price, stock_quantity, is_available, currency, data_source, sync_status, last_synced_at)
    values (v_s, v_size2, 2500, 5, true, 'EGP', 'trial_catalog', 'synced', now());
  insert into public.offers (store_id, product_size_id, title, kind, is_active, catalog_source) values (v_s, v_size2, 'Real Deal', 'offer', true, 'store_catalog');
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('brand', v_brand, 'name', 'Night Bloom', 'size_ml', 200, 'price', 2500, 'stock_quantity', 5, 'offers', jsonb_build_array('real deal'))), 'trial_catalog');
  perform pg_temp.must((select count(*) from public.offers where product_size_id = v_size2) = 1 and (select catalog_source from public.offers where product_size_id = v_size2) = 'store_catalog', 'an offer of another data source is never overwritten nor duplicated');

  -- bad `offers` are refused with their reason and write nothing
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('brand', v_brand, 'name', 'Bad A', 'size_ml', 100, 'price', 1, 'stock_quantity', 1, 'offers', 'INSANE DEALS'),
    jsonb_build_object('brand', v_brand, 'name', 'Bad B', 'size_ml', 100, 'price', 1, 'stock_quantity', 1, 'offers', jsonb_build_array(5)),
    jsonb_build_object('brand', v_brand, 'name', 'Bad C', 'size_ml', 100, 'price', 1, 'stock_quantity', 1, 'offers', jsonb_build_array(repeat('x', 201))),
    jsonb_build_object('brand', v_brand, 'name', 'Bad D', 'size_ml', 100, 'price', 1, 'stock_quantity', 1, 'offers', jsonb_build_array('   ')),
    jsonb_build_object('brand', v_brand, 'name', 'Good E', 'size_ml', 100, 'price', 1, 'stock_quantity', 1, 'offers', jsonb_build_array('ok'))), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'rejected')::int = 4 and (v_res ->> 'placed')::int = 1, 'four bad offers fields refused, the good one placed: ' || v_res::text);
  perform pg_temp.must(not exists (select 1 from public.products where brand_id = v_brand_id and name like 'Bad %'), 'a refused item creates nothing');
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(jsonb_build_object('kind', 'perfumes', 'brand', v_brand, 'name', 'X', 'size_ml', 1, 'price', 1, 'stock_quantity', 1)), 'trial_catalog');
  perform pg_temp.must(v_res #>> '{items,0,reason}' = 'kind_invalid', 'an unknown kind is refused');

  -----------------------------------------------------------------------------------------------------------------------
  -- 2. A perfume that waits for its brand card keeps the merchant's offer sections and writes them when it is released.
  -----------------------------------------------------------------------------------------------------------------------
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('brand', v_nocard, 'name', 'Waiting Rose', 'size_ml', 100, 'price', 900, 'stock_quantity', 4, 'offers', jsonb_build_array('INSANE DEALS')),
    jsonb_build_object('brand', v_nocard, 'name', 'Waiting Plain', 'size_ml', 100, 'price', 800, 'stock_quantity', 4)), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'waiting')::int = 2, 'both wait: ' || v_res::text);
  perform pg_temp.must((select offers from public.catalog_waiting_items where store_id = v_s and name = 'Waiting Rose') = '["INSANE DEALS"]'::jsonb, 'the waiting row holds the offer sections');
  perform pg_temp.must((select offers from public.catalog_waiting_items where store_id = v_s and name = 'Waiting Plain') = '[]'::jsonb, 'a waiting perfume with no offer holds an empty list');
  -- sent again without the field: kept; sent again with another list: replaced
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(jsonb_build_object('brand', v_nocard, 'name', 'Waiting Rose', 'size_ml', 100, 'price', 950, 'stock_quantity', 4)), 'trial_catalog');
  perform pg_temp.must((select offers from public.catalog_waiting_items where store_id = v_s and name = 'Waiting Rose') = '["INSANE DEALS"]'::jsonb, 'no offers field keeps the waiting row''s sections');
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(jsonb_build_object('brand', v_nocard, 'name', 'Waiting Rose', 'size_ml', 100, 'price', 950, 'stock_quantity', 4, 'offers', jsonb_build_array('INSANE DEALS', 'Eid Gifts'))), 'trial_catalog');
  perform pg_temp.must((select jsonb_array_length(offers) from public.catalog_waiting_items where store_id = v_s and name = 'Waiting Rose') = 2, 'a new list replaces the waiting row''s sections');
  perform pg_temp.must((select count(*) from public.offers where store_id = v_s and title = 'Eid Gifts') = 0, 'nothing is written while it waits');
  insert into public.brands (name, slug) values (v_nocard, 'zznocard-' || v_tag) returning id into v_brand_id;
  select ps.id into v_size from public.product_sizes ps join public.products p on p.id = ps.product_id where p.brand_id = v_brand_id and p.name = 'Waiting Rose' and ps.size_ml = 100;
  perform pg_temp.must(v_size is not null, 'the brand card released the waiting perfume');
  perform pg_temp.must((select count(*) from public.offers where product_size_id = v_size and is_active and catalog_source = 'trial_catalog') = 2, 'the offer sections were written when it was released');
  perform pg_temp.must((select count(*) from public.offers o join public.product_sizes ps on ps.id = o.product_size_id join public.products p on p.id = ps.product_id where p.brand_id = v_brand_id and p.name = 'Waiting Plain') = 0, 'the plain waiting perfume got no offer');

  -----------------------------------------------------------------------------------------------------------------------
  -- 3. A bundle the rule is SURE about is published, with the merchant's own title and full text.
  -----------------------------------------------------------------------------------------------------------------------
  v_text := E'Set includes:\n• Pure Oudi 100 ML\n• Deodorant 150 ML\n\nThe box says "عود & مسك" <b>as is</b>.';
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('kind', 'bundle', 'source_key', ' VINTAGE-Tobacco-Box ', 'title', 'VINTAGE TOBACCO Box', 'description', v_text, 'price', 3500, 'stock_quantity', 10,
                       'product_url', 'https://rl.example/products/vintage', 'bundle', 'yes', 'pieces', jsonb_build_array('Pure Oudi 100 ML', 'Deodorant 150 ML', 'Pure Oudi 100 ML'),
                       'reasons', jsonb_build_array('the title says Box'), 'offers', jsonb_build_array('Black Friday'))), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'bundles_published')::int = 1 and (v_res ->> 'placed')::int = 0, 'one bundle published: ' || v_res::text);
  select sb.*, b.status as b_status, b.is_active as b_active, b.has_extra_items, b.composition_key, b.brand_id as b_brand, b.id as b_id, b.name as b_name
    into v_sb from public.store_bundles sb join public.bundles b on b.id = sb.bundle_id where sb.store_id = v_s and sb.source_key = 'vintage-tobacco-box';
  perform pg_temp.must(v_sb.id is not null, 'the source key is stored trimmed and lower-case');
  perform pg_temp.must(v_sb.b_status = 'published' and v_sb.b_active, 'a sure bundle is published');
  perform pg_temp.must(v_sb.title = 'VINTAGE TOBACCO Box' and v_sb.description = v_text, 'the merchant''s title and FULL text are stored exactly as sent');
  perform pg_temp.must(v_sb.data_source = 'trial_catalog' and v_sb.price = 3500 and v_sb.stock_quantity = 10 and v_sb.is_available and v_sb.sync_status = 'synced', 'price, stock, data source and sync state');
  perform pg_temp.must(v_sb.has_extra_items and v_sb.composition_key is null, 'a bundle written from the merchant''s text never gets a composition key (never merged with another store''s)');
  perform pg_temp.must(v_sb.offer_titles = array['Black Friday'], 'the offer sections the bundle is in are kept with it');
  perform pg_temp.must(v_sb.review_note is null, 'a sure bundle has no review note');
  perform pg_temp.must((select count(*) from public.bundle_items where bundle_id = v_sb.b_id) = 2, 'two pieces (a repeated line is written once)');
  perform pg_temp.must((select size_ml from public.bundle_items where bundle_id = v_sb.b_id and item_name = 'Deodorant 150 ML') = 150, 'a size written in the line is read from it');
  set local role anon;
  select count(*) into v_n from public.public_bundles where id = v_sb.b_id;
  reset role;
  perform pg_temp.must(v_n = 1, 'the visitor sees the published bundle');

  -- sent again (same key, new price, new text): one row, updated; the pieces are not written twice
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('kind', 'bundle', 'source_key', 'vintage-tobacco-box', 'title', 'VINTAGE TOBACCO Box', 'description', v_text || E'\nNew line', 'price', 3300, 'stock_quantity', 4,
                       'product_url', 'https://rl.example/products/vintage', 'bundle', 'yes', 'pieces', jsonb_build_array('Pure Oudi 100 ML', 'Deodorant 150 ML'), 'offers', jsonb_build_array('Black Friday', 'Eid Gifts'))), 'trial_catalog');
  perform pg_temp.must((select count(*) from public.store_bundles where store_id = v_s) = 1 and (select count(*) from public.bundles where id = v_sb.b_id) = 1, 're-sending creates no second bundle');
  perform pg_temp.must((select count(*) from public.bundle_items where bundle_id = v_sb.b_id) = 2, 're-sending writes no piece twice');
  select * into v_row from public.store_bundles where id = v_sb.id;
  perform pg_temp.must(v_row.price = 3300 and v_row.stock_quantity = 4 and v_row.description = v_text || E'\nNew line' and v_row.offer_titles = array['Black Friday', 'Eid Gifts'], 're-sending refreshes price, stock, full text and offer sections');
  -- sold out at the merchant: stored, hidden
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('kind', 'bundle', 'source_key', 'vintage-tobacco-box', 'title', 'VINTAGE TOBACCO Box', 'price', 3300, 'stock_quantity', 0, 'bundle', 'yes')), 'trial_catalog');
  set local role anon; select count(*) into v_n from public.public_bundles where id = v_sb.b_id; reset role;
  perform pg_temp.must(v_n = 0 and (select description from public.store_bundles where id = v_sb.id) is null, 'sold out = hidden from the visitor; no description sent = none kept (the merchant''s text is authoritative)');

  -----------------------------------------------------------------------------------------------------------------------
  -- 4. A bundle the rule is IN DOUBT about is written as a draft, hidden, waiting for the owner, with the rule's reasons.
  -----------------------------------------------------------------------------------------------------------------------
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('kind', 'bundle', 'source_key', 'eid-musk-set', 'title', 'EID MUSK SET', 'description', E'12 musks\n20 ML each', 'price', 5450, 'stock_quantity', 10,
                       'bundle', 'review', 'reasons', jsonb_build_array('it looks like a box but no perfume bottle is named in it (oils? incense?)', 'the title says SET'))), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'bundles_review')::int = 1 and (v_res ->> 'bundles_published')::int = 0, 'one doubtful bundle waits: ' || v_res::text);
  select sb.id, sb.bundle_id, sb.review_note, b.status, b.is_active into v_sb from public.store_bundles sb join public.bundles b on b.id = sb.bundle_id where sb.store_id = v_s and sb.source_key = 'eid-musk-set';
  perform pg_temp.must(v_sb.status = 'draft' and v_sb.is_active, 'a doubtful bundle is a draft');
  perform pg_temp.must(v_sb.review_note like 'it looks like a box%' and v_sb.review_note like '% | the title says SET', 'the owner reads the rule''s reasons');
  set local role anon; select count(*) into v_n from public.public_bundles where id = v_sb.bundle_id; reset role;
  perform pg_temp.must(v_n = 0, 'a draft is hidden from the visitor');
  perform pg_temp.must((select count(*) from public.catalog_review_queue() where store_id = v_s and source_key = 'eid-musk-set') = 1, 'it is in the owner''s review queue');
  perform pg_temp.must((select count(*) from public.catalog_review_queue() where store_id = v_s and source_key = 'vintage-tobacco-box') = 0, 'a sure bundle is not in the queue');

  -- the owner answers: bundle. It shows at once, leaves the queue, and every later sync honours the answer even if the rule still doubts.
  v_res := public.catalog_record_decision(v_s, ' EID-musk-SET ', 'bundle', 'owner 24 Nov: this is a bundle');
  perform pg_temp.must((v_res ->> 'bundle_found')::boolean and (v_res ->> 'applied_now')::boolean, 'the decision is applied now: ' || v_res::text);
  set local role anon; select count(*) into v_n from public.public_bundles where id = v_sb.bundle_id; reset role;
  perform pg_temp.must(v_n = 1, 'after the owner says bundle the visitor sees it');
  perform pg_temp.must((select count(*) from public.catalog_review_queue() where store_id = v_s and source_key = 'eid-musk-set') = 0, 'a decided product leaves the queue');
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('kind', 'bundle', 'source_key', 'eid-musk-set', 'title', 'EID MUSK SET', 'price', 5450, 'stock_quantity', 10, 'bundle', 'review', 'reasons', jsonb_build_array('doubt again'))), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'bundles_published')::int = 1 and (v_res ->> 'bundles_review')::int = 0, 'the owner''s answer wins over the rule on the next sync: ' || v_res::text);
  perform pg_temp.must((select status from public.bundles where id = v_sb.bundle_id) = 'published' and (select review_note from public.store_bundles where id = v_sb.id) is null, 'still published, no review note');
  perform pg_temp.must((select count(*) from public.catalog_owner_decisions where store_id = v_s) = 1, 'one decision row per store and product');
  -- he changes his mind: not a bundle. Hidden now; a later sync with 'yes' does not bring it back and creates no second bundle.
  v_res := public.catalog_record_decision(v_s, 'eid-musk-set', 'not_bundle', null);
  perform pg_temp.must((select count(*) from public.catalog_owner_decisions where store_id = v_s) = 1, 'the answer was replaced, not added');
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('kind', 'bundle', 'source_key', 'eid-musk-set', 'title', 'EID MUSK SET', 'price', 5450, 'stock_quantity', 10, 'bundle', 'yes')), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'bundles_declined')::int = 1, 'not_bundle is honoured even when the rule says yes: ' || v_res::text);
  set local role anon; select count(*) into v_n from public.public_bundles where id = v_sb.bundle_id; reset role;
  perform pg_temp.must(v_n = 0 and not (select is_active from public.bundles where id = v_sb.bundle_id), 'a declined bundle is hidden and inactive');
  perform pg_temp.must((select count(*) from public.store_bundles where store_id = v_s and source_key = 'eid-musk-set') = 1, 'no duplicate was created for a declined product');
  -- declined before anything was written: nothing is created
  perform public.catalog_record_decision(v_s, 'afnan-spray', 'not_bundle', 'single spray');
  v_n := (select count(*) from public.bundles);
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('kind', 'bundle', 'source_key', 'afnan-spray', 'title', '9AM DIVE Perfume SPRAY 250 ML', 'price', 288, 'stock_quantity', 10, 'bundle', 'review')), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'bundles_declined')::int = 1 and (select count(*) from public.bundles) = v_n, 'a declined product that was never written creates no bundle');

  -----------------------------------------------------------------------------------------------------------------------
  -- 5. An older bundle of the same store is ADOPTED by its product link: same bundle, its pieces untouched, nothing duplicated.
  -----------------------------------------------------------------------------------------------------------------------
  insert into public.bundles (name, slug, has_extra_items, status, is_active) values ('Legacy Duo ' || v_tag, 'legacy-duo-' || v_tag, false, 'published', true) returning id into v_legacy_bundle;
  insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_legacy_bundle, 'LATTAFA', 'Angham', 100, 1), (v_legacy_bundle, 'LATTAFA', 'Teriaq', 100, 1);
  insert into public.store_bundles (store_id, bundle_id, title, description, price, stock_quantity, is_available, data_source, sync_status, last_synced_at, product_url)
    values (v_s, v_legacy_bundle, 'Legacy Duo', 'old text', 2400, 10, true, 'trial_catalog', 'synced', now(), 'https://rl.example/products/legacy-duo');
  perform pg_temp.must((select composition_key from public.bundles where id = v_legacy_bundle) is not null, 'the older bundle has its composition key');
  v_n := (select count(*) from public.bundles);
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('kind', 'bundle', 'source_key', 'legacy-duo', 'title', 'Legacy Duo', 'description', 'new text', 'price', 2300, 'stock_quantity', 10,
                       'product_url', 'https://rl.example/products/legacy-duo', 'bundle', 'yes', 'pieces', jsonb_build_array('1 x Angham 100 ML', '1 x Teriaq 100 ML'))), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'bundles_published')::int = 1 and (select count(*) from public.bundles) = v_n, 'adopting creates no new bundle: ' || v_res::text);
  select * into v_row from public.store_bundles where bundle_id = v_legacy_bundle;
  perform pg_temp.must(v_row.source_key = 'legacy-duo' and v_row.price = 2300 and v_row.description = 'new text', 'the older row got the merchant''s key and its new price and text');
  perform pg_temp.must((select count(*) from public.bundle_items where bundle_id = v_legacy_bundle) = 2 and (select count(*) from public.bundle_items where bundle_id = v_legacy_bundle and item_brand = 'LATTAFA') = 2, 'its structured pieces are untouched');
  perform pg_temp.must((select composition_key from public.bundles where id = v_legacy_bundle) is not null, 'its composition key is kept');

  -- another data source's bundle is never overwritten
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('kind', 'bundle', 'source_key', 'legacy-duo', 'title', 'Legacy Duo', 'price', 1, 'stock_quantity', 1, 'bundle', 'yes')), 'store_catalog');
  perform pg_temp.must(v_res #>> '{items,0,reason}' = 'source_conflict' and (select price from public.store_bundles where bundle_id = v_legacy_bundle) = 2300, 'a bundle of another data source is held, not overwritten');

  -----------------------------------------------------------------------------------------------------------------------
  -- 6. A bad bundle item is refused with its reason and never stops the others; the same key in another store is another product.
  -----------------------------------------------------------------------------------------------------------------------
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('kind', 'bundle', 'title', 'No key', 'price', 10, 'stock_quantity', 1, 'bundle', 'yes'),
    jsonb_build_object('kind', 'bundle', 'source_key', 'k2', 'price', 10, 'stock_quantity', 1, 'bundle', 'yes'),
    jsonb_build_object('kind', 'bundle', 'source_key', 'k3', 'title', 'T', 'price', 0, 'stock_quantity', 1, 'bundle', 'yes'),
    jsonb_build_object('kind', 'bundle', 'source_key', 'k4', 'title', 'T', 'price', 10, 'stock_quantity', -1, 'bundle', 'yes'),
    jsonb_build_object('kind', 'bundle', 'source_key', 'k5', 'title', 'T', 'price', 10, 'stock_quantity', 1, 'bundle', 'no'),
    jsonb_build_object('kind', 'bundle', 'source_key', 'k6', 'title', 'T', 'price', 10, 'stock_quantity', 1, 'bundle', 'yes', 'currency', 'USD'),
    jsonb_build_object('kind', 'bundle', 'source_key', 'k7', 'title', 'T', 'price', 10, 'stock_quantity', 1, 'bundle', 'yes', 'product_url', 'javascript:alert(1)'),
    jsonb_build_object('kind', 'bundle', 'source_key', 'k8', 'title', 'T', 'price', 10, 'stock_quantity', 1, 'bundle', 'yes', 'pieces', 'not a list'),
    jsonb_build_object('kind', 'bundle', 'source_key', 'k9', 'title', 'T', 'price', 10, 'stock_quantity', 1, 'bundle', 'yes', 'offers', jsonb_build_array(1)),
    jsonb_build_object('kind', 'bundle', 'source_key', 'k10', 'title', 'Good Ten', 'price', 10, 'stock_quantity', 1, 'bundle', 'yes')), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'rejected')::int = 9 and (v_res ->> 'bundles_published')::int = 1, 'nine bad bundle items refused, the good one published: ' || v_res::text);
  perform pg_temp.must((select string_agg(e ->> 'reason', ',' order by (e ->> 'pos')::int) from jsonb_array_elements(v_res -> 'items') e where e ->> 'status' = 'rejected')
                       = 'source_key_missing,title_missing,price_invalid,stock_invalid,bundle_state_invalid,currency_not_egp,url_invalid,pieces_invalid,offers_invalid', 'each refusal names its reason: ' || v_res::text);
  perform pg_temp.must(not exists (select 1 from public.store_bundles where store_id = v_s and source_key in ('k2','k3','k4','k5','k6','k7','k8','k9')), 'a refused bundle writes nothing');
  v_res := public.catalog_receive_items(v_s2, jsonb_build_array(
    jsonb_build_object('kind', 'bundle', 'source_key', 'k10', 'title', 'Good Ten', 'price', 12, 'stock_quantity', 1, 'bundle', 'yes')), 'trial_catalog');
  perform pg_temp.must((select count(*) from public.store_bundles where source_key = 'k10') = 2 and (select count(distinct bundle_id) from public.store_bundles where source_key = 'k10') = 2, 'the same key at another store is another product');
  perform pg_temp.must((select count(distinct slug) from public.bundles where name = 'Good Ten') = 2, 'two bundles with one title get two different slugs');

  -- a mixed batch: perfumes and bundles together, each counted by what it is
  v_res := public.catalog_receive_items(v_s, jsonb_build_array(
    jsonb_build_object('brand', v_brand, 'name', 'Mixed One', 'size_ml', 100, 'price', 10, 'stock_quantity', 1),
    jsonb_build_object('kind', 'bundle', 'source_key', 'mixed-b', 'title', 'Mixed B', 'price', 10, 'stock_quantity', 1, 'bundle', 'review'),
    jsonb_build_object('brand', 'Zzmixednocard ' || v_tag, 'name', 'Mixed Two', 'size_ml', 100, 'price', 10, 'stock_quantity', 1)), 'trial_catalog');
  perform pg_temp.must((v_res ->> 'received')::int = 3 and (v_res ->> 'placed')::int = 1 and (v_res ->> 'waiting')::int = 1 and (v_res ->> 'bundles_review')::int = 1, 'a mixed batch is counted by kind: ' || v_res::text);

  -----------------------------------------------------------------------------------------------------------------------
  -- 7. Everything is server-only.
  -----------------------------------------------------------------------------------------------------------------------
  perform pg_temp.must((select relrowsecurity from pg_class where oid = 'public.catalog_owner_decisions'::regclass), 'row level security is on for the decisions table');
  set local role anon;
  v_denied := false; begin perform count(*) from public.catalog_owner_decisions; exception when insufficient_privilege then v_denied := true; end;
  reset role; perform pg_temp.must(v_denied, 'a visitor cannot read the owner''s decisions');
  set local role authenticated;
  v_denied := false; begin insert into public.catalog_owner_decisions (store_id, source_key, decision) values (v_s, 'forged', 'bundle'); exception when insufficient_privilege then v_denied := true; end;
  reset role; perform pg_temp.must(v_denied, 'a customer cannot write a decision');
  set local role anon;
  v_denied := false; begin perform public.catalog_record_decision(v_s, 'x', 'bundle', null); exception when insufficient_privilege then v_denied := true; end;
  reset role; perform pg_temp.must(v_denied, 'a visitor cannot record a decision');
  set local role authenticated;
  v_denied := false; begin perform * from public.catalog_review_queue(); exception when insufficient_privilege then v_denied := true; end;
  reset role; perform pg_temp.must(v_denied, 'a customer cannot read the review queue');
  set local role authenticated;
  v_denied := false; begin perform public.catalog_receive_items(v_s, '[]'::jsonb); exception when insufficient_privilege then v_denied := true; end;
  reset role; perform pg_temp.must(v_denied, 'a customer calling the entry point is refused');
  set local role authenticated;
  v_denied := false; begin perform private.catalog_receive_bundle(v_s, '{}'::jsonb, 'trial_catalog'); exception when insufficient_privilege then v_denied := true; end;
  reset role; perform pg_temp.must(v_denied, 'a customer calling the bundle path directly is refused');

  -- the live data was not touched by the checks above (they are rolled back): fixtures exist only inside this transaction
  perform pg_temp.must((select count(*) from public.bundles) > v_snap_bundles and (select count(*) from public.offers) > v_snap_offers and (select count(*) from public.products) > v_snap_products and (select count(*) from public.store_bundles) > v_snap_sb, 'fixture rows exist inside this transaction only');
end
$test$;

rollback;
