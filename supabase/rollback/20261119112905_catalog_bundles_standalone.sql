-- Rollback of 20261119112905_catalog_bundles_standalone: puts the bundles back as 20261115074256_catalog_bundles and
-- 20261115130025_catalog_bundle_views_and_offer_messages left them (pieces tied to catalog sizes, the platform description column,
-- a package hidden with an unpublished perfume).
-- WARNING: this loses data the new model holds.
--   * the stores' own bundle title and description (store_bundles.title / .description) are dropped;
--   * a piece that names a perfume size the catalog does not hold (an exclusive size, a perfume the platform does not list) cannot be
--     tied to a catalog size and is DELETED, so its bundle loses that piece; take a copy of public.bundle_items first.
begin;

drop view if exists public.catalog_platform_bundle_offers;
drop view if exists public.catalog_eligible_bundle_offers;
drop view if exists public.public_bundle_items;
drop view if exists public.public_bundles;
drop function if exists private.fn_catalog_public_platform_bundle_offers();
drop function if exists private.fn_catalog_public_eligible_bundle_offers();
drop function if exists private.fn_catalog_public_bundle_items();
drop function if exists private.fn_catalog_public_bundles();
drop function if exists private.fn_catalog_eligible_bundle_offers();

-- the platform description column and the stores' own words
alter table public.bundles add column description text;
alter table public.store_bundles drop constraint if exists store_bundles_title_check;
alter table public.store_bundles drop constraint if exists store_bundles_description_check;
alter table public.store_bundles drop column if exists title;
alter table public.store_bundles drop column if exists description;

-- pieces tied to catalog sizes again
alter table public.bundle_items add column product_size_id uuid;
update public.bundle_items bi
   set product_size_id = ps.id
  from public.product_sizes ps
  join public.products p on p.id = ps.product_id
  left join public.brands br on br.id = p.brand_id
 where ps.size_ml = bi.size_ml
   and private.bundle_norm(p.name) = private.bundle_norm(bi.item_name)
   and private.bundle_norm(br.name) = private.bundle_norm(bi.item_brand);
delete from public.bundle_items where product_size_id is null;
drop index if exists public.bundle_items_piece_uq;
alter table public.bundle_items drop constraint if exists bundle_items_name_check;
alter table public.bundle_items drop constraint if exists bundle_items_brand_check;
alter table public.bundle_items drop constraint if exists bundle_items_size_check;
alter table public.bundle_items drop constraint if exists bundle_items_pkey;
alter table public.bundle_items drop column id;
alter table public.bundle_items drop column item_brand;
alter table public.bundle_items drop column item_name;
alter table public.bundle_items drop column size_ml;
alter table public.bundle_items alter column product_size_id set not null;
alter table public.bundle_items add constraint bundle_items_pkey primary key (bundle_id, product_size_id);
alter table public.bundle_items add constraint bundle_items_product_size_id_fkey
  foreign key (product_size_id) references public.product_sizes(id) on delete restrict;
create index bundle_items_size_idx on public.bundle_items (product_size_id);

-- the composition key from catalog sizes again
create or replace function private.bundle_compute_key(p_bundle_id uuid, p_has_extra_items boolean)
returns text
language sql
stable
security definer
set search_path to pg_catalog, public, private, pg_temp
as $function$
  select case
           when p_has_extra_items then null
           when coalesce((select sum(bi.quantity) from public.bundle_items bi where bi.bundle_id = p_bundle_id), 0) < 2 then null
           else (select string_agg(bi.product_size_id::text || 'x' || bi.quantity::text, ',' order by bi.product_size_id)
                   from public.bundle_items bi where bi.bundle_id = p_bundle_id)
         end;
$function$;
update public.bundles set composition_key = composition_key;

drop function if exists private.bundle_norm(text);

-- eligibility: a package that holds a hidden or unpublished perfume is hidden with it
create function private.fn_catalog_eligible_bundle_offers()
returns table(
  store_bundle_id uuid, bundle_id uuid, store_id uuid, store_name text, price numeric, currency text, stock_quantity integer,
  price_includes_tax boolean, price_includes_shipping boolean, last_synced_at timestamptz, commission_rate numeric, priority_rank integer
)
language sql
stable
security definer
set search_path to pg_catalog, public, private, pg_temp
as $function$
  select sb.id, sb.bundle_id, sb.store_id, s.name, sb.price, sb.currency, sb.stock_quantity,
         sb.price_includes_tax, sb.price_includes_shipping, sb.last_synced_at, s.commission_rate, s.priority_rank
    from public.store_bundles sb
    join public.stores s on s.id = sb.store_id
    join public.bundles b on b.id = sb.bundle_id
   where s.status = 'active'
     and b.status = 'published'
     and b.is_active
     and sb.is_available
     and sb.sync_status = 'synced'
     and sb.stock_quantity > 0
     and sb.price > 0
     and sb.currency = 'EGP'
     and not exists (
       select 1
         from public.bundle_items bi
         join public.product_sizes ps on ps.id = bi.product_size_id
         join public.products p on p.id = ps.product_id
        where bi.bundle_id = b.id
          and not (p.status = 'published' and p.is_active)
     );
