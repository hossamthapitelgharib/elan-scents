-- Rollback of 20261111122056_catalog_announcements_function_grants: takes EXECUTE on the announcements function back from the
-- API roles. WARNING: with these revoked, public.public_products (security_invoker over the offer views) fails for anon and
-- authenticated with "permission denied for function fn_catalog_coming_soon_announcements", i.e. the storefront shows no perfumes.
begin;

revoke execute on function private.fn_catalog_coming_soon_announcements() from anon, authenticated, service_role;

commit;
