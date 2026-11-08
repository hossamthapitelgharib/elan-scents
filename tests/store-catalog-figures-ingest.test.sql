-- Real-database test for supabase/migrations/20261108061137_store_catalog_figures_ingest.sql
-- Run AFTER the migration, as the project owner, inside one transaction. Every fixture is synthetic and rolled back at the end.
--
-- Proves that public.ingest_store_catalog_figures(store, figures):
--   * is callable by the server (service_role) and by nobody else - not anon, not a signed-in customer, not a store member;
--   * writes the four store ranking tables from what a store reports (by offer id or by size id), copying store_id and
--     product_size_id from the offer, and the rankings then show those figures as the stores' catalog source;
--   * only touches offers of the store it is told about, refuses bad figures (negative, fractional, out of range, a rating
--     without its count, a future date, unknown or foreign offers, both/neither identifier, huge batches) and refuses the WHOLE
--     call when one item is bad (nothing half-written);
--   * is repeatable: a newer report replaces, an older one never overwrites a newer one.
begin;

create function pg_temp.fx_isize(p_brand uuid, p_tag text) returns uuid language plpgsql as $f$
declare v_product uuid; v_size uuid;
begin
  insert into public.products(brand_id, name, slug, short_description, official_description, gender, notes_source, content_source, status, is_active)
  values (p_brand, 'Ingest fixture ' || p_tag, 'in-' || p_tag, 'fixture', 'fixture', 'unisex', 'store_catalog', 'ingest_fixture', 'published', true) returning id into v_product;
  insert into public.product_sizes(product_id, size_ml, size_label, sku) values (v_product, 50, '50 ml', 'IN-' || p_tag) returning id into v_size;
  return v_size;
end $f$;

create function pg_temp.fx_ioffer(p_store uuid, p_size uuid) returns uuid language plpgsql as $f$
declare v_offer uuid;
begin
  insert into public.store_products(store_id, product_size_id, price, original_price, stock_quantity, is_available, currency, data_source, sync_status, product_url)
  values (p_store, p_size, 100, 120, 100, true, 'EGP', 'store_catalog', 'synced', 'https://example.invalid/ingest-fixture') returning id into v_offer;
  return v_offer;
end $f$;

-- runs the ingestion as the server and demands that it is refused with invalid_parameter_value
create function pg_temp.fx_bad(p_store uuid, p_figures jsonb, p_what text) returns void language plpgsql as $f$
declare v_ok boolean := false;
begin
  begin
    set local role service_role;
    perform public.ingest_store_catalog_figures(p_store, p_figures);
  exception when invalid_parameter_value then v_ok := true;
  end;
  reset role;
  if not v_ok then raise exception 'must be refused: %', p_what; end if;
end $f$;

do $fixture$
declare
  v_tag text := replace(gen_random_uuid()::text, '-', '');
  v_brand uuid; sa uuid; sb uuid;
  u_member uuid := gen_random_uuid(); u_cust uuid := gen_random_uuid();
  za1 uuid; za2 uuid; zb uuid; p_a1 uuid; p_a2 uuid; p_b uuid;
  oa1 uuid; oa2 uuid; ob uuid;
  r jsonb; a record; b record; n integer; v_denied boolean; v_before integer;
