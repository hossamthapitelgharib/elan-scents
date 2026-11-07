begin;

revoke all on function public.replace_customer_cart_server(jsonb, uuid) from public, anon, authenticated;
revoke all on function public.place_store_order_server(jsonb, uuid) from public, anon, authenticated;
revoke all on function public.request_store_order_cancellation_server(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.confirm_store_order_purchase_server(uuid, uuid) from public, anon, authenticated;

grant execute on function public.replace_customer_cart_server(jsonb, uuid) to service_role;
grant execute on function public.place_store_order_server(jsonb, uuid) to service_role;
grant execute on function public.request_store_order_cancellation_server(uuid, text, uuid) to service_role;
grant execute on function public.confirm_store_order_purchase_server(uuid, uuid) to service_role;

commit;
