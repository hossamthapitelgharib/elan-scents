-- Roll back the server-side cart revision protocol. This drops only the revision
-- metadata and its RPC/trigger; existing cart_items are left untouched. Deploy the
-- matching API/browser rollback before running this file.
drop trigger if exists customer_cart_revision_changed on public.cart_items;
drop function if exists private.bump_customer_cart_revision();
drop function if exists public.read_customer_cart_server(uuid);
drop function if exists public.replace_customer_cart_server_cas(jsonb, bigint, uuid);
drop table if exists public.customer_cart_revisions;
