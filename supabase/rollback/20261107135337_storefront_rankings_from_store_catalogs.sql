-- Rollback of storefront_rankings_from_store_catalogs: the ranking view and function and the four per-store tables are
-- dropped. The Masterpieces buttons then have no ranking source (deploy the previous storefront first: the current one
-- tolerates a missing ranking view, it just shows empty rankings).
-- The tables are empty until a store's catalog is linked; once they hold what stores reported, this rollback REFUSES to
-- run so nothing a store reported is thrown away by accident: export or archive the rows, then drop them yourself.
begin;

do $guard$
declare
  v_rows bigint := 0;
begin
  if to_regclass('public.store_catalog_best_sellers') is not null then
    select v_rows + count(*) into v_rows from public.store_catalog_best_sellers;
    select v_rows + count(*) into v_rows from public.store_catalog_most_viewed;
    select v_rows + count(*) into v_rows from public.store_catalog_most_searched;
    select v_rows + count(*) into v_rows from public.store_catalog_ratings;
  end if;
  if v_rows > 0 then
    raise exception 'the store catalog ranking tables hold % rows reported by stores; export them before rolling back', v_rows;
  end if;
end;
$guard$;

drop view if exists public.storefront_product_rankings;
drop function if exists private.fn_storefront_product_rankings();
drop table if exists public.store_catalog_best_sellers;
drop table if exists public.store_catalog_most_viewed;
drop table if exists public.store_catalog_most_searched;
drop table if exists public.store_catalog_ratings;
drop function if exists private.store_ranking_sync_keys();

commit;
