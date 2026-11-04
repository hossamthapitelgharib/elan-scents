begin;

drop function if exists public.replace_customer_cart_server(jsonb, uuid);
drop function if exists public.place_store_order_server(jsonb, uuid);
drop function if exists public.request_store_order_cancellation_server(uuid, text, uuid);
drop function if exists public.confirm_store_order_purchase_server(uuid, uuid);

revoke execute on function public.replace_customer_cart(jsonb) from service_role;
revoke execute on function public.place_store_order(jsonb) from service_role;
revoke execute on function public.request_store_order_cancellation(uuid, text) from service_role;
revoke execute on function public.confirm_store_order_purchase(uuid) from service_role;

grant execute on function public.replace_customer_cart(jsonb) to authenticated, service_role;
grant execute on function public.place_store_order(jsonb) to authenticated, service_role;
grant execute on function public.request_store_order_cancellation(uuid, text) to authenticated, service_role;
grant execute on function public.confirm_store_order_purchase(uuid) to authenticated;

commit;
