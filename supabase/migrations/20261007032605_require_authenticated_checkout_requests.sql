revoke execute on function public.create_store_order_request(jsonb) from anon;
grant execute on function public.create_store_order_request(jsonb) to authenticated;
revoke execute on function public.create_checkout_session(jsonb) from anon;
grant execute on function public.create_checkout_session(jsonb) to authenticated;