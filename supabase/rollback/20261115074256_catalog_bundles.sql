-- Rollback of 20261115074256_catalog_bundles: removes the bundles feature (3 tables, 4 public views, the helper functions and triggers).
-- WARNING: it drops the three bundle tables WITH every row in them. Once real store bundles have been received, take a backup of
-- public.bundles, public.bundle_items and public.store_bundles first. Nothing else depends on them (no cart, order or payment table
-- references a bundle), so on a database where no bundle has been stored yet this rollback loses nothing.
begin;

drop view if exists public.public_bundle_items;
drop view if exists public.public_bundles;
drop view if exists public.catalog_platform_bundle_offers;
drop view if exists public.catalog_eligible_bundle_offers;

drop function if exists private.fn_catalog_public_platform_bundle_offers();
drop function if exists private.fn_catalog_public_eligible_bundle_offers();
drop function if exists private.fn_catalog_eligible_bundle_offers();

drop table if exists public.store_bundles;
drop table if exists public.bundle_items;
drop table if exists public.bundles;

drop function if exists private.bundle_items_after_write_touch_bundle();
drop function if exists private.bundles_before_write_compute_key();
drop function if exists private.bundle_compute_key(uuid, boolean);

commit;
