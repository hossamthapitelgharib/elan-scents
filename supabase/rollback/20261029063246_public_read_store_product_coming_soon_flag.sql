-- Rolls back migrations/20261029063246_public_read_store_product_coming_soon_flag.sql.
-- Takes the client read of the "coming soon" flag away again. The storefront then must not select that column
-- (a select of a column without privilege fails the whole request), so revert the storefront change first.
begin;

revoke select (is_coming_soon) on table public.store_products from anon, authenticated;

commit;
