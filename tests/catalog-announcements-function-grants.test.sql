-- Real-database test for supabase/migrations/20261111122056_catalog_announcements_function_grants.sql.
-- Run AFTER the migration, as the project owner, inside one transaction; nothing is written.
--
-- Function EXECUTE is checked as the CALLING role even inside a security_invoker view chain, so anon (every visitor) and
-- authenticated need EXECUTE on private.fn_catalog_coming_soon_announcements() or public.public_products (and with it the whole
-- storefront) fails with "permission denied for function". The test reads the storefront the way a visitor does.
begin;

do $$
declare
  v_n integer;
  v_ok boolean;
begin
  -- 1. the grants themselves
  foreach v_ok in array array[
    has_function_privilege('anon', 'private.fn_catalog_coming_soon_announcements()', 'execute'),
    has_function_privilege('authenticated', 'private.fn_catalog_coming_soon_announcements()', 'execute'),
    has_function_privilege('service_role', 'private.fn_catalog_coming_soon_announcements()', 'execute')
  ] loop
    if not v_ok then raise exception 'a client role cannot execute fn_catalog_coming_soon_announcements'; end if;
  end loop;
  if has_function_privilege('public', 'private.fn_catalog_coming_soon_announcements()', 'execute') then
    raise exception 'PUBLIC must not execute fn_catalog_coming_soon_announcements (only the three API roles)';
  end if;

  -- 2. a visitor reads the storefront
  set local role anon;
  select count(*) into v_n from public.public_products;
  select count(*) into v_n from public.catalog_coming_soon_announcements;
  reset role;

  -- 3. a signed-in customer too
  set local role authenticated;
  select count(*) into v_n from public.public_products;
  select count(*) into v_n from public.catalog_coming_soon_announcements;
  reset role;
end $$;

rollback;
