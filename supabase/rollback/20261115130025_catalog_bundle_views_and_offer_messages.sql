-- Rollback of 20261115130025_catalog_bundle_views_and_offer_messages: puts the two bundle views back as they were in
-- 20261115074256_catalog_bundles (definer views reading the tables directly), removes the offer-message view and function and
-- drops public.offers.kind.
-- WARNING: dropping offers.kind loses which offers a store declared as a "discount" (every row falls back to being a plain offer
-- message). Once real declarations exist, take a copy of (id, kind) from public.offers first. Nothing else depends on the column.
begin;

drop view if exists public.catalog_offer_messages;
drop function if exists private.fn_catalog_public_offer_messages();

alter table public.offers drop constraint if exists offers_kind_check;
alter table public.offers drop column if exists kind;
-- back to the table-wide INSERT/UPDATE the signed-in role held before (revoking the table privilege also clears its column grants)
revoke insert, update on public.offers from authenticated;
grant insert, update on public.offers to authenticated;

drop view if exists public.public_bundle_items;
drop view if exists public.public_bundles;
drop function if exists private.fn_catalog_public_bundle_items();
drop function if exists private.fn_catalog_public_bundles();

create view public.public_bundles as
select b.id, b.brand_id, br.name as brand_name, b.name, b.slug, b.description, b.has_extra_items
  from public.bundles b
  left join public.brands br on br.id = b.brand_id
 where b.status = 'published'
   and b.is_active
   and exists (select 1 from private.fn_catalog_public_eligible_bundle_offers() o where o.bundle_id = b.id);

create view public.public_bundle_items as
select bi.bundle_id, bi.product_size_id, bi.quantity
  from public.bundle_items bi
  join public.public_bundles pb on pb.id = bi.bundle_id;

grant select on public.public_bundles, public.public_bundle_items to anon, authenticated, service_role;

alter view public.catalog_eligible_bundle_offers reset (security_invoker);
alter view public.catalog_platform_bundle_offers reset (security_invoker);

commit;
