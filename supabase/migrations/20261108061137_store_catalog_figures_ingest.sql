-- The one door through which a store's catalog figures reach the four store ranking tables.
--
-- public.store_catalog_best_sellers / _most_viewed / _most_searched / _ratings (migration 20261107135337) are readable by
-- the store team and the admin and writable by nobody but the server. This is the server's writer: the catalog importer (the
-- Worker that talks to a linked store, using the service key) hands it what the store reported and it validates and upserts.
-- There is no importer yet and nothing calls this today - the tables stay empty until a store's catalog is linked.
--
-- What a store has to report, per offer (one object per offer, in an array):
--   store_product_id  OR  product_size_id   which offer (exactly one; the offer must belong to p_store_id)
--   units_sold        whole number >= 0     units the store sold
--   views_count       whole number >= 0     product page views in the store
--   searches_count    whole number >= 0     times the offer appeared in the store's search results
--   average_rating + ratings_count          the store's own average (1-5) and how many ratings stand behind it, together
--   reported_at       optional timestamp    when the store measured it (default now); an older report never overwrites a newer one
-- Any subset of the figures may be sent. Nothing is half-written: one bad item refuses the whole call.
--
-- Security: SECURITY INVOKER and executable by service_role only, so a mistaken grant would still meet the tables' own
-- privileges (no INSERT/UPDATE for any client role). A store can only write offers of the store id the server names.

