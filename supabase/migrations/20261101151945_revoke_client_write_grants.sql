-- Client roles (anon, authenticated) lose direct write access to every table the browser never writes.
--
-- Why: the public API key can reach PostgREST with the visitor's or customer's own JWT. Until now `authenticated` held
-- INSERT/UPDATE/DELETE on 30 tables, so row-level security was the ONLY thing between a signed-in customer and the money
-- (commissions, orders, commission_rate), the roles (profiles.role, store_accounts) and the shared catalog. One mistaken or
-- missing policy would have been an open door. An attack test (tests/rls-attack-surface.test.sql) found no hole today;
-- this migration makes sure one future mistake cannot become one.
--
-- Who writes these tables: only the server (service_role through api/*.js and backend/*.js) and SECURITY DEFINER
-- functions (handle_new_user, platform_link_store_account, refresh_product_rating, ...). Neither is affected by this.
-- The browser writes exactly: cart_items (own rows), the checked RPCs, and (customer-owned rows) favorites, reviews,
-- contact_messages and analytics_events; stores write their own store_products and offers; the owner's editor session
-- inserts into media_library; and a customer edits his own name, phone and avatar on profiles. Those keep their grants.

-- 1. Views are read-only for clients (they are security_invoker views, so RLS held, but they never need a write).
revoke insert, update, delete, truncate on table
  public.cheapest_offers, public.public_brands, public.public_products, public.public_stores
from anon, authenticated;

-- 2. Tables only the server writes.
revoke insert, update, delete, truncate on table
  public.aromatic_notes, public.brands, public.categories, public.commissions,
  public.editor_archive, public.editor_saved_elements, public.editor_section_items, public.editor_sections,
  public.marketing_phrases, public.occasions, public.order_items, public.orders,
  public.product_categories, public.product_images, public.product_notes, public.product_occasions, public.product_sizes,
  public.product_stats, public.products, public.site_settings, public.store_accounts, public.stores, public.sync_logs
from anon, authenticated;

-- 3. The editor inserts uploads with the owner's own session; nothing updates or deletes with it.
revoke update, delete, truncate on table public.media_library from anon, authenticated;

-- 4. A customer may edit only his own name, phone and avatar. The role column can no longer be written by a client at all
--    (the protect_profile_role trigger stays as the second lock); rows are created by handle_new_user and removed with the account.
revoke insert, update, delete, truncate on table public.profiles from anon, authenticated;
grant update (full_name, phone, avatar_url) on table public.profiles to authenticated;

-- 5. PostgreSQL 17 grants MAINTAIN (VACUUM, REINDEX, LOCK TABLE ...) to both client roles by default; nothing needs it.
do $$
declare r record;
begin
  if current_setting('server_version_num')::int >= 170000 then
    for r in
      select c.oid::regclass as t
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'm')
    loop
      execute format('revoke maintain on table %s from anon, authenticated', r.t);
    end loop;
    alter default privileges for role postgres in schema public revoke maintain on tables from anon, authenticated;
  end if;
end $$;

-- 6. Secure by default: a table created from now on gives clients read access only (row-level security still decides which
--    rows). A table that clients must write needs an explicit GRANT in its own migration, next to its policies.
alter default privileges for role postgres in schema public revoke insert, update, delete, truncate on tables from anon, authenticated;