begin
  insert into public.stores(name, slug, status) values ('Ingest fixture A', 'in-a-' || v_tag, 'active') returning id into sa;
  insert into public.stores(name, slug, status) values ('Ingest fixture B', 'in-b-' || v_tag, 'active') returning id into sb;
  insert into auth.users (id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, email_confirmed_at, created_at, updated_at)
  select x, 'authenticated', 'authenticated', 'fixture-' || x::text || '@example.invalid', '', '{}'::jsonb, '{"full_name":"ingest-fixture"}'::jsonb, now(), now(), now()
    from unnest(array[u_member, u_cust]) x;
  insert into public.profiles(id, role) select x, 'customer' from unnest(array[u_member, u_cust]) x on conflict (id) do nothing;
  insert into public.store_accounts(store_id, user_id, role) values (sa, u_member, 'store_admin');
  insert into public.brands(name, slug, is_active) values ('Ingest brand ' || v_tag, 'in-brand-' || v_tag, true) returning id into v_brand;
  za1 := pg_temp.fx_isize(v_brand, 'a1-' || v_tag); za2 := pg_temp.fx_isize(v_brand, 'a2-' || v_tag); zb := pg_temp.fx_isize(v_brand, 'b-' || v_tag);
  select product_id into p_a1 from public.product_sizes where id = za1; select product_id into p_a2 from public.product_sizes where id = za2;
  select product_id into p_b from public.product_sizes where id = zb;
  oa1 := pg_temp.fx_ioffer(sa, za1); oa2 := pg_temp.fx_ioffer(sa, za2); ob := pg_temp.fx_ioffer(sb, zb);

  ---------------------------------------------------------------- 1. who can call it
  if has_function_privilege('anon', 'public.ingest_store_catalog_figures(uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.ingest_store_catalog_figures(uuid, jsonb)', 'execute') then
    raise exception 'the ingestion must not be executable by anon or authenticated';
  end if;
  if not has_function_privilege('service_role', 'public.ingest_store_catalog_figures(uuid, jsonb)', 'execute') then
    raise exception 'the server (service_role) must be able to call the ingestion';
  end if;
  v_denied := false;
  begin set local role anon; perform public.ingest_store_catalog_figures(sa, '[]'::jsonb); exception when insufficient_privilege then v_denied := true; end;
  reset role;
  if not v_denied then raise exception 'a visitor called the ingestion'; end if;
  perform set_config('request.jwt.claim.sub', u_member::text, true);
  v_denied := false;
  begin set local role authenticated; perform public.ingest_store_catalog_figures(sa, '[]'::jsonb); exception when insufficient_privilege then v_denied := true; end;
  reset role;
  if not v_denied then raise exception 'a store member called the ingestion'; end if;
  if (select prosecdef from pg_proc where oid = 'public.ingest_store_catalog_figures(uuid, jsonb)'::regprocedure) then
    raise exception 'the ingestion must be SECURITY INVOKER (the tables'' own privileges stay the second lock)';
  end if;

  ---------------------------------------------------------------- 2. a store reports its figures
  set local role service_role;
  r := public.ingest_store_catalog_figures(sa, jsonb_build_array(
    jsonb_build_object('store_product_id', oa1, 'units_sold', 10, 'views_count', 100, 'searches_count', 7, 'average_rating', 4.5, 'ratings_count', 4),
    jsonb_build_object('product_size_id', za2, 'units_sold', 5)));
  reset role;
  if (r->>'offers')::int <> 2 or (r->>'best_sellers')::int <> 2 or (r->>'most_viewed')::int <> 1 or (r->>'most_searched')::int <> 1
     or (r->>'ratings')::int <> 1 or (r->>'skipped_older_than_stored')::int <> 0 then raise exception 'unexpected summary %', r; end if;
  select * into a from public.store_catalog_best_sellers where store_product_id = oa2;
  if a.units_sold <> 5 or a.store_id <> sa or a.product_size_id <> za2 then raise exception 'sold by size id: %', a; end if;
  select * into a from public.store_catalog_ratings where store_product_id = oa1;
  if a.average_rating <> 4.50 or a.ratings_count <> 4 or a.store_id <> sa or a.product_size_id <> za1 then raise exception 'rating row: %', a; end if;
  set local role service_role;
  perform public.ingest_store_catalog_figures(sb, jsonb_build_array(jsonb_build_object('product_size_id', zb, 'units_sold', 8)));
  reset role;

  -- the rankings now show them, as the stores' catalog source
  select * into a from public.storefront_product_rankings where product_id = p_a1;
  select * into b from public.storefront_product_rankings where product_id = p_b;
  if a.sales_source <> 'store_catalog' or a.rating_source <> 'store_catalog' or a.views_source <> 'store_catalog' or a.searches_source <> 'store_catalog' then
    raise exception 'sources should be the stores'' catalog: %', a; end if;
  if not (a.sales_rank < b.sales_rank and b.sales_rank < (select sales_rank from public.storefront_product_rankings where product_id = p_a2)) then
    raise exception 'sales order must be 10 (A1), 8 (B), 5 (A2)'; end if;
  if a.rating_rank is null then raise exception 'a rating of 4.50 from 4 ratings must rank'; end if;

  ---------------------------------------------------------------- 3. repeatable; an older report never wins
  set local role service_role;
  r := public.ingest_store_catalog_figures(sa, jsonb_build_array(
    jsonb_build_object('store_product_id', oa1, 'units_sold', 12, 'reported_at', (now() + interval '1 hour')::text)));
  if (r->>'best_sellers')::int <> 1 then raise exception 'a newer report must replace: %', r; end if;
  r := public.ingest_store_catalog_figures(sa, jsonb_build_array(
    jsonb_build_object('store_product_id', oa1, 'units_sold', 1, 'reported_at', (now() - interval '10 days')::text)));
  reset role;
  if (r->>'best_sellers')::int <> 0 or (r->>'skipped_older_than_stored')::int <> 1 then raise exception 'an older report must be skipped: %', r; end if;
  if (select units_sold from public.store_catalog_best_sellers where store_product_id = oa1) <> 12 then raise exception 'the newer figure must stay'; end if;
  if (select count(*) from public.store_catalog_best_sellers where store_id = sa) <> 2 then raise exception 'one row per offer, no duplicates'; end if;

  ---------------------------------------------------------------- 4. refusals
  perform pg_temp.fx_bad(null, '[]'::jsonb, 'no store');
  perform pg_temp.fx_bad(gen_random_uuid(), '[]'::jsonb, 'unknown store');
  perform pg_temp.fx_bad(sa, '{}'::jsonb, 'an object instead of an array');
  perform pg_temp.fx_bad(sa, null, 'null figures');
  perform pg_temp.fx_bad(sa, (select jsonb_agg(jsonb_build_object('store_product_id', oa1, 'units_sold', 1)) from generate_series(1, 1001)), 'more than 1000 items');
  perform pg_temp.fx_bad(sa, '[5]'::jsonb, 'an item that is not an object');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('units_sold', 1)), 'no offer identifier');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('store_product_id', oa1, 'product_size_id', za1, 'units_sold', 1)), 'both identifiers');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('store_product_id', ob, 'units_sold', 99999)), 'an offer of ANOTHER store');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('product_size_id', zb, 'units_sold', 99999)), 'a size the store does not offer');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('store_product_id', 'not-a-uuid', 'units_sold', 1)), 'a malformed id');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('store_product_id', oa1)), 'an item with no figure');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('store_product_id', oa1, 'units_sold', -1)), 'negative sales');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('store_product_id', oa1, 'views_count', 1.5)), 'fractional views');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('store_product_id', oa1, 'searches_count', 3000000000)), 'out of range searches');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('store_product_id', oa1, 'units_sold', '5')), 'a number sent as text');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('store_product_id', oa1, 'average_rating', 4.5)), 'a rating without its count');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('store_product_id', oa1, 'ratings_count', 4)), 'a count without its rating');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('store_product_id', oa1, 'average_rating', 0.5, 'ratings_count', 4)), 'a rating below 1');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('store_product_id', oa1, 'average_rating', 5.5, 'ratings_count', 4)), 'a rating above 5');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('store_product_id', oa1, 'average_rating', 4, 'ratings_count', 0)), 'a rating from zero ratings');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('store_product_id', oa1, 'units_sold', 1, 'reported_at', 'yesterday-ish')), 'a bad timestamp');
  perform pg_temp.fx_bad(sa, jsonb_build_array(jsonb_build_object('store_product_id', oa1, 'units_sold', 1, 'reported_at', (now() + interval '3 days')::text)), 'a report from the future');

  -- all or nothing: the first item is fine, the second is not
  select count(*) into v_before from public.store_catalog_most_viewed where store_id = sa;
  perform pg_temp.fx_bad(sa, jsonb_build_array(
    jsonb_build_object('store_product_id', oa2, 'views_count', 777),
    jsonb_build_object('store_product_id', oa2, 'views_count', -5)), 'a batch with one bad item');
  select count(*) into n from public.store_catalog_most_viewed where store_id = sa;
  if n <> v_before or exists (select 1 from public.store_catalog_most_viewed where store_product_id = oa2) then
    raise exception 'a refused batch must write nothing (the first item leaked)'; end if;

  -- the figures that were refused never changed the stored ones
  if (select units_sold from public.store_catalog_best_sellers where store_product_id = oa1) <> 12 then raise exception 'refused calls changed stored data'; end if;
  if (select units_sold from public.store_catalog_best_sellers where store_product_id = ob) <> 8 then raise exception 'store A wrote into store B''s offer'; end if;
end
$fixture$;

rollback;
