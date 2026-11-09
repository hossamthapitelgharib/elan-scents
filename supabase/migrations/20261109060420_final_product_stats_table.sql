-- The final, cumulative figures table: public.product_stats now holds, per perfume, the NET result of comparing what the
-- platform's own customers did with what the stores' catalogs report - one row per perfume, fed by a function, read by the
-- storefront filters (the four rankings), by the cards (public_products) and by the platform dashboard.
--
-- Before this, public.product_stats was a table nothing fed: ten rows of hand-entered sample numbers (views 25..250, sales
-- 10..100, written on 2026-10-05, no rating) that nothing read any more. The
-- storefront computed the same numbers again on every request from the raw tables, and only for the last 365 days, so a
-- view or a search stopped counting after a year while the store figures had no place to be merged with the customers'.
--
-- What changes
--   1. Figures are for ALL TIME. The 365-day window is gone from private.fn_product_public_activity().
--   2. A browser that shows no sign of life for 400 days is still deleted by purge_expired_guest_fingerprints() (privacy),
--      but its product views and searches are first folded into private.product_activity_archive - one anonymous total per
--      perfume and event, with no visitor in it - so the total never drops because of retention. (A visitor who asks to be
--      forgotten is still deleted without a trace: that stays a deliberate decrease.)
--   3. private.refresh_product_stats() computes the final figures and writes them into public.product_stats; pg_cron runs it
--      every 5 minutes, writing only the rows that changed. The review trigger refreshes the rating of the reviewed perfume
--      at once.
--        views / sales / searches : the customers' figure when it is above zero, otherwise the sum of the active stores'
--                                   catalog figures; the column *_source says which one decided (never summed together).
--        rating                   : private.fn_product_rating_sources() (>= 3 ratings, customers first, then stores).
--   4. The rankings (storefront_product_rankings) and public_products read the table through private.fn_product_final_stats().
--   5. request_count is dropped. Nothing ever fed it and nothing read it (per-store order totals are order_request_count in
--      platform_store_summary(), unrelated). distinctiveness_score is NOT touched.
--
-- Data note (measured on the live project before writing this): product_stats holds 10 rows of SAMPLE numbers (not real
-- activity) - views 25, 50, ... 250 and sales 10, 20, ... 100 for the ten perfumes, request_count 0, search_count 0, no rating.
-- The first refresh below overwrites them with the real figures and request_count is dropped with its column. The old values
-- are written down in supabase/rollback/20261108120000_final_product_stats_table.sql so that they can be restored.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. the anonymous archive of views and searches whose visitor was deleted by retention
create table private.product_activity_archive (
  product_id uuid not null references public.products (id) on delete cascade,
  event_type text not null check (event_type in ('view', 'search')),
  event_count bigint not null default 0 check (event_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (product_id, event_type)
);
alter table private.product_activity_archive enable row level security;
revoke all on table private.product_activity_archive from public, anon, authenticated;

comment on table private.product_activity_archive is
  'Views and searches of guest browsers that retention deleted, folded into one anonymous total per perfume and event so all-time figures never drop. Written only by purge_expired_guest_fingerprints(); read only by private.fn_product_public_activity().';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. product_stats: request_count goes; every figure says which source decided it
alter table public.product_stats
  drop column request_count,
  add column views_source text check (views_source in ('customers', 'store_catalog')),
  add column sales_source text check (sales_source in ('customers', 'store_catalog')),
  add column search_source text check (search_source in ('customers', 'store_catalog')),
  add column rating_source text check (rating_source in ('customers', 'store_catalog'));
-- (the "a figure always says its source" constraints are added below, after the first refresh has replaced the sample rows)

comment on table public.product_stats is
  'The final, all-time figures per perfume: the net result of comparing the customers'' tables with the stores'' catalog tables. Written only by private.refresh_product_stats() (pg_cron every 5 minutes, and the review trigger for the rating). Read through private.fn_product_final_stats().';
comment on column public.product_stats.views_count is 'Final views: the customers'' all-time views when above zero, otherwise the sum of the active stores'' catalog views. views_source says which.';
comment on column public.product_stats.sales_count is 'Final sold units: the registered customers'' net sold units when above zero, otherwise the sum of the active stores'' catalog sales. sales_source says which.';
comment on column public.product_stats.search_count is 'Final searches: the customers'' all-time searches when above zero, otherwise the sum of the active stores'' catalog searches. search_source says which.';
comment on column public.product_stats.average_rating is 'Final rating from private.fn_product_rating_sources(): at least 3 ratings, customers first, then stores; NULL when there is none.';
comment on column public.product_stats.reviews_count is 'How many ratings stand behind average_rating (0 when there is no rating).';
comment on column public.product_stats.rating_source is 'customers (approved reviews) or store_catalog (ratings reported by active stores); NULL when there is no rating.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. the customers' figures: all time (no 365-day window) plus the archive of deleted guests
create or replace function private.fn_product_public_activity()
returns table (product_id uuid, views_count integer, search_count integer, sales_count integer)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with activity as (
    select a.product_id, a.event_type, a.event_count::bigint as n
      from public.guest_product_analytics a
     where a.event_type in ('view', 'search')
    union all
    select e.product_id, e.event_type, 1::bigint
      from public.customer_product_events e
     where e.user_id is not null
       and e.event_type in ('view', 'search')
    union all
    select r.product_id, r.event_type, r.event_count
      from private.product_activity_archive r
  ), activity_totals as (
    select product_id,
           coalesce(sum(n) filter (where event_type = 'view'), 0) as views,
           coalesce(sum(n) filter (where event_type = 'search'), 0) as searches
      from activity
     where product_id is not null
     group by product_id
  ), sold as (
    select s.product_id, s.units_sold from public.registered_customer_best_sellers s where s.product_id is not null
  )
  select coalesce(t.product_id, s.product_id),
         least(coalesce(t.views, 0), 2147483647)::integer,
         least(coalesce(t.searches, 0), 2147483647)::integer,
         least(coalesce(s.units_sold, 0), 2147483647)::integer
    from activity_totals t
    full join sold s on s.product_id = t.product_id;
$function$;

comment on function private.fn_product_public_activity() is
  'The customers'' own all-time figures per perfume: guest counters + registered customers'' events + the archive of guests deleted by retention (views, searches); sold units from registered_customer_best_sellers. No time window. Feeds private.refresh_product_stats().';

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. the writers of the final table
create or replace function private.refresh_product_ratings(p_products uuid[] default null)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_changed integer;
begin
  insert into public.product_stats as t (product_id, average_rating, reviews_count, rating_source)
  select p.id, r.average_rating, coalesce(r.ratings_count, 0), r.rating_source
    from public.products p
    left join private.fn_product_rating_sources() r on r.product_id = p.id
   where p_products is null or p.id = any (p_products)
  on conflict (product_id) do update
    set average_rating = excluded.average_rating,
        reviews_count = excluded.reviews_count,
        rating_source = excluded.rating_source
    where (t.average_rating, t.reviews_count, t.rating_source) is distinct from (excluded.average_rating, excluded.reviews_count, excluded.rating_source);
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$function$;

create or replace function private.refresh_product_stats(p_products uuid[] default null)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_changed integer;
begin
  with act as (
    select a.product_id, a.sales_count::bigint as sales, a.views_count::bigint as views, a.search_count::bigint as searches
      from private.fn_product_public_activity() a
  ), store_sales as (
    select ps.product_id, sum(t.units_sold)::bigint as v
      from public.store_catalog_best_sellers t
      join public.stores st on st.id = t.store_id and st.status = 'active'
      join public.product_sizes ps on ps.id = t.product_size_id
     group by ps.product_id
  ), store_views as (
    select ps.product_id, sum(t.views_count)::bigint as v
      from public.store_catalog_most_viewed t
      join public.stores st on st.id = t.store_id and st.status = 'active'
      join public.product_sizes ps on ps.id = t.product_size_id
     group by ps.product_id
  ), store_searches as (
    select ps.product_id, sum(t.searches_count)::bigint as v
      from public.store_catalog_most_searched t
      join public.stores st on st.id = t.store_id and st.status = 'active'
      join public.product_sizes ps on ps.id = t.product_size_id
     group by ps.product_id
  ), calc as (
    select p.id as product_id,
           case when coalesce(a.views, 0) > 0 then a.views when coalesce(sv.v, 0) > 0 then sv.v else 0 end as views,
           case when coalesce(a.views, 0) > 0 then 'customers' when coalesce(sv.v, 0) > 0 then 'store_catalog' end as views_source,
           case when coalesce(a.sales, 0) > 0 then a.sales when coalesce(ss.v, 0) > 0 then ss.v else 0 end as sales,
           case when coalesce(a.sales, 0) > 0 then 'customers' when coalesce(ss.v, 0) > 0 then 'store_catalog' end as sales_source,
           case when coalesce(a.searches, 0) > 0 then a.searches when coalesce(sq.v, 0) > 0 then sq.v else 0 end as searches,
           case when coalesce(a.searches, 0) > 0 then 'customers' when coalesce(sq.v, 0) > 0 then 'store_catalog' end as search_source,
           r.average_rating, coalesce(r.ratings_count, 0) as reviews, r.rating_source
      from public.products p
      left join act a on a.product_id = p.id
      left join store_sales ss on ss.product_id = p.id
      left join store_views sv on sv.product_id = p.id
      left join store_searches sq on sq.product_id = p.id
      left join private.fn_product_rating_sources() r on r.product_id = p.id
     where p_products is null or p.id = any (p_products)
  )
  insert into public.product_stats as t
    (product_id, views_count, views_source, sales_count, sales_source, search_count, search_source, average_rating, reviews_count, rating_source)
  select c.product_id,
         least(c.views, 2147483647)::integer, c.views_source,
         least(c.sales, 2147483647)::integer, c.sales_source,
         least(c.searches, 2147483647)::integer, c.search_source,
         c.average_rating, c.reviews, c.rating_source
    from calc c
  on conflict (product_id) do update
    set views_count = excluded.views_count, views_source = excluded.views_source,
        sales_count = excluded.sales_count, sales_source = excluded.sales_source,
        search_count = excluded.search_count, search_source = excluded.search_source,
        average_rating = excluded.average_rating, reviews_count = excluded.reviews_count, rating_source = excluded.rating_source
    where (t.views_count, t.views_source, t.sales_count, t.sales_source, t.search_count, t.search_source, t.average_rating, t.reviews_count, t.rating_source)
          is distinct from
          (excluded.views_count, excluded.views_source, excluded.sales_count, excluded.sales_source, excluded.search_count, excluded.search_source,
           excluded.average_rating, excluded.reviews_count, excluded.rating_source);
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$function$;

revoke all on function private.refresh_product_ratings(uuid[]) from public, anon, authenticated;
revoke all on function private.refresh_product_stats(uuid[]) from public, anon, authenticated;

comment on function private.refresh_product_stats(uuid[]) is
  'Computes the final per-perfume figures (customers first, otherwise the active stores'' catalog figures; rating from private.fn_product_rating_sources()) and writes only the rows that changed into public.product_stats. NULL = every perfume. Run by pg_cron every 5 minutes.';
comment on function private.refresh_product_ratings(uuid[]) is
  'Same as private.refresh_product_stats() but only the rating columns, for the review trigger.';

-- the review trigger no longer writes a raw average (that ignored the "at least 3 ratings" rule)
create or replace function private.refresh_product_rating()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform private.refresh_product_ratings(array_remove(array[new.product_id, old.product_id], null));
  return null;
end
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. what the storefront reads: the final table, through a private definer function (the table's own RLS stays as it was)
create or replace function private.fn_product_final_stats()
returns table (product_id uuid, views_count integer, views_source text, sales_count integer, sales_source text,
               search_count integer, search_source text, average_rating numeric, reviews_count integer, rating_source text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select s.product_id, s.views_count, s.views_source, s.sales_count, s.sales_source, s.search_count, s.search_source,
         s.average_rating, s.reviews_count, s.rating_source
    from public.product_stats s;
$function$;

revoke all on function private.fn_product_final_stats() from public;
grant execute on function private.fn_product_final_stats() to anon, authenticated, service_role;

comment on function private.fn_product_final_stats() is
  'The final per-perfume figures of public.product_stats (views, sales, searches, rating, each with its source). Read by the rankings and by public_products.';

-- the four rankings rank the final figures: customers-sourced figures first (by size), then the stores'-sourced ones
create or replace function private.fn_storefront_product_rankings()
returns table (product_id uuid, sales_rank integer, sales_source text, views_rank integer, views_source text,
               searches_rank integer, searches_source text, rating_rank integer, rating_source text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with offered as (
    select distinct o.product_id
      from private.fn_catalog_public_platform_offers() o
      join public.products p on p.id = o.product_id and p.status = 'published' and p.is_active
  ), m as (
    select f.product_id,
           s.sales_count as sales, s.sales_source as ssrc,
           s.views_count as views, s.views_source as vsrc,
           s.search_count as searches, s.search_source as qsrc,
           s.average_rating as ar, s.reviews_count as rn, s.rating_source as rsrc
      from offered f
      join private.fn_product_final_stats() s on s.product_id = f.product_id
  ), r as (
    select m.*,
           rank() over (partition by (ssrc is not null) order by (ssrc = 'customers') desc nulls last, sales desc) as sales_r,
           rank() over (partition by (vsrc is not null) order by (vsrc = 'customers') desc nulls last, views desc) as views_r,
           rank() over (partition by (qsrc is not null) order by (qsrc = 'customers') desc nulls last, searches desc) as searches_r,
           rank() over (partition by (ar is not null)
                        order by (rsrc = 'customers') desc nulls last, ar desc nulls last, rn desc nulls last) as rating_r
      from m
  )
  select r.product_id,
         case when r.ssrc is not null then r.sales_r::integer end, r.ssrc,
         case when r.vsrc is not null then r.views_r::integer end, r.vsrc,
         case when r.qsrc is not null then r.searches_r::integer end, r.qsrc,
         case when r.ar is not null then r.rating_r::integer end, r.rsrc
    from r
   where r.ssrc is not null or r.vsrc is not null or r.qsrc is not null or r.ar is not null;
$function$;

-- public_products: the figures on a card are the same final figures (same columns, same types)
create or replace view public.public_products with (security_invoker = true) as
 SELECT p.id,
    p.brand_id,
    b.name AS brand_name,
    b.slug AS brand_slug,
    p.name,
    p.slug,
    p.short_description,
    p.official_description,
    p.composition,
    p.gender,
    p.notes_source,
    p.meta_title,
    p.meta_description,
    ( SELECT min(co.price) AS min
           FROM cheapest_offers co
          WHERE co.product_id = p.id) AS min_price,
    ( SELECT count(*) AS count
           FROM cheapest_offers co
          WHERE co.product_id = p.id) AS available_sizes,
    COALESCE(st.views_count, 0) AS views_count,
    COALESCE(st.sales_count, 0) AS sales_count,
    COALESCE(st.search_count, 0) AS search_count,
    st.average_rating::numeric(3,2) AS average_rating,
    nullif(st.reviews_count, 0) AS reviews_count
   FROM products p
     JOIN brands b ON b.id = p.brand_id
     LEFT JOIN private.fn_product_final_stats() st ON st.product_id = p.id
  WHERE p.status = 'published'::text AND p.is_active AND (EXISTS ( SELECT 1
           FROM cheapest_offers co
          WHERE co.product_id = p.id));

comment on view public.public_products is
  'Published perfumes that have a platform offer. views/sales/search and the rating come from the final table public.product_stats (customers first, otherwise the stores'' catalogs); average_rating/reviews_count are NULL until a perfume has >= 3 real ratings.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. retention folds the deleted guests' views and searches into the archive first (everything else is as it was)
create or replace function public.purge_expired_guest_fingerprints(p_retention interval default '400 days'::interval)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_cutoff timestamptz;
  v_batch integer;
  v_ids uuid[];
  v_fingerprints bigint := 0;
  v_links bigint := 0;
  v_visitors bigint := 0;
  v_events bigint := 0;
  v_sessions bigint := 0;
  v_hashes text[];
  v_counter_visits bigint := 0;
  v_counter_products bigint := 0;
begin
  -- A guard against a typo turning this into "delete everything": nothing shorter than 30 days is accepted.
  if p_retention is null or p_retention < interval '30 days' then
    raise exception 'guest retention must be at least 30 days' using errcode = '22023';
  end if;
  v_cutoff := now() - p_retention;

  -- The anonymous counters of a browser that has shown no sign of life for the whole period go with the guest.
  -- A browser is alive while any of its counter rows or stored fingerprints was seen inside the period; once it
  -- is not, every one of its days is deleted together, never only the old days of a guest who is still active.
  loop
    select coalesce(array_agg(h), array[]::text[]) into v_hashes from (
      select c.h from (
        select visitor_hash as h from public.guest_analytics_visits where last_seen_at < v_cutoff
        union
        select visitor_hash from public.guest_product_analytics where last_seen_at < v_cutoff
      ) c
      where not exists (select 1 from public.guest_analytics_visits x where x.visitor_hash = c.h and x.last_seen_at >= v_cutoff)
        and not exists (select 1 from public.guest_product_analytics x where x.visitor_hash = c.h and x.last_seen_at >= v_cutoff)
        and not exists (select 1 from public.guest_fingerprints x where x.analytics_hash = c.h and x.last_seen_at >= v_cutoff)
      limit 1000
    ) s;
    exit when cardinality(v_hashes) = 0;
    -- the views and searches of these browsers stay in the all-time totals, as anonymous sums per perfume
    insert into private.product_activity_archive as t (product_id, event_type, event_count)
      select a.product_id, a.event_type, sum(a.event_count)::bigint
        from public.guest_product_analytics a
       where a.visitor_hash = any(v_hashes) and a.event_type in ('view', 'search') and a.product_id is not null
       group by a.product_id, a.event_type
    on conflict (product_id, event_type) do update
      set event_count = t.event_count + excluded.event_count, updated_at = now();
    delete from public.guest_product_analytics where visitor_hash = any(v_hashes);
    get diagnostics v_batch = row_count;
    v_counter_products := v_counter_products + v_batch;
    delete from public.guest_analytics_visits where visitor_hash = any(v_hashes);
    get diagnostics v_batch = row_count;
    v_counter_visits := v_counter_visits + v_batch;
  end loop;

  loop
    with expired as (
      select ctid from public.guest_fingerprints where last_seen_at < v_cutoff order by last_seen_at limit 1000
    )
    delete from public.guest_fingerprints g using expired where g.ctid = expired.ctid;
    get diagnostics v_batch = row_count;
    v_fingerprints := v_fingerprints + v_batch;
    exit when v_batch < 1000;
  end loop;

  loop
    with expired as (
      select ctid from public.guest_identity_links where last_confirmed_at < v_cutoff order by last_confirmed_at limit 1000
    )
    delete from public.guest_identity_links l using expired where l.ctid = expired.ctid;
    get diagnostics v_batch = row_count;
    v_links := v_links + v_batch;
    exit when v_batch < 1000;
  end loop;

  loop
    select coalesce(array_agg(id), array[]::uuid[]) into v_ids from (
      select id from public.guest_visitors where status = 'guest' and last_seen_at < v_cutoff order by last_seen_at limit 1000
    ) s;
    exit when cardinality(v_ids) = 0;
    delete from public.customer_product_events where guest_id = any(v_ids);
    get diagnostics v_batch = row_count;
    v_events := v_events + v_batch;
    delete from public.customer_sessions where guest_id = any(v_ids);
    get diagnostics v_batch = row_count;
    v_sessions := v_sessions + v_batch;
    delete from public.guest_visitors where id = any(v_ids);
    get diagnostics v_batch = row_count;
    v_visitors := v_visitors + v_batch;
  end loop;

  return jsonb_build_object('guest_fingerprints', v_fingerprints, 'guest_identity_links', v_links, 'guest_visitors', v_visitors,
                            'guest_product_events', v_events, 'guest_sessions', v_sessions,
                            'guest_counter_visit_rows', v_counter_visits, 'guest_counter_product_rows', v_counter_products);
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. fill the table now (this replaces the ten sample rows with the real figures), then guard it and keep it fresh
select private.refresh_product_stats();

alter table public.product_stats
  add constraint product_stats_views_source_matches check ((views_source is null) = (views_count = 0)),
  add constraint product_stats_sales_source_matches check ((sales_source is null) = (sales_count = 0)),
  add constraint product_stats_search_source_matches check ((search_source is null) = (search_count = 0)),
  add constraint product_stats_rating_source_matches check ((rating_source is null) = (average_rating is null));

select cron.schedule(
  'refresh-product-stats-5min',
  '*/5 * * * *',
  'select private.refresh_product_stats();'
);
