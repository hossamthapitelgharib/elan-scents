-- Masterpieces rankings: per-store catalog tables + one unified, offer-bound ranking view.
--
-- The four Masterpieces buttons (most rated / best sellers / most viewed / most searched) rank perfumes from two real
-- sources and nothing else:
--   1. the CUSTOMERS database (registered_customer_best_sellers, guest_product_analytics, customer_product_events and the
--      approved rows of reviews) - always first;
--   2. the STORES' catalogs: one row per store offer in four store tables that stay empty until a store's catalog is linked
--      and reports the figure (the platform then asks the store for whatever is missing). Nobody types these numbers in:
--      there is no insert/update/delete policy for any client role, only the server-side catalog sync (service_role) writes.
--
-- Every ranked perfume must be one the platform offers right now: the ranking is bound to
-- private.fn_catalog_public_platform_offers() (the canonical "cheapest eligible offer per size" contract behind
-- public.catalog_platform_offers), so a perfume that is out of stock, from an inactive store, unsynced or unpublished never
-- appears and no perfume can show a price other than the canonical cheapest one.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Four per-store tables. Rows of different stores never mix: every row belongs to one store (store_id) and one offer
--    (store_product_id); store_id and product_size_id are copied from that offer by a trigger, so they cannot disagree.
-- ---------------------------------------------------------------------------------------------------------------------
create table public.store_catalog_best_sellers (
  store_product_id uuid primary key references public.store_products(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  product_size_id uuid not null references public.product_sizes(id) on delete cascade,
  units_sold integer not null check (units_sold >= 0),
  reported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.store_catalog_most_viewed (
  store_product_id uuid primary key references public.store_products(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  product_size_id uuid not null references public.product_sizes(id) on delete cascade,
  views_count integer not null check (views_count >= 0),
  reported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.store_catalog_most_searched (
  store_product_id uuid primary key references public.store_products(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  product_size_id uuid not null references public.product_sizes(id) on delete cascade,
  searches_count integer not null check (searches_count >= 0),
  reported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.store_catalog_ratings (
  store_product_id uuid primary key references public.store_products(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  product_size_id uuid not null references public.product_sizes(id) on delete cascade,
  average_rating numeric(3,2) not null check (average_rating >= 1 and average_rating <= 5),
  ratings_count integer not null check (ratings_count >= 1),
  reported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index store_catalog_best_sellers_store_idx on public.store_catalog_best_sellers (store_id);
create index store_catalog_best_sellers_size_idx on public.store_catalog_best_sellers (product_size_id);
create index store_catalog_most_viewed_store_idx on public.store_catalog_most_viewed (store_id);
create index store_catalog_most_viewed_size_idx on public.store_catalog_most_viewed (product_size_id);
create index store_catalog_most_searched_store_idx on public.store_catalog_most_searched (store_id);
create index store_catalog_most_searched_size_idx on public.store_catalog_most_searched (product_size_id);
create index store_catalog_ratings_store_idx on public.store_catalog_ratings (store_id);
create index store_catalog_ratings_size_idx on public.store_catalog_ratings (product_size_id);

create or replace function private.store_ranking_sync_keys()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  select sp.store_id, sp.product_size_id into new.store_id, new.product_size_id
    from public.store_products sp where sp.id = new.store_product_id;
  if not found then
    raise exception 'store_product_id % is not a store offer', new.store_product_id using errcode = 'foreign_key_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$function$;
revoke all on function private.store_ranking_sync_keys() from public, anon, authenticated;

create trigger store_catalog_best_sellers_sync_keys before insert or update on public.store_catalog_best_sellers
  for each row execute function private.store_ranking_sync_keys();
create trigger store_catalog_most_viewed_sync_keys before insert or update on public.store_catalog_most_viewed
  for each row execute function private.store_ranking_sync_keys();
create trigger store_catalog_most_searched_sync_keys before insert or update on public.store_catalog_most_searched
  for each row execute function private.store_ranking_sync_keys();
create trigger store_catalog_ratings_sync_keys before insert or update on public.store_catalog_ratings
  for each row execute function private.store_ranking_sync_keys();

-- Row level security: a store's own team and the platform admin can READ; nobody can write through the API.
alter table public.store_catalog_best_sellers enable row level security;
alter table public.store_catalog_most_viewed enable row level security;
alter table public.store_catalog_most_searched enable row level security;
alter table public.store_catalog_ratings enable row level security;

revoke all on table public.store_catalog_best_sellers from public, anon, authenticated;
revoke all on table public.store_catalog_most_viewed from public, anon, authenticated;
revoke all on table public.store_catalog_most_searched from public, anon, authenticated;
revoke all on table public.store_catalog_ratings from public, anon, authenticated;
grant select on table public.store_catalog_best_sellers to authenticated;
grant select on table public.store_catalog_most_viewed to authenticated;
grant select on table public.store_catalog_most_searched to authenticated;
grant select on table public.store_catalog_ratings to authenticated;
grant all on table public.store_catalog_best_sellers to service_role;
grant all on table public.store_catalog_most_viewed to service_role;
grant all on table public.store_catalog_most_searched to service_role;
grant all on table public.store_catalog_ratings to service_role;

create policy store_catalog_best_sellers_read on public.store_catalog_best_sellers for select to authenticated
  using ((select private.is_platform_admin()) or (select private.is_store_member(store_id)));
create policy store_catalog_most_viewed_read on public.store_catalog_most_viewed for select to authenticated
  using ((select private.is_platform_admin()) or (select private.is_store_member(store_id)));
create policy store_catalog_most_searched_read on public.store_catalog_most_searched for select to authenticated
  using ((select private.is_platform_admin()) or (select private.is_store_member(store_id)));
create policy store_catalog_ratings_read on public.store_catalog_ratings for select to authenticated
  using ((select private.is_platform_admin()) or (select private.is_store_member(store_id)));

comment on table public.store_catalog_best_sellers is
  'Units sold per store offer, reported by that store''s linked catalog. Empty until a catalog is linked. Written only by the server-side catalog sync (service_role); the storefront ranking reads it after the customers'' real sales.';
comment on table public.store_catalog_most_viewed is
  'Product-page views per store offer, reported by that store''s linked catalog. Empty until a catalog is linked. Written only by the server-side catalog sync (service_role).';
comment on table public.store_catalog_most_searched is
  'Times a store offer appeared in searches, reported by that store''s linked catalog. Empty until a catalog is linked. Written only by the server-side catalog sync (service_role).';
comment on table public.store_catalog_ratings is
  'Average customer rating (1-5) and number of ratings per store offer, reported by that store''s linked catalog. Empty until a catalog is linked. Written only by the server-side catalog sync (service_role).';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. One ranking per metric, customers first, then store catalogs, only for perfumes the platform offers right now.
--
--    sales    : customers = units sold (registered_customer_best_sellers, all time); stores = sum of store_catalog_best_sellers
--    views    : customers = views, last 365 days; stores = sum of store_catalog_most_viewed
--    searches : customers = appearances in searches, last 365 days; stores = sum of store_catalog_most_searched
--    rating   : customers = average of APPROVED reviews, at least 3 of them; stores = rating-count weighted average of
--               store_catalog_ratings, at least 3 ratings
--    Rows of inactive stores are ignored. Order = customers' figure, then the stores' figure (customers' real numbers always
--    rank above figures that only a store reports); equal figures share a rank. A perfume with no figure in a metric has a
--    NULL rank there and is not part of that button. *_source says which source decided it ('customers' or 'store_catalog').
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.fn_storefront_product_rankings()
returns table(
  product_id uuid,
  sales_rank integer, sales_source text,
  views_rank integer, views_source text,
  searches_rank integer, searches_source text,
  rating_rank integer, rating_source text
)
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

revoke all on function private.fn_storefront_product_rankings() from public;
grant execute on function private.fn_storefront_product_rankings() to anon, authenticated, service_role;

comment on function private.fn_storefront_product_rankings() is
  'Masterpieces ranking per perfume the platform offers right now: sales / views / searches / rating ranks (NULL = not part of that button), customers'' real figures first, store catalog figures second. Returns product ids, ranks and the source of each rank only.';

create or replace view public.storefront_product_rankings with (security_invoker = true) as
 select r.product_id,
        r.sales_rank, r.sales_source,
        r.views_rank, r.views_source,
        r.searches_rank, r.searches_source,
        r.rating_rank, r.rating_source
   from private.fn_storefront_product_rankings() r;

revoke all on public.storefront_product_rankings from public, anon, authenticated;
grant select on public.storefront_product_rankings to anon, authenticated, service_role;

comment on view public.storefront_product_rankings is
  'The four Masterpieces rankings (best sellers, most viewed, most searched, most rated) per perfume offered right now. Ranks and their source only; no counts, no identities.';