create or replace function private.ingest_figure_int(p_item jsonb, p_key text, p_pos integer)
returns integer
language plpgsql
immutable
set search_path to 'pg_temp'
as $function$
declare
  v jsonb := p_item -> p_key;
  n numeric;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) <> 'number' then
    raise exception 'item %: % must be a number', p_pos, p_key using errcode = '22023';
  end if;
  n := (v #>> '{}')::numeric;
  if n <> trunc(n) or n < 0 or n > 2000000000 then
    raise exception 'item %: % must be a whole number from 0 to 2000000000', p_pos, p_key using errcode = '22023';
  end if;
  return n::integer;
end;
$function$;

revoke all on function private.ingest_figure_int(jsonb, text, integer) from public, anon, authenticated;
grant execute on function private.ingest_figure_int(jsonb, text, integer) to service_role;

create or replace function public.ingest_store_catalog_figures(p_store_id uuid, p_figures jsonb)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_item jsonb;
  v_pos integer := 0;
  v_offer uuid;
  v_by_offer text;
  v_by_size text;
  v_at timestamptz;
  v_units integer;
  v_views integer;
  v_searches integer;
  v_avg numeric;
  v_cnt integer;
  v_rows integer;
  n_sales integer := 0;
  n_views integer := 0;
  n_searches integer := 0;
  n_ratings integer := 0;
  n_stale integer := 0;
begin
  if p_store_id is null or not exists (select 1 from public.stores s where s.id = p_store_id) then
    raise exception 'unknown store' using errcode = '22023';
  end if;
  if p_figures is null or jsonb_typeof(p_figures) <> 'array' then
    raise exception 'p_figures must be a JSON array of objects' using errcode = '22023';
  end if;
  if jsonb_array_length(p_figures) > 1000 then
    raise exception 'at most 1000 offers per call' using errcode = '22023';
  end if;

  for v_item in select e.value from jsonb_array_elements(p_figures) as e loop
    v_pos := v_pos + 1;
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'item %: must be an object', v_pos using errcode = '22023';
    end if;

    -- which offer: exactly one identifier, and the offer must belong to this store
    v_by_offer := nullif(v_item ->> 'store_product_id', '');
    v_by_size := nullif(v_item ->> 'product_size_id', '');
    if (v_by_offer is null) = (v_by_size is null) then
      raise exception 'item %: give exactly one of store_product_id or product_size_id', v_pos using errcode = '22023';
    end if;
    begin
      if v_by_offer is not null then
        select sp.id into v_offer from public.store_products sp where sp.store_id = p_store_id and sp.id = v_by_offer::uuid;
      else
        select sp.id into v_offer from public.store_products sp where sp.store_id = p_store_id and sp.product_size_id = v_by_size::uuid;
      end if;
    exception when invalid_text_representation then
      raise exception 'item %: the identifier is not a uuid', v_pos using errcode = '22023';
    end;
    if v_offer is null then
      raise exception 'item %: this store has no such offer', v_pos using errcode = '22023';
    end if;

    v_at := now();
    if v_item ? 'reported_at' and jsonb_typeof(v_item -> 'reported_at') <> 'null' then
      begin
        v_at := (v_item ->> 'reported_at')::timestamptz;
      exception when others then
        raise exception 'item %: reported_at is not a timestamp', v_pos using errcode = '22023';
      end;
      if v_at > now() + interval '1 day' then
        raise exception 'item %: reported_at is in the future', v_pos using errcode = '22023';
      end if;
    end if;

    v_units := private.ingest_figure_int(v_item, 'units_sold', v_pos);
    v_views := private.ingest_figure_int(v_item, 'views_count', v_pos);
    v_searches := private.ingest_figure_int(v_item, 'searches_count', v_pos);
    v_cnt := private.ingest_figure_int(v_item, 'ratings_count', v_pos);
    v_avg := null;
    if v_item ? 'average_rating' and jsonb_typeof(v_item -> 'average_rating') <> 'null' then
      if jsonb_typeof(v_item -> 'average_rating') <> 'number' then
        raise exception 'item %: average_rating must be a number', v_pos using errcode = '22023';
      end if;
      v_avg := round((v_item ->> 'average_rating')::numeric, 2);
      if v_avg < 1 or v_avg > 5 then
        raise exception 'item %: average_rating must be between 1 and 5', v_pos using errcode = '22023';
      end if;
    end if;
    if (v_avg is null) <> (v_cnt is null) then
      raise exception 'item %: average_rating and ratings_count go together', v_pos using errcode = '22023';
    end if;
    if v_cnt is not null and v_cnt < 1 then
      raise exception 'item %: ratings_count must be at least 1', v_pos using errcode = '22023';
    end if;
    if v_units is null and v_views is null and v_searches is null and v_avg is null then
      raise exception 'item %: no figure given', v_pos using errcode = '22023';
    end if;

    -- upserts: an older report never overwrites a newer one
    if v_units is not null then
      insert into public.store_catalog_best_sellers as t (store_product_id, units_sold, reported_at)
        values (v_offer, v_units, v_at)
        on conflict (store_product_id) do update
          set units_sold = excluded.units_sold, reported_at = excluded.reported_at
          where t.reported_at <= excluded.reported_at;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then n_stale := n_stale + 1; else n_sales := n_sales + 1; end if;
    end if;
    if v_views is not null then
      insert into public.store_catalog_most_viewed as t (store_product_id, views_count, reported_at)
        values (v_offer, v_views, v_at)
        on conflict (store_product_id) do update
          set views_count = excluded.views_count, reported_at = excluded.reported_at
          where t.reported_at <= excluded.reported_at;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then n_stale := n_stale + 1; else n_views := n_views + 1; end if;
    end if;
    if v_searches is not null then
      insert into public.store_catalog_most_searched as t (store_product_id, searches_count, reported_at)
        values (v_offer, v_searches, v_at)
        on conflict (store_product_id) do update
          set searches_count = excluded.searches_count, reported_at = excluded.reported_at
          where t.reported_at <= excluded.reported_at;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then n_stale := n_stale + 1; else n_searches := n_searches + 1; end if;
    end if;
    if v_avg is not null then
      insert into public.store_catalog_ratings as t (store_product_id, average_rating, ratings_count, reported_at)
        values (v_offer, v_avg, v_cnt, v_at)
        on conflict (store_product_id) do update
          set average_rating = excluded.average_rating, ratings_count = excluded.ratings_count, reported_at = excluded.reported_at
          where t.reported_at <= excluded.reported_at;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then n_stale := n_stale + 1; else n_ratings := n_ratings + 1; end if;
    end if;
  end loop;

  return jsonb_build_object('store_id', p_store_id, 'offers', v_pos, 'best_sellers', n_sales, 'most_viewed', n_views,
                            'most_searched', n_searches, 'ratings', n_ratings, 'skipped_older_than_stored', n_stale);
end;
$function$;

revoke all on function public.ingest_store_catalog_figures(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_store_catalog_figures(uuid, jsonb) to service_role;

comment on function public.ingest_store_catalog_figures(uuid, jsonb) is
  'Server-only writer of the four store ranking tables: validates a store''s reported figures per offer (sales, views, searches, average rating with its count) and upserts them atomically. service_role only; the offer must belong to the named store; an older report never overwrites a newer one.';
