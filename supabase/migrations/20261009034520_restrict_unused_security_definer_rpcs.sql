begin;

-- These RPCs are not called by the current storefront or dashboard code.
-- Keep them available to server_role only until a dedicated server API is introduced.
revoke execute on function public.replace_customer_cart(jsonb) from public, anon, authenticated;
revoke execute on function public.admin_get_brands() from public, anon, authenticated;
revoke execute on function public.admin_get_stores() from public, anon, authenticated;
revoke execute on function public.receive_store_order_notification(jsonb) from public, anon, authenticated;
grant execute on function public.replace_customer_cart(jsonb) to service_role;
grant execute on function public.admin_get_brands() to service_role;
grant execute on function public.admin_get_stores() to service_role;
grant execute on function public.receive_store_order_notification(jsonb) to service_role;

commit;
