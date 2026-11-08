-- Rollback of store_catalog_figures_ingest: the writer goes away; the four store tables and every row in them stay
-- (this migration never created or changed them).
begin;

drop function if exists public.ingest_store_catalog_figures(uuid, jsonb);
drop function if exists private.ingest_figure_int(jsonb, text, integer);

commit;
