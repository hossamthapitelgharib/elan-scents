-- Rollback of 20261121193245_catalog_waiting_room: removes the waiting room, the brand aliases and the one entry point
-- public.catalog_receive_items.
-- WARNING: this loses data the waiting room holds.
--   * every perfume still WAITING for a brand card (public.catalog_waiting_items) is dropped with the table, and so are the brand aliases
--     (public.catalog_brand_aliases); take a copy of both first if they matter;
--   * perfumes and offers already PLACED through the entry point are ordinary rows of public.products, public.product_sizes and
--     public.store_products and are NOT touched; the trial ones carry data_source = 'trial_catalog' and are removed by the statement
--     in docs/handoff.ar.md.
begin;

drop trigger if exists brands_release_waiting on public.brands;
drop trigger if exists catalog_brand_aliases_release_waiting on public.catalog_brand_aliases;

drop function if exists public.catalog_receive_items(uuid, jsonb, text);
drop function if exists public.catalog_release_waiting(uuid);
drop function if exists private.brands_release_waiting();
drop function if exists private.aliases_release_waiting();
drop function if exists private.catalog_release_waiting(uuid);
drop function if exists private.catalog_place_item(uuid, uuid, text, text, integer, numeric, integer, boolean, text, text);
drop function if exists private.catalog_resolve_brand(text);
drop function if exists private.catalog_item_problem(jsonb);
drop function if exists private.catalog_display_name(text);

drop table if exists public.catalog_waiting_items;
drop table if exists public.catalog_brand_aliases;

commit;
