revoke all on function public.receive_store_order_notification(jsonb) from public;
revoke execute on function public.receive_store_order_notification(jsonb) from anon;
grant execute on function public.receive_store_order_notification(jsonb) to authenticated;