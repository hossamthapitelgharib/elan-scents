begin;

grant execute on function public.replace_customer_cart_server(jsonb, uuid) to authenticated;
grant execute on function public.place_store_order_server(jsonb, uuid) to authenticated;
grant execute on function public.request_store_order_cancellation_server(uuid, text, uuid) to authenticated;
grant execute on function public.confirm_store_order_purchase_server(uuid, uuid) to authenticated;

commit;
