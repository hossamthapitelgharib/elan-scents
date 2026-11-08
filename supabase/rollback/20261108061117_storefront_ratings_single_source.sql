-- Rollback of storefront_ratings_single_source: the ranking calculates the ratings itself again (as in
-- 20261107135337), public.public_products reads average_rating / reviews_count / request_count / distinctiveness_score from
-- public.product_stats and carries the catalog_bestseller flag again, and the shared rating function is dropped.
-- No data is lost either way (public.product_stats was never touched).
-- Run it only together with a frontend that still selects request_count, or the storefront keeps working without it:
-- the current storefront does not read request_count / distinctiveness_score / catalog_bestseller.
begin;

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
  ), cust as (
    select a.product_id, a.sales_count::numeric as sales, a.views_count::numeric as views, a.search_count::numeric as searches
      from private.fn_product_public_activity() a
  ), cust_rating as (
    select r.product_id, round(avg(r.rating)::numeric, 2) as avg_rating, count(*)::numeric as n
      from public.reviews r
     where r.is_approved
     group by r.product_id
    having count(*) >= 3
  ), store_sales as (
    select ps.product_id, sum(t.units_sold)::numeric as v
      from public.store_catalog_best_sellers t
      join public.stores st on st.id = t.store_id and st.status = 'active'
      join public.product_sizes ps on ps.id = t.product_size_id
     group by ps.product_id
  ), store_views as (
    select ps.product_id, sum(t.views_count)::numeric as v
      from public.store_catalog_most_viewed t
      join public.stores st on st.id = t.store_id and st.status = 'active'
      join public.product_sizes ps on ps.id = t.product_size_id
     group by ps.product_id
  ), store_searches as (
    select ps.product_id, sum(t.searches_count)::numeric as v
      from public.store_catalog_most_searched t
      join public.stores st on st.id = t.store_id and st.status = 'active'
      join public.product_sizes ps on ps.id = t.product_size_id
     group by ps.product_id
  ), store_rating as (
    select ps.product_id,
           round(sum(t.average_rating * t.ratings_count) / sum(t.ratings_count), 2) as avg_rating,
           sum(t.ratings_count)::numeric as n
      from public.store_catalog_ratings t
      join public.stores st on st.id = t.store_id and st.status = 'active'
      join public.product_sizes ps on ps.id = t.product_size_id
     group by ps.product_id
    having sum(t.ratings_count) >= 3
  ), m as (
    select f.product_id,
           coalesce(c.sales, 0) as cs, coalesce(ss.v, 0) as ss,
           coalesce(c.views, 0) as cv, coalesce(sv.v, 0) as sv,
           coalesce(c.searches, 0) as cq, coalesce(sq.v, 0) as sq,
           cr.avg_rating as ca, cr.n as cn,
           sr.avg_rating as sa, sr.n as sn
      from offered f
      left join cust c on c.product_id = f.product_id
      left join store_sales ss on ss.product_id = f.product_id
      left join store_views sv on sv.product_id = f.product_id
      left join store_searches sq on sq.product_id = f.product_id
      left join cust_rating cr on cr.product_id = f.product_id
      left join store_rating sr on sr.product_id = f.product_id
  ), r as (
    select m.*,
           rank() over (partition by (cs > 0 or ss > 0) order by cs desc, ss desc) as sales_r,
           rank() over (partition by (cv > 0 or sv > 0) order by cv desc, sv desc) as views_r,
           rank() over (partition by (cq > 0 or sq > 0) order by cq desc, sq desc) as searches_r,
           rank() over (partition by (ca is not null or sa is not null)
                        order by ca desc nulls last, cn desc nulls last, sa desc nulls last, sn desc nulls last) as rating_r
      from m
  )
  select r.product_id,
         case when r.cs > 0 or r.ss > 0 then r.sales_r::integer end,
         case when r.cs > 0 then 'customers' when r.ss > 0 then 'store_catalog' end,
         case when r.cv > 0 or r.sv > 0 then r.views_r::integer end,
         case when r.cv > 0 then 'customers' when r.sv > 0 then 'store_catalog' end,
         case when r.cq > 0 or r.sq > 0 then r.searches_r::integer end,
         case when r.cq > 0 then 'customers' when r.sq > 0 then 'store_catalog' end,
         case when r.ca is not null or r.sa is not null then r.rating_r::integer end,
         case when r.ca is not null then 'customers' when r.sa is not null then 'store_catalog' end
    from r
   where r.cs > 0 or r.ss > 0 or r.cv > 0 or r.sv > 0 or r.cq > 0 or r.sq > 0 or r.ca is not null or r.sa is not null;
$function$;

drop view public.public_products;
create view public.public_products with (security_invoker = true) as
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
    COALESCE(act.views_count, 0) AS views_count,
    COALESCE(act.sales_count, 0) AS sales_count,
    COALESCE(act.search_count, 0) AS search_count,
    ps.request_count,
    ps.average_rating,
    ps.reviews_count,
    ps.distinctiveness_score,
    COALESCE(( SELECT bool_or(sp.is_catalog_bestseller) AS bool_or
           FROM store_products sp
             JOIN product_sizes sps ON sps.id = sp.product_size_id
          WHERE sps.product_id = p.id AND sp.sync_status = 'synced'::text), false) AS catalog_bestseller
   FROM products p
     JOIN brands b ON b.id = p.brand_id
     LEFT JOIN product_stats ps ON ps.product_id = p.id
     LEFT JOIN private.fn_product_public_activity() act(product_id, views_count, search_count, sales_count) ON act.product_id = p.id
  WHERE p.status = 'published'::text AND p.is_active AND (EXISTS ( SELECT 1
           FROM cheapest_offers co
          WHERE co.product_id = p.id));

revoke all on public.public_products from public, anon, authenticated;
grant select on public.public_products to anon, authenticated, service_role;

drop function if exists private.fn_product_rating_sources();

commit;
