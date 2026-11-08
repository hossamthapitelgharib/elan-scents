-- One source for a perfume's rating, used by BOTH the "most rated" ranking and the stars on the card.
--
-- Before this, public.public_products.average_rating / reviews_count / request_count / distinctiveness_score came from
-- public.product_stats (hand-entered sample numbers; nothing but the review trigger ever refreshed them) while the "most
-- rated" button ranked from a different calculation. The two could disagree, and a perfume with ONE five-star review showed
-- five stars on the card.
--
-- Now there is a single rule, in a single function: a perfume has a rating only when it has at least 3 ratings from one
-- source - the customers' approved reviews first, otherwise the stores' catalog ratings (summed over active stores). The
-- ranking reads that function, public_products.average_rating / reviews_count read the same function, and everything that
-- cannot be backed by a real figure is gone from the public view:
--   request_count, distinctiveness_score  - never fed by anything (the home sections used to weigh them, "most
--                                           distinguished" is merged into "most rated" and no longer exists);
--   catalog_bestseller                    - a flag a store or the admin can switch by hand; the Masterpieces page now
--                                           follows the real sales ranking only.
-- public.product_stats and its data are NOT touched (private.refresh_product_rating keeps working); nothing public reads it.

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

revoke all on function private.fn_product_rating_sources() from public;
grant execute on function private.fn_product_rating_sources() to anon, authenticated, service_role;

comment on function private.fn_product_rating_sources() is
  'The only place a perfume rating is computed: >= 3 approved customer reviews, otherwise >= 3 ratings reported by active stores catalogs. Feeds the most-rated ranking and public_products.average_rating.';

-- The ranking now reads that function instead of repeating the calculation (same result columns, same rule).
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
  ), m as (
    select f.product_id,
           coalesce(c.sales, 0) as cs, coalesce(ss.v, 0) as ss,
           coalesce(c.views, 0) as cv, coalesce(sv.v, 0) as sv,
           coalesce(c.searches, 0) as cq, coalesce(sq.v, 0) as sq,
           ra.average_rating as ar, ra.ratings_count as rn, ra.rating_source as rsrc
      from offered f
      left join cust c on c.product_id = f.product_id
      left join store_sales ss on ss.product_id = f.product_id
      left join store_views sv on sv.product_id = f.product_id
      left join store_searches sq on sq.product_id = f.product_id
      left join private.fn_product_rating_sources() ra on ra.product_id = f.product_id
  ), r as (
    select m.*,
           rank() over (partition by (cs > 0 or ss > 0) order by cs desc, ss desc) as sales_r,
           rank() over (partition by (cv > 0 or sv > 0) order by cv desc, sv desc) as views_r,
           rank() over (partition by (cq > 0 or sq > 0) order by cq desc, sq desc) as searches_r,
           rank() over (partition by (ar is not null)
                        order by (rsrc = 'customers') desc nulls last, ar desc nulls last, rn desc nulls last) as rating_r
      from m
  )
  select r.product_id,
         case when r.cs > 0 or r.ss > 0 then r.sales_r::integer end,
         case when r.cs > 0 then 'customers' when r.ss > 0 then 'store_catalog' end,
         case when r.cv > 0 or r.sv > 0 then r.views_r::integer end,
         case when r.cv > 0 then 'customers' when r.sv > 0 then 'store_catalog' end,
         case when r.cq > 0 or r.sq > 0 then r.searches_r::integer end,
         case when r.cq > 0 then 'customers' when r.sq > 0 then 'store_catalog' end,
         case when r.ar is not null then r.rating_r::integer end,
         r.rsrc
    from r
   where r.cs > 0 or r.ss > 0 or r.cv > 0 or r.sv > 0 or r.cq > 0 or r.sq > 0 or r.ar is not null;
$function$;

-- public_products: the stars on a card come from the same function; the three columns nothing can back are gone.
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
    rt.average_rating::numeric(3,2) AS average_rating,
    rt.ratings_count AS reviews_count
   FROM products p
     JOIN brands b ON b.id = p.brand_id
     LEFT JOIN private.fn_product_public_activity() act(product_id, views_count, search_count, sales_count) ON act.product_id = p.id
     LEFT JOIN private.fn_product_rating_sources() rt ON rt.product_id = p.id
  WHERE p.status = 'published'::text AND p.is_active AND (EXISTS ( SELECT 1
           FROM cheapest_offers co
          WHERE co.product_id = p.id));

revoke all on public.public_products from public, anon, authenticated;
grant select on public.public_products to anon, authenticated, service_role;

comment on view public.public_products is
  'Published perfumes that have a platform offer. views/sales/search from the customers tables; average_rating/reviews_count only when private.fn_product_rating_sources() has >= 3 real ratings, otherwise NULL.';
