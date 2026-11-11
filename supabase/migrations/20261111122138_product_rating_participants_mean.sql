-- Owner's decision 2026-11-10: the final rating of a perfume is built from the PARTICIPANTS, not from a pooled average.
--
-- Participants of one perfume: the customers (when at least one approved review exists) and every ACTIVE store that reported
-- at least one rating for it. A store without the perfume, or without a rating for it, is not a participant.
--
--   ratings count (shown next to the stars, and the tie-break) = round((customers' ratings + all stores' ratings) / 2)
--   stars (shown on every card and page)                        = plain mean of the participants' own averages,
--                                                                 divisor = number of participants, stored at 2 decimals
--   no minimum for the figures to exist or to be shown; no rating at all -> no count and no stars
--
-- «الأكثر تقييمًا» (the ranking / filter chip) is a different question from "has a rating". A perfume is ranked only when
--   (a) one participant alone (the customers, or a single store) has at least 3 ratings for it, and
--   (b) the stored final stars are >= 3.00 (2.99 stays out; it is never rounded up to 3),
-- and the ranked ones are ordered by final stars, then by final ratings count; ties share a rank. A perfume outside the
-- ranking still shows its count and stars on its own page and cards.
--
-- Changes: one new column (rating_top_source_count = the biggest single participant's ratings count, written next to the
-- figures so the ranking needs no recomputation), the rating function, both writers of product_stats, the ranking function
-- and comments. Nothing is deleted; the last statements recompute the table with the new rule and add the check that ties
-- the new column to the rating. Rollback: supabase/rollback/<this version>_product_rating_participants_mean.sql.

-- 1. the eligibility figure, next to the rating it belongs to
alter table public.product_stats
  add column rating_top_source_count integer not null default 0,
  add constraint product_stats_rating_top_nonnegative check (rating_top_source_count >= 0);

-- 2. the rating: one row per perfume that has at least one participant
drop function private.fn_product_rating_sources();

create function private.fn_product_rating_sources()
returns table (product_id uuid, average_rating numeric, ratings_count integer, top_source_count integer, rating_source text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with participants as (
    select r.product_id, 'customers'::text as kind, avg(r.rating)::numeric as avg_rating, count(*)::bigint as n
      from public.reviews r
     where r.is_approved
     group by r.product_id
    union all
    select ps.product_id, 'store'::text, sum(t.average_rating * t.ratings_count) / sum(t.ratings_count), sum(t.ratings_count)::bigint
      from public.store_catalog_ratings t
      join public.stores st on st.id = t.store_id and st.status = 'active'
      join public.product_sizes ps on ps.id = t.product_size_id
     group by ps.product_id, t.store_id
  )
  select p.product_id,
         round(avg(p.avg_rating), 2),
         least(round(sum(p.n) / 2.0), 2147483647)::integer,
         least(max(p.n), 2147483647)::integer,
         case when bool_and(p.kind = 'customers') then 'customers'
              when bool_and(p.kind = 'store') then 'store_catalog'
              else 'combined' end
    from participants p
   group by p.product_id;
$function$;

revoke all on function private.fn_product_rating_sources() from public;
grant execute on function private.fn_product_rating_sources() to anon, authenticated, service_role;

comment on function private.fn_product_rating_sources() is
  'The only place a perfume rating is computed. Participants = the customers (approved reviews) and every active store that rated the perfume. average_rating = mean of the participants'' own averages (2 decimals); ratings_count = round(all ratings / 2); top_source_count = the biggest single participant''s ratings count; rating_source = customers, store_catalog or combined. No minimum here: the 3-ratings and 3.00-stars conditions belong to the ranking.';

-- 3. both writers of public.product_stats carry the new column
create or replace function private.refresh_product_ratings(p_products uuid[] default null)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_changed integer;
begin
  insert into public.product_stats as t (product_id, average_rating, reviews_count, rating_top_source_count, rating_source)
  select p.id, r.average_rating, coalesce(r.ratings_count, 0), coalesce(r.top_source_count, 0), r.rating_source
    from public.products p
    left join private.fn_product_rating_sources() r on r.product_id = p.id
   where p_products is null or p.id = any (p_products)
  on conflict (product_id) do update
    set average_rating = excluded.average_rating,
        reviews_count = excluded.reviews_count,
        rating_top_source_count = excluded.rating_top_source_count,
        rating_source = excluded.rating_source
    where (t.average_rating, t.reviews_count, t.rating_top_source_count, t.rating_source)
          is distinct from
          (excluded.average_rating, excluded.reviews_count, excluded.rating_top_source_count, excluded.rating_source);
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
           r.average_rating, coalesce(r.ratings_count, 0) as reviews, coalesce(r.top_source_count, 0) as top_count, r.rating_source
      from public.products p
      left join act a on a.product_id = p.id
      left join store_sales ss on ss.product_id = p.id
      left join store_views sv on sv.product_id = p.id
      left join store_searches sq on sq.product_id = p.id
      left join private.fn_product_rating_sources() r on r.product_id = p.id
     where p_products is null or p.id = any (p_products)
  )
  insert into public.product_stats as t
    (product_id, views_count, views_source, sales_count, sales_source, search_count, search_source,
     average_rating, reviews_count, rating_top_source_count, rating_source)
  select c.product_id,
         least(c.views, 2147483647)::integer, c.views_source,
         least(c.sales, 2147483647)::integer, c.sales_source,
         least(c.searches, 2147483647)::integer, c.search_source,
         c.average_rating, c.reviews, c.top_count, c.rating_source
    from calc c
  on conflict (product_id) do update
    set views_count = excluded.views_count, views_source = excluded.views_source,
        sales_count = excluded.sales_count, sales_source = excluded.sales_source,
        search_count = excluded.search_count, search_source = excluded.search_source,
        average_rating = excluded.average_rating, reviews_count = excluded.reviews_count,
        rating_top_source_count = excluded.rating_top_source_count, rating_source = excluded.rating_source
    where (t.views_count, t.views_source, t.sales_count, t.sales_source, t.search_count, t.search_source,
           t.average_rating, t.reviews_count, t.rating_top_source_count, t.rating_source)
          is distinct from
          (excluded.views_count, excluded.views_source, excluded.sales_count, excluded.sales_source, excluded.search_count, excluded.search_source,
           excluded.average_rating, excluded.reviews_count, excluded.rating_top_source_count, excluded.rating_source);
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$function$;

