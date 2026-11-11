-- Rollback of 20261111122138_product_rating_participants_mean: back to the weighted rating (customers + stores pooled,
-- shown from 3 ratings together) of migration 20261110060252, without the rating_top_source_count column.
-- The last statement before dropping the column recomputes the table with the restored rule.
begin;

alter table public.product_stats drop constraint product_stats_rating_top_matches;

drop function private.fn_product_rating_sources();

create function private.fn_product_rating_sources()
returns table (product_id uuid, average_rating numeric, ratings_count integer, rating_source text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with cust as (
    select r.product_id, sum(r.rating)::numeric as total, count(*)::integer as n
      from public.reviews r
     where r.is_approved
     group by r.product_id
  ), store as (
    select ps.product_id, sum(t.average_rating * t.ratings_count)::numeric as total, sum(t.ratings_count)::integer as n
      from public.store_catalog_ratings t
      join public.stores st on st.id = t.store_id and st.status = 'active'
      join public.product_sizes ps on ps.id = t.product_size_id
     group by ps.product_id
  )
  select coalesce(c.product_id, s.product_id),
         round((coalesce(c.total, 0) + coalesce(s.total, 0)) / (coalesce(c.n, 0) + coalesce(s.n, 0)), 2),
         (coalesce(c.n, 0) + coalesce(s.n, 0))::integer,
         case when coalesce(c.n, 0) > 0 and coalesce(s.n, 0) > 0 then 'combined'
              when coalesce(c.n, 0) > 0 then 'customers'
              else 'store_catalog' end
    from cust c
    full join store s on s.product_id = c.product_id
   where coalesce(c.n, 0) + coalesce(s.n, 0) >= 3;
$function$;

revoke all on function private.fn_product_rating_sources() from public;
grant execute on function private.fn_product_rating_sources() to anon, authenticated, service_role;

comment on function private.fn_product_rating_sources() is
  'The only place a perfume rating is computed: the average of every approved customer review and every rating reported by an active store, weighted by the number of ratings, shown from 3 ratings together. rating_source = customers, store_catalog or combined.';

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

comment on function private.refresh_product_ratings(uuid[]) is
  'Same as private.refresh_product_stats() but only the rating columns, for the review trigger.';

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
           round((coalesce(a.views, 0) + coalesce(sv.v, 0)) / 2.0)::bigint as views,
           case when coalesce(a.views, 0) > 0 and coalesce(sv.v, 0) > 0 then 'combined'
                when coalesce(a.views, 0) > 0 then 'customers'
                when coalesce(sv.v, 0) > 0 then 'store_catalog' end as views_source,
           round((coalesce(a.sales, 0) + coalesce(ss.v, 0)) / 2.0)::bigint as sales,
           case when coalesce(a.sales, 0) > 0 and coalesce(ss.v, 0) > 0 then 'combined'
                when coalesce(a.sales, 0) > 0 then 'customers'
                when coalesce(ss.v, 0) > 0 then 'store_catalog' end as sales_source,
           round((coalesce(a.searches, 0) + coalesce(sq.v, 0)) / 2.0)::bigint as searches,
           case when coalesce(a.searches, 0) > 0 and coalesce(sq.v, 0) > 0 then 'combined'
                when coalesce(a.searches, 0) > 0 then 'customers'
                when coalesce(sq.v, 0) > 0 then 'store_catalog' end as search_source,
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
  'Computes the final per-perfume figures and writes only the rows that changed into public.product_stats: sales, views and searches = round((customers + sum of the active stores) / 2), rating = weighted average of customers'' and stores'' ratings (private.fn_product_rating_sources()). NULL = every perfume. Run by pg_cron every 5 minutes.';

comment on column public.product_stats.average_rating is 'Final rating from private.fn_product_rating_sources(): customers'' and stores'' ratings together, weighted by their counts, from 3 ratings; NULL when there is none.';
comment on column public.product_stats.reviews_count is 'How many ratings (customers'' and stores'') stand behind average_rating (0 when there is no rating).';
comment on column public.product_stats.rating_source is 'customers (approved reviews only), store_catalog (ratings reported by active stores only) or combined (both); NULL when there is no rating.';

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
           rank() over (partition by (ssrc is not null) order by sales desc) as sales_r,
           rank() over (partition by (vsrc is not null) order by views desc) as views_r,
           rank() over (partition by (qsrc is not null) order by searches desc) as searches_r,
           rank() over (partition by (ar is not null) order by ar desc nulls last, rn desc nulls last) as rating_r
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

comment on function private.fn_storefront_product_rankings() is
  'Masterpieces ranking per perfume the platform offers right now: sales / views / searches / rating ranks (NULL = not part of that button), customers'' real figures first, store catalog figures second. Returns product ids, ranks and the source of each rank only.';

select private.refresh_product_stats();

alter table public.product_stats
  drop constraint product_stats_rating_top_nonnegative,
  drop column rating_top_source_count;

commit;
