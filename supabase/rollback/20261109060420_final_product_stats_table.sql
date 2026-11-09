-- Rollback of final_product_stats_table (20261109060420; the header of the migration still calls it 20261108120000, its draft
-- name - this is that rollback).
-- Puts everything back as it was after 20261108061117: the figures are computed from the raw tables again on every read, for
-- the last 365 days only; the review trigger writes the raw average again; retention deletes idle guests without folding;
-- product_stats goes back to the columns it had, request_count included, and the ten sample rows it held are restored.
--
-- WHAT IS NOT RESTORED: private.product_activity_archive is dropped, so the views and searches of the guests that retention
-- folded into it after the migration are lost (the originals were deleted by retention on purpose). If you only want to
-- stop the new behaviour for a while, unschedule the job instead (select cron.unschedule('refresh-product-stats-5min')).
-- The restored sample figures are the hand-entered numbers measured before the migration (views 25..250, sales 10..100,
-- search_count 0, request_count 0, no rating); nothing public reads product_stats, so they only sit in the table.
begin;

select cron.unschedule('refresh-product-stats-5min');

create or replace function private.fn_product_public_activity()
returns table (product_id uuid, views_count integer, search_count integer, sales_count integer)
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
    rt.average_rating::numeric(3,2) AS average_rating,
    rt.ratings_count AS reviews_count
   FROM products p
     JOIN brands b ON b.id = p.brand_id
     LEFT JOIN private.fn_product_public_activity() act(product_id, views_count, search_count, sales_count) ON act.product_id = p.id
     LEFT JOIN private.fn_product_rating_sources() rt ON rt.product_id = p.id
  WHERE p.status = 'published'::text AND p.is_active AND (EXISTS ( SELECT 1
           FROM cheapest_offers co
          WHERE co.product_id = p.id));

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

create or replace function private.refresh_product_rating()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare pid uuid := coalesce(new.product_id, old.product_id);
begin
  update public.product_stats set
    average_rating = (select round(avg(rating)::numeric, 2) from public.reviews
                      where product_id = pid and is_approved),
    reviews_count = (select count(*) from public.reviews
                     where product_id = pid and is_approved)
  where product_id = pid;
  return null;
end $function$;

drop function private.refresh_product_stats(uuid[]);
drop function private.refresh_product_ratings(uuid[]);
drop function private.fn_product_final_stats();

alter table public.product_stats
  drop constraint product_stats_views_source_matches,
  drop constraint product_stats_sales_source_matches,
  drop constraint product_stats_search_source_matches,
  drop constraint product_stats_rating_source_matches,
  drop column views_source,
  drop column sales_source,
  drop column search_source,
  drop column rating_source,
  add column request_count integer not null default 0;

-- the sample figures the table held before (by perfume)
update public.product_stats s
   set views_count = v.views_count, sales_count = v.sales_count, search_count = 0, average_rating = null, reviews_count = 0
  from (values
    ('c58f79e5-b869-491d-98d9-170bd993c501'::uuid, 250, 100),
    ('39f00090-61f4-4141-8ff6-807084ac915e'::uuid, 225, 90),
    ('705e7a87-ddd5-43f7-a985-1a3806de610b'::uuid, 200, 80),
    ('f807c063-a027-4ec4-ad78-8577a66e0f01'::uuid, 175, 70),
    ('0e194e77-75d9-4764-8bde-98e248509b44'::uuid, 150, 60),
    ('31f82b1b-70a3-4e36-bcbe-70190ed6b60c'::uuid, 125, 50),
    ('6cb0f69f-7c63-4cb9-9c2f-395e2e68356c'::uuid, 100, 40),
    ('bebf290e-971d-4435-88eb-362df238f8d0'::uuid, 75, 30),
    ('1c5a6f0a-d642-4f7b-8861-625196725129'::uuid, 50, 20),
    ('ad4ab59a-4620-4406-9f9d-f78072e954f4'::uuid, 25, 10)
  ) as v(product_id, views_count, sales_count)
 where s.product_id = v.product_id;

drop table private.product_activity_archive;

comment on table public.product_stats is null;
comment on column public.product_stats.views_count is null;
comment on column public.product_stats.sales_count is null;
comment on column public.product_stats.search_count is null;
comment on column public.product_stats.average_rating is null;
comment on column public.product_stats.reviews_count is null;

comment on view public.public_products is
  'Published perfumes that have a platform offer. views/sales/search from the customers tables; average_rating/reviews_count only when private.fn_product_rating_sources() has >= 3 real ratings, otherwise NULL.';

commit;