comment on function private.refresh_product_stats(uuid[]) is
  'Computes the final per-perfume figures and writes only the rows that changed into public.product_stats: sales, views and searches = round((customers + sum of the active stores) / 2); rating = the participants'' mean stars, round(all ratings / 2) as the count, plus the biggest single participant''s count (private.fn_product_rating_sources()). NULL = every perfume. Run by pg_cron every 5 minutes.';
comment on function private.refresh_product_ratings(uuid[]) is
  'Writes only the rating columns of public.product_stats (average_rating, reviews_count, rating_top_source_count, rating_source) from private.fn_product_rating_sources(); called by the review trigger so a new approved review shows at once.';
comment on column public.product_stats.average_rating is 'Final stars: the mean of the participants'' own averages (customers and every active store that rated the perfume), 2 decimals; NULL when nobody rated it.';
comment on column public.product_stats.reviews_count is 'Final ratings count shown next to the stars: round((customers'' ratings + all active stores'' ratings) / 2); 0 when nobody rated it.';
comment on column public.product_stats.rating_top_source_count is 'The biggest single participant''s ratings count (the customers or one store); 0 when nobody rated it. The most-rated ranking needs at least 3 here.';
comment on column public.product_stats.rating_source is 'customers (approved reviews only), store_catalog (ratings reported by active stores only) or combined (both); NULL when nobody rated it.';

-- 4. the ranking: «الأكثر تقييمًا» = >= 3 ratings at one participant and final stars >= 3.00, best stars first, then the bigger count
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
           s.average_rating as ar, s.reviews_count as rn, s.rating_source as rsrc,
           coalesce(s.average_rating >= 3.00 and s.rating_top_source_count >= 3, false) as rated
      from offered f
      join public.product_stats s on s.product_id = f.product_id
  ), r as (
    select m.*,
           rank() over (partition by (ssrc is not null) order by sales desc) as sales_r,
           rank() over (partition by (vsrc is not null) order by views desc) as views_r,
           rank() over (partition by (qsrc is not null) order by searches desc) as searches_r,
           rank() over (partition by rated order by ar desc nulls last, rn desc nulls last) as rating_r
      from m
  )
  select r.product_id,
         case when r.ssrc is not null then r.sales_r::integer end, r.ssrc,
         case when r.vsrc is not null then r.views_r::integer end, r.vsrc,
         case when r.qsrc is not null then r.searches_r::integer end, r.qsrc,
         case when r.rated then r.rating_r::integer end, case when r.rated then r.rsrc end
    from r
   where r.ssrc is not null or r.vsrc is not null or r.qsrc is not null or r.rated;
$function$;

comment on function private.fn_storefront_product_rankings() is
  'Ranks of the four storefront rankings for the perfumes offered right now, read from public.product_stats. Sales, views and searches rank the final figures; the rating rank exists only for perfumes with >= 3 ratings at one participant and final stars >= 3.00, ordered by stars then by ratings count. Ties share a rank.';

-- 5. recompute with the new rule, then tie the new column to the rating
select private.refresh_product_stats();

alter table public.product_stats
  add constraint product_stats_rating_top_matches check ((rating_top_source_count > 0) = (average_rating is not null));