$function$;

create function private.fn_catalog_public_eligible_bundle_offers()
returns table(
  store_bundle_id uuid, bundle_id uuid, store_id uuid, store_name text, price numeric, currency text, stock_quantity integer,
  price_includes_tax boolean, price_includes_shipping boolean, last_synced_at timestamptz
)
language sql
stable
security definer
set search_path to pg_catalog, public, private, pg_temp
as $function$
  select o.store_bundle_id, o.bundle_id, o.store_id, o.store_name, o.price, o.currency, o.stock_quantity,
         o.price_includes_tax, o.price_includes_shipping, o.last_synced_at
    from private.fn_catalog_eligible_bundle_offers() as o;
$function$;

create function private.fn_catalog_public_platform_bundle_offers()
returns table(
  store_bundle_id uuid, bundle_id uuid, store_id uuid, store_name text, price numeric, currency text, stock_quantity integer,
  price_includes_tax boolean, price_includes_shipping boolean, last_synced_at timestamptz
)
language sql
stable
security definer
set search_path to pg_catalog, public, private, pg_temp
as $function$
  select distinct on (o.bundle_id)
         o.store_bundle_id, o.bundle_id, o.store_id, o.store_name, o.price, o.currency, o.stock_quantity,
         o.price_includes_tax, o.price_includes_shipping, o.last_synced_at
    from private.fn_catalog_eligible_bundle_offers() as o
   order by o.bundle_id, o.price asc, o.commission_rate desc, o.priority_rank asc, o.store_id asc, o.store_bundle_id asc;
$function$;

create function private.fn_catalog_public_bundles()
returns table(id uuid, brand_id uuid, brand_name text, name text, slug text, description text, has_extra_items boolean)
language sql
stable
security definer
set search_path to pg_catalog, public, private, pg_temp
as $function$
  select b.id, b.brand_id, br.name, b.name, b.slug, b.description, b.has_extra_items
    from public.bundles b
    left join public.brands br on br.id = b.brand_id
   where b.status = 'published'
     and b.is_active
     and exists (select 1 from private.fn_catalog_eligible_bundle_offers() o where o.bundle_id = b.id);
$function$;

create function private.fn_catalog_public_bundle_items()
returns table(
  bundle_id uuid, product_size_id uuid, quantity integer, product_id uuid, product_name text, brand_name text, size_ml integer, size_label text
)
language sql
stable
security definer
set search_path to pg_catalog, public, private, pg_temp
as $function$
  select bi.bundle_id, bi.product_size_id, bi.quantity, p.id, p.name, br.name, ps.size_ml, ps.size_label
    from public.bundle_items bi
    join private.fn_catalog_public_bundles() pb on pb.id = bi.bundle_id
    join public.product_sizes ps on ps.id = bi.product_size_id
    join public.products p on p.id = ps.product_id
    left join public.brands br on br.id = p.brand_id
   order by bi.bundle_id, p.name, ps.size_ml, bi.product_size_id;
$function$;

revoke all on function private.fn_catalog_eligible_bundle_offers() from public, anon, authenticated;
revoke all on function private.fn_catalog_public_eligible_bundle_offers() from public;
revoke all on function private.fn_catalog_public_platform_bundle_offers() from public;
revoke all on function private.fn_catalog_public_bundles() from public;
revoke all on function private.fn_catalog_public_bundle_items() from public;
grant execute on function private.fn_catalog_public_eligible_bundle_offers() to anon, authenticated, service_role;
grant execute on function private.fn_catalog_public_platform_bundle_offers() to anon, authenticated, service_role;
grant execute on function private.fn_catalog_public_bundles() to anon, authenticated, service_role;
grant execute on function private.fn_catalog_public_bundle_items() to anon, authenticated, service_role;

create view public.catalog_eligible_bundle_offers with (security_invoker = true) as
select store_bundle_id, bundle_id, store_id, store_name, price, currency, stock_quantity,
       price_includes_tax, price_includes_shipping, last_synced_at
  from private.fn_catalog_public_eligible_bundle_offers();

create view public.catalog_platform_bundle_offers with (security_invoker = true) as
select store_bundle_id, bundle_id, store_id, store_name, price, currency, stock_quantity,
       price_includes_tax, price_includes_shipping, last_synced_at
  from private.fn_catalog_public_platform_bundle_offers();

create view public.public_bundles with (security_invoker = true) as
select id, brand_id, brand_name, name, slug, description, has_extra_items
  from private.fn_catalog_public_bundles();

create view public.public_bundle_items with (security_invoker = true) as
select bundle_id, product_size_id, quantity, product_id, product_name, brand_name, size_ml, size_label
  from private.fn_catalog_public_bundle_items();

grant select on public.catalog_eligible_bundle_offers, public.catalog_platform_bundle_offers,
  public.public_bundles, public.public_bundle_items to anon, authenticated, service_role;

commit;

