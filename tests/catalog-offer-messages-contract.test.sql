-- Real-database test of migration 20261115130025 catalog_bundle_views_and_offer_messages (owner rules of 2026-11-14/15).
-- Run on the live database as the project owner inside this one transaction; every fixture row is synthetic and the final
-- ROLLBACK discards all of it.
--
--   * the four public bundle views are security_invoker views over granted functions, and public_bundle_items lists each piece as the
--     store wrote it (brand, name, size in ml: since 20261119112905 a bundle stands on its own and is never tied to the perfume catalog,
--     so a perfume sold only inside a bundle, or an exclusive size, is named by the bundle's own text);
--   * an OFFER (عرض) is a promotional MESSAGE of the store with no price change; the public view carries the message only (trimmed
--     and capped), never a discount number, and shows exactly what the offers table already showed publicly (active, inside its
--     dates, active store) minus messages on perfumes that are not published;
--   * a DISCOUNT (خصم) is an explicit declaration (offers.kind = 'discount') that only the server can write: the browser roles hold
--     no privilege on that column, so a store cannot label its own message a discount from the dashboard;
--   * whatever the store claims as "price before/after" (offers.discount_*, store_products.original_price/discount_percentage) and
--     whatever kind an offer has never changes the platform offer: the cheapest real price per size still wins.
begin;

create function pg_temp.must(ok boolean, msg text) returns void language plpgsql as $f$
begin
  if ok is not true then raise exception 'catalog offer messages contract: %', msg; end if;
end $f$;

do $test$
declare
  v_brand uuid := gen_random_uuid();
  v_p1 uuid := gen_random_uuid();
  v_p2 uuid := gen_random_uuid();
  v_ph uuid := gen_random_uuid();        -- a perfume that is NOT published
  v_s1 uuid := gen_random_uuid();
  v_s2 uuid := gen_random_uuid();
  v_sh uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();         -- active store
  v_b uuid := gen_random_uuid();         -- active competitor
  v_off uuid := gen_random_uuid();       -- inactive store
  v_bundle uuid := gen_random_uuid();    -- published package: 2 x s1 + 1 x s2
  v_bundle_h uuid := gen_random_uuid();  -- package that holds the unpublished perfume
  v_o_vis uuid := gen_random_uuid();
  v_o_store uuid := gen_random_uuid();
  v_o_disc uuid := gen_random_uuid();
  v_o_long uuid := gen_random_uuid();
  v_o_nodesc uuid := gen_random_uuid();
  v_o_inactive uuid := gen_random_uuid();
  v_o_future uuid := gen_random_uuid();
  v_o_past uuid := gen_random_uuid();
  v_o_instore uuid := gen_random_uuid();
  v_o_draft uuid := gen_random_uuid();
  v_o_blank uuid := gen_random_uuid();   -- refused by the table, never stored
  v_o_claim uuid := gen_random_uuid();
  v_visible uuid[];
  v_hidden uuid[];
  v_row record; v_cols text; v_n integer;
  v_bad_kind boolean := false; v_blank boolean := false;
  v_inv integer;
  v_anon_msgs integer; v_anon_items integer; v_anon_pub integer; v_anon_title boolean := true; v_anon_kind boolean := true;
  v_auth_msgs integer; v_auth_items integer;
begin
  insert into public.brands (id, name, slug) values (v_brand, 'Offer Messages Contract', 'offmsg-' || v_brand::text);
  insert into public.stores (id, name, slug, status, commission_rate, priority_rank) values
    (v_a, 'Messages A', 'msg-a-' || v_a::text, 'active', 15, 100),
    (v_b, 'Messages B', 'msg-b-' || v_b::text, 'active', 15, 100),
    (v_off, 'Messages inactive', 'msg-o-' || v_off::text, 'inactive', 15, 100);
  insert into public.products (id, brand_id, name, slug, gender, status, is_active) values
    (v_p1, v_brand, 'Messages Perfume One', 'msg-p1-' || v_p1::text, 'men', 'published', true),
    (v_p2, v_brand, 'Messages Perfume Two', 'msg-p2-' || v_p2::text, 'men', 'published', true),
    (v_ph, v_brand, 'Messages Hidden Perfume', 'msg-ph-' || v_ph::text, 'men', 'draft', true);
  insert into public.product_sizes (id, product_id, size_ml, size_label) values
    (v_s1, v_p1, 100, '100 ml'), (v_s2, v_p2, 50, '50 ml'), (v_sh, v_ph, 100, '100 ml');

  -- 1. the bundle views --------------------------------------------------------------------------------------------------------------
  insert into public.bundles (id, brand_id, name, slug, status) values (v_bundle, v_brand, 'Messages package', 'msg-bnd-' || v_bundle::text, 'published');
  insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values
    (v_bundle, 'Offer Messages Contract', 'Messages Perfume One', 100, 2), (v_bundle, 'Offer Messages Contract', 'Messages Perfume Two', 50, 1);
  insert into public.store_bundles (store_id, bundle_id, title, description, price, stock_quantity, is_available, sync_status) values (v_a, v_bundle, 'Messages package (the store''s title)', 'The store''s own text', 500, 3, true, 'synced');
  insert into public.bundles (id, brand_id, name, slug, status) values (v_bundle_h, v_brand, 'Messages hidden package', 'msg-bndh-' || v_bundle_h::text, 'published');
  insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values
    (v_bundle_h, 'Offer Messages Contract', 'Messages Hidden Perfume', 100, 1), (v_bundle_h, 'Offer Messages Contract', 'Messages Perfume Two', 50, 1);
  insert into public.store_bundles (store_id, bundle_id, title, price, stock_quantity, is_available, sync_status) values (v_a, v_bundle_h, 'Messages package with a hidden perfume', 400, 3, true, 'synced');

  select count(*) into v_inv from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and c.relname in ('public_bundles', 'public_bundle_items', 'catalog_eligible_bundle_offers', 'catalog_platform_bundle_offers', 'catalog_offer_messages')
     and 'security_invoker=true' = any(coalesce(c.reloptions, '{}'::text[]));
  perform pg_temp.must(v_inv = 5, 'every bundle view and the offer-message view is a security_invoker view (got ' || v_inv || ' of 5)');

  select string_agg(column_name, ',' order by ordinal_position) into v_cols from information_schema.columns where table_schema = 'public' and table_name = 'public_bundles';
  perform pg_temp.must(v_cols = 'id,brand_id,brand_name,name,slug,has_extra_items', 'public_bundles keeps its columns (got ' || coalesce(v_cols, 'NULL') || ')');
  select string_agg(column_name, ',' order by ordinal_position) into v_cols from information_schema.columns where table_schema = 'public' and table_name = 'public_bundle_items';
  perform pg_temp.must(v_cols = 'bundle_id,quantity,brand_name,product_name,size_ml',
    'public_bundle_items lists each piece as the store wrote it (got ' || coalesce(v_cols, 'NULL') || ')');

  select * into v_row from public.public_bundle_items where bundle_id = v_bundle and product_name = 'Messages Perfume One';
  perform pg_temp.must(v_row.quantity = 2 and v_row.brand_name = 'Offer Messages Contract' and v_row.size_ml = 100,
    'a package piece carries its quantity, name, brand and size as the store wrote them');
  perform pg_temp.must((select count(*) from public.public_bundle_items where bundle_id = v_bundle) = 2, 'the package lists its two sizes');
  perform pg_temp.must(exists (select 1 from public.public_bundles where id = v_bundle and brand_name = 'Offer Messages Contract'), 'the package is public with its brand name');
  perform pg_temp.must(exists (select 1 from public.public_bundles where id = v_bundle_h) and (select count(*) from public.public_bundle_items where bundle_id = v_bundle_h) = 2,
    'a package naming an unpublished perfume still shows with its items (the perfumes are never consulted)');

  select count(*) into v_n from public.catalog_platform_bundle_offers where bundle_id = v_bundle and store_id = v_a and price = 500;
  perform pg_temp.must(v_n = 1, 'the platform bundle offer still works through the invoker view');
  select string_agg(column_name, ',' order by ordinal_position) into v_cols from information_schema.columns where table_schema = 'public' and table_name = 'catalog_eligible_bundle_offers';
  perform pg_temp.must(v_cols = 'store_bundle_id,bundle_id,store_id,store_name,title,description,price,currency,stock_quantity,price_includes_tax,price_includes_shipping,last_synced_at',
    'the eligible bundle offers carry the store''s own words but no commission, no priority and no claimed old price (got ' || coalesce(v_cols, 'NULL') || ')');
  perform pg_temp.must(not has_function_privilege('anon', 'private.fn_catalog_eligible_bundle_offers()', 'execute')
                         and not has_function_privilege('authenticated', 'private.fn_catalog_eligible_bundle_offers()', 'execute'),
    'the internal bundle offers (with commission and priority) are not callable by the browser roles');

  -- 2. offer messages --------------------------------------------------------------------------------------------------------------
  insert into public.offers (id, store_id, product_size_id, title, description, discount_type, discount_value) values
    (v_o_vis, v_a, v_s1, '   Buy two, get a gift   ', 'Gift pouch with every two bottles', 'percentage', 15);
  perform pg_temp.must((select kind from public.offers where id = v_o_vis) = 'offer', 'an offer is a plain message unless the server says otherwise (default kind)');
  begin update public.offers set kind = 'sale' where id = v_o_vis; exception when check_violation then v_bad_kind := true; end;
  perform pg_temp.must(v_bad_kind, 'only offer and discount are valid kinds');

  insert into public.offers (id, store_id, product_size_id, title, end_date) values (v_o_store, v_a, null, 'Free shipping', now() + interval '1 day');
  insert into public.offers (id, store_id, product_size_id, title, kind) values (v_o_disc, v_a, v_s2, 'Declared discount', 'discount');
  insert into public.offers (id, store_id, product_size_id, title, description) values (v_o_long, v_a, v_s1, repeat('t', 200), repeat('d', 600));
  insert into public.offers (id, store_id, product_size_id, title, description) values (v_o_nodesc, v_a, v_s2, 'No description', '   ');

  insert into public.offers (id, store_id, product_size_id, title, is_active) values (v_o_inactive, v_a, v_s1, 'Inactive offer', false);
  insert into public.offers (id, store_id, product_size_id, title, start_date) values (v_o_future, v_a, v_s1, 'Starts tomorrow', now() + interval '1 day');
  insert into public.offers (id, store_id, product_size_id, title, end_date) values (v_o_past, v_a, v_s1, 'Ended yesterday', now() - interval '1 day');
  insert into public.offers (id, store_id, product_size_id, title) values (v_o_instore, v_off, v_s1, 'Inactive store offer');
  insert into public.offers (id, store_id, product_size_id, title) values (v_o_draft, v_a, v_sh, 'Offer on an unpublished perfume');
  begin insert into public.offers (id, store_id, product_size_id, title) values (v_o_blank, v_a, v_s1, '    '); exception when check_violation then v_blank := true; end;
  perform pg_temp.must(v_blank, 'the table itself refuses a blank title, so no blank message can ever be public');

  v_visible := array[v_o_vis, v_o_store, v_o_disc, v_o_long, v_o_nodesc];
  v_hidden := array[v_o_inactive, v_o_future, v_o_past, v_o_instore, v_o_draft];
  perform pg_temp.must((select count(*) from public.catalog_offer_messages where offer_id = any (v_visible)) = 5, 'the five live messages are public');
  perform pg_temp.must(not exists (select 1 from public.catalog_offer_messages where offer_id = any (v_hidden)),
    'inactive, not-yet-started, ended, inactive-store and unpublished-perfume messages are never public');

  select * into v_row from public.catalog_offer_messages where offer_id = v_o_vis;
  perform pg_temp.must(v_row.store_id = v_a and v_row.store_name = 'Messages A' and v_row.product_size_id = v_s1 and v_row.kind = 'offer'
                         and v_row.title = 'Buy two, get a gift' and v_row.description = 'Gift pouch with every two bottles' and v_row.ends_at is null,
    'a message carries its store, size, kind, trimmed title and description');
  perform pg_temp.must((select product_size_id from public.catalog_offer_messages where offer_id = v_o_store) is null
                         and (select ends_at from public.catalog_offer_messages where offer_id = v_o_store) is not null,
    'a store-wide message has no size and keeps its end date');
  perform pg_temp.must((select kind from public.catalog_offer_messages where offer_id = v_o_disc) = 'discount', 'an explicit discount declaration is public as kind = discount');
  perform pg_temp.must((select length(title) from public.catalog_offer_messages where offer_id = v_o_long) = 120
                         and (select length(description) from public.catalog_offer_messages where offer_id = v_o_long) = 500,
    'the title is capped at 120 characters and the description at 500');
  perform pg_temp.must((select description from public.catalog_offer_messages where offer_id = v_o_nodesc) is null, 'a blank description is NULL');
  select string_agg(column_name, ',' order by ordinal_position) into v_cols from information_schema.columns where table_schema = 'public' and table_name = 'catalog_offer_messages';
  perform pg_temp.must(v_cols = 'offer_id,store_id,store_name,product_size_id,kind,title,description,ends_at',
    'the public message carries no discount type and no discount value (got ' || coalesce(v_cols, 'NULL') || ')');

  -- a published perfume hides and shows its message with it
  update public.products set status = 'published' where id = v_ph;
  perform pg_temp.must(exists (select 1 from public.catalog_offer_messages where offer_id = v_o_draft), 'the message of a perfume appears when the perfume is published');
  update public.products set status = 'draft' where id = v_ph;
  perform pg_temp.must(not exists (select 1 from public.catalog_offer_messages where offer_id = v_o_draft), 'and goes away when it is unpublished');

  -- 3. nothing a store claims about "price before / after", and no kind, ever changes the price ----------------------------------------
  insert into public.store_products (store_id, product_size_id, price, original_price, discount_percentage, currency, stock_quantity, is_available, sync_status) values
    (v_a, v_s1, 1000, 2000, 50, 'EGP', 5, true, 'synced'),
    (v_b, v_s1, 1100, 5000, 78, 'EGP', 5, true, 'synced');
  insert into public.offers (id, store_id, product_size_id, title, kind, discount_type, discount_value) values (v_o_claim, v_b, v_s1, 'B declared 90 percent', 'discount', 'percentage', 90);
  select * into v_row from public.catalog_platform_offers where product_size_id = v_s1;
  perform pg_temp.must(v_row.store_id = v_a and v_row.price = 1000,
    'the cheapest real price wins even when the dearer store claims a huge old price and declares a discount (got ' || coalesce(v_row.store_id::text, 'NULL') || ' at ' || coalesce(v_row.price::text, 'NULL') || ')');
  perform pg_temp.must((select count(*) from public.catalog_eligible_offers where product_size_id = v_s1 and store_id in (v_a, v_b)) = 2,
    'a claimed old price or a discount declaration neither adds nor removes an eligible offer');
  perform pg_temp.must(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'catalog_platform_offers'
                                      and column_name in ('original_price', 'discount_percentage', 'discount_type', 'discount_value', 'kind')),
    'the platform offer view carries no claimed old price and no discount');

  -- 4. who can write the declaration -----------------------------------------------------------------------------------------------
  perform pg_temp.must(not has_table_privilege('authenticated', 'public.offers', 'INSERT') and not has_table_privilege('authenticated', 'public.offers', 'UPDATE'),
    'the browser role holds no table-wide write on offers (column grants only)');
  perform pg_temp.must((select count(*) from unnest(array['id', 'store_id', 'product_size_id', 'title', 'description', 'discount_type', 'discount_value', 'start_date', 'end_date', 'is_active', 'created_at', 'updated_at']) c
                         where has_column_privilege('authenticated', 'public.offers', c, 'INSERT') and has_column_privilege('authenticated', 'public.offers', c, 'UPDATE')) = 12,
    'control: a store member can still write all twelve columns it could write before');
  perform pg_temp.must(has_table_privilege('authenticated', 'public.offers', 'DELETE') and not has_table_privilege('anon', 'public.offers', 'DELETE'),
    'control: deleting an own offer is unchanged (still bounded by the row policy)');
  perform pg_temp.must(not has_table_privilege('authenticated', 'public.offers', 'SELECT') and has_column_privilege('authenticated', 'public.offers', 'store_id', 'SELECT')
                         and not has_column_privilege('authenticated', 'public.offers', 'title', 'SELECT'),
    'control: the column-level SELECT of the browser roles is unchanged (the message is read through the view only)');
  perform pg_temp.must(not has_column_privilege('authenticated', 'public.offers', 'kind', 'INSERT') and not has_column_privilege('authenticated', 'public.offers', 'kind', 'UPDATE'),
    'a store member cannot label its own message a discount (no write on offers.kind)');
  perform pg_temp.must(not has_column_privilege('anon', 'public.offers', 'kind', 'INSERT') and not has_column_privilege('anon', 'public.offers', 'kind', 'UPDATE'),
    'the visitor cannot write offers.kind');
  perform pg_temp.must(has_column_privilege('service_role', 'public.offers', 'kind', 'INSERT') and has_column_privilege('service_role', 'public.offers', 'kind', 'UPDATE'),
    'the server can declare a discount');

  -- 5. the visitor and the signed-in customer read the views; the offers table keeps its text private ----------------------------------
  -- (checks run after RESET ROLE: a temp function of this session is not callable by the API roles)
  set local role anon;
  select count(*) into v_anon_msgs from public.catalog_offer_messages where offer_id = any (v_visible);
  select count(*) into v_anon_items from public.public_bundle_items where bundle_id = v_bundle;
  select count(*) into v_anon_pub from public.public_bundles where id = v_bundle;
  begin perform title from public.offers limit 1; exception when insufficient_privilege then v_anon_title := false; end;
  begin perform kind from public.offers limit 1; exception when insufficient_privilege then v_anon_kind := false; end;
  reset role;
  set local role authenticated;
  select count(*) into v_auth_msgs from public.catalog_offer_messages where offer_id = any (v_visible);
  select count(*) into v_auth_items from public.public_bundle_items where bundle_id = v_bundle;
  reset role;
  perform pg_temp.must(v_anon_msgs = 5, 'the visitor reads the five live messages (got ' || v_anon_msgs || ')');
  perform pg_temp.must(v_anon_items = 2 and v_anon_pub = 1, 'the visitor reads the package and its items (got ' || v_anon_items || ' items, ' || v_anon_pub || ' package)');
  perform pg_temp.must(v_auth_msgs = 5 and v_auth_items = 2, 'the signed-in customer reads them too (got ' || v_auth_msgs || ' / ' || v_auth_items || ')');
  perform pg_temp.must(not v_anon_title and not v_anon_kind, 'the visitor cannot read the offers table directly: the view is the only public door, with its trimming and caps');
end
$test$;

rollback;
