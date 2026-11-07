-- The storefront's best-seller / most-viewed / most-searched figures used to be read from public.product_stats,
-- a table that only holds hand-entered sample numbers (10..100 on the ten sample perfumes) and that no job or trigger
-- ever updated from what customers actually do. Masterpieces and its three filter buttons therefore ranked sample
-- data and ignored the real customer tables.
--
-- public.public_products (the only place the storefront reads these three figures from) now takes them from the
-- real sources, the same ones the customers dashboard shows:
--   sales_count  = units sold per perfume in public.registered_customer_best_sellers (completed, matched
--                  registered-customer orders, net of returns and refunds), all time;
--   views_count  = 'view'   events of guests (guest_product_analytics) and registered customers
--   search_count = 'search' events of guests and registered customers
--                  (views and searches over the last 365 days, Africa/Cairo days, the same window and the same
--                  guest / registered split as customer_product_ranking('all','year',...)).
-- request_count, average_rating, reviews_count and distinctiveness_score still come from product_stats.
--
-- Safety: the three figures are the same public columns as before and nothing else is exposed. The customer tables
-- stay private (RLS, no client grants). The aggregation runs in a SECURITY DEFINER function in the private schema
-- that returns only (product_id, three counts), read through the security_invoker view exactly like
-- private.fn_cheapest_offers() / public.cheapest_offers. No identity, session, search text or order is returned.

create or replace function private.fn_product_public_activity()
returns table(product_id uuid, views_count integer, search_count integer, sales_count integer)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with win as (
    select d_end,
           d_end - 364 as d_start,
           ((d_end - 364)::timestamp at time zone 'Africa/Cairo') as start_ts,
           ((d_end + 1)::timestamp at time zone 'Africa/Cairo') as end_ts
      from (select (now() at time zone 'Africa/Cairo')::date as d_end) d
  ), activity as (
    select a.product_id, a.event_type, a.event_count::bigint as n
      from public.guest_product_analytics a, win
     where a.event_type in ('view', 'search')
       and a.activity_date between win.d_start and win.d_end
    union all
    select e.product_id, e.event_type, 1::bigint
      from public.customer_product_events e, win
     where e.user_id is not null
       and e.event_type in ('view', 'search')
       and e.occurred_at >= win.start_ts and e.occurred_at < win.end_ts
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
  'Per-perfume storefront figures from the real customer tables: units sold (registered_customer_best_sellers, all time) and views / searches of guests and registered customers over the last 365 days. Returns product ids and counts only.';

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
     LEFT JOIN private.fn_product_public_activity() act ON act.product_id = p.id
  WHERE p.status = 'published'::text AND p.is_active AND (EXISTS ( SELECT 1
           FROM cheapest_offers co
          WHERE co.product_id = p.id));
