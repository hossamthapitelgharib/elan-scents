begin;

-- RPCs called only through the server-side API must not be callable by public clients.
revoke execute on function public.cancel_store_order_request(jsonb) from public, anon, authenticated;
revoke execute on function public.emit_order_notification(public.store_order_requests, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.notifications_on_store_order_change() from public, anon, authenticated;
revoke execute on function public.notifications_on_restoration_change() from public, anon, authenticated;
grant execute on function public.cancel_store_order_request(jsonb) to service_role;
grant execute on function public.emit_order_notification(public.store_order_requests, text, text, text, jsonb) to service_role;
grant execute on function public.notifications_on_store_order_change() to service_role;
grant execute on function public.notifications_on_restoration_change() to service_role;

-- Cover the foreign keys used by dashboard, notification and restoration queries.
create index if not exists notifications_checkout_session_id_idx on public.notifications(checkout_session_id);
create index if not exists store_order_cart_restorations_user_id_idx on public.store_order_cart_restorations(user_id);
create index if not exists store_order_notifications_request_id_idx on public.store_order_notifications(request_id);
create index if not exists store_order_request_items_product_size_id_idx on public.store_order_request_items(product_size_id);
create index if not exists store_order_request_items_store_product_id_idx on public.store_order_request_items(store_product_id);
create index if not exists store_order_requests_user_id_idx on public.store_order_requests(user_id);

-- The underlying catalog tables already have anon-safe public_read RLS policies.
alter view public.public_products set (security_invoker = true);

commit;
