-- Rollback of 20261110060252_product_stats_mean_of_customers_and_stores.sql: back to "the customers' figure when it is above zero,
-- otherwise the sum of the active stores' figures (never summed)" for sales / views / searches, to "customers' rating first, then the
-- stores', each needing 3 ratings", and to the ranking that puts customers-sourced figures first. Nothing is lost: product_stats is a
-- computed table, so the old functions recompute it, and the third source value 'combined' is removed only after that.
begin;

create or replace function private.fn_product_rating_sources()
returns table (product_id uuid, average_rating numeric, ratings_count integer, rating_source text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with cust as (
    select r.product_id, round(avg(r.rating)::numeric, 2) as avg_rating, count(*)::integer as n
      from public.reviews r
     where r.is_approved
     group by r.product_id
    having count(*) >= 3
  ), store as (
    select ps.product_id,
           round(sum(t.average_rating * t.ratings_count) / sum(t.ratings_count), 2) as avg_rating,
           sum(t.ratings_count)::integer as n
      from public.store_catalog_ratings t
      join public.stores st on st.id = t.store_id and st.status = 'active'
      join public.product_sizes ps on ps.id = t.product_size_id
     group by ps.product_id
    having sum(t.ratings_count) >= 3
  )
  select coalesce(c.product_id, s.product_id),
         coalesce(c.avg_rating, s.avg_rating),
         coalesce(c.n, s.n),
         case when c.product_id is not null then 'customers' else 'store_catalog' end
    from cust c
    full join store s on s.product_id = c.product_id;
$function$;

comment on function private.fn_product_rating_sources() is
  'The only place a perfume rating is computed: >= 3 approved customer reviews, otherwise >= 3 ratings reported by active stores catalogs. Feeds the most-rated ranking and public_products.average_rating.';

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

comment on function private.refresh_product_stats(uuid[]) is
  'Computes the final per-perfume figures (customers first, otherwise the active stores'' catalog figures; rating from private.fn_product_rating_sources()) and writes only the rows that changed into public.product_stats. NULL = every perfume. Run by pg_cron every 5 minutes.';
comment on table public.product_stats is
  'The final, all-time figures per perfume: the net result of comparing the customers'' tables with the stores'' catalog tables. Written only by private.refresh_product_stats() (pg_cron every 5 minutes, and the review trigger for the rating). Read through private.fn_product_final_stats().';
comment on column public.product_stats.views_count is 'Final views: the customers'' all-time views when above zero, otherwise the sum of the active stores'' catalog views. views_source says which.';
comment on column public.product_stats.sales_count is 'Final sold units: the registered customers'' net sold units when above zero, otherwise the sum of the active stores'' catalog sales. sales_source says which.';
comment on column public.product_stats.search_count is 'Final searches: the customers'' all-time searches when above zero, otherwise the sum of the active stores'' catalog searches. search_source says which.';
comment on column public.product_stats.average_rating is 'Final rating from private.fn_product_rating_sources(): at least 3 ratings, customers first, then stores; NULL when there is none.';
comment on column public.product_stats.reviews_count is 'How many ratings stand behind average_rating (0 when there is no rating).';
comment on column public.product_stats.rating_source is 'customers (approved reviews) or store_catalog (ratings reported by active stores); NULL when there is no rating.';

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

comment on view public.public_products is
  'Published perfumes that have a platform offer. views/sales/search and the rating come from the final table public.product_stats (customers first, otherwise the stores'' catalogs); average_rating/reviews_count are NULL until a perfume has >= 3 real ratings.';

-- recompute with the old rule (no row can carry 'combined' afterwards), then narrow the source checks again
select private.refresh_product_stats();

alter table public.product_stats
  drop constraint product_stats_views_source_check,
  drop constraint product_stats_sales_source_check,
  drop constraint product_stats_search_source_check,
  drop constraint product_stats_rating_source_check,
  add constraint product_stats_views_source_check check (views_source in ('customers', 'store_catalog')),
  add constraint product_stats_sales_source_check check (sales_source in ('customers', 'store_catalog')),
  add constraint product_stats_search_source_check check (search_source in ('customers', 'store_catalog')),
  add constraint product_stats_rating_source_check check (rating_source in ('customers', 'store_catalog'));

commit;
