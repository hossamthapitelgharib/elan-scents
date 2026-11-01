-- Rolls back migrations/20261101151945_revoke_client_write_grants.sql.
-- Gives the client roles back the write grants they held before (the defaults Supabase gave every table), so row-level security
-- is the only lock again. Run it only if something legitimate turns out to write one of these tables with a customer's token;
-- the better fix is then to GRANT just that table and add its name to the list in section 0 of tests/rls-attack-surface.test.sql.
begin;

grant insert, update, delete on table
  public.cheapest_offers, public.public_brands, public.public_products, public.public_stores,
  public.aromatic_notes, public.brands, public.categories, public.commissions,
  public.editor_archive, public.editor_saved_elements, public.editor_section_items, public.editor_sections,
  public.marketing_phrases, public.media_library, public.occasions, public.order_items, public.orders,
  public.product_categories, public.product_images, public.product_notes, public.product_occasions, public.product_sizes,
  public.product_stats, public.products, public.site_settings, public.store_accounts, public.stores, public.sync_logs
to authenticated;

grant insert, update, delete on table public.profiles to authenticated;

do $$
declare r record;
begin
  if current_setting('server_version_num')::int >= 170000 then
    for r in
      select c.oid::regclass as t
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'm')
    loop
      execute format('grant maintain on table %s to anon, authenticated', r.t);
    end loop;
    alter default privileges for role postgres in schema public grant maintain on tables to anon, authenticated;
  end if;
end $$;

alter default privileges for role postgres in schema public grant insert, update, delete on tables to authenticated;

commit;
