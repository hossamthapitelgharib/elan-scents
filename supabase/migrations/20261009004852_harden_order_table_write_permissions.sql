begin;

-- All writes for these workflow tables are performed by the server APIs/RPCs.
-- Keep customer/store/platform reads through RLS, but deny direct client writes.
drop policy if exists store_order_requests_public_insert on public.store_order_requests;
drop policy if exists store_order_requests_store_update on public.store_order_requests;
drop policy if exists store_order_request_items_public_insert on public.store_order_request_items;
drop policy if exists checkout_sessions_owner_update on public.checkout_sessions;
drop policy if exists store_order_cart_restorations_owner_update on public.store_order_cart_restorations;
drop policy if exists notifications_realtime_update on public.notifications;
drop policy if exists own_update on public.notifications;

revoke insert, update, delete on public.checkout_sessions from anon, authenticated;
revoke insert, update, delete on public.store_order_requests from anon, authenticated;
revoke insert, update, delete on public.store_order_request_items from anon, authenticated;
revoke insert, update, delete on public.store_order_notifications from anon, authenticated;
revoke insert, update, delete on public.store_order_cart_restorations from anon, authenticated;
revoke insert, update, delete on public.notifications from anon, authenticated;

commit;
