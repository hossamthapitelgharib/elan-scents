begin;

-- 1) validate_store_order_item_adjustment() is a trigger function. A trigger only needs EXECUTE on its
--    function when the trigger is created (not when it fires), so nobody has to call it over /rest/v1/rpc.
revoke execute on function public.validate_store_order_item_adjustment() from public, anon, authenticated;

-- 2) Cover foreign keys that had no index. The retention jobs delete customer_sessions rows, and every
--    ON DELETE SET NULL has to find the referencing events/searches: without an index that is a full scan per deleted session.
create index if not exists customer_product_events_session_id_idx on public.customer_product_events (session_id);
create index if not exists customer_product_events_product_size_id_idx on public.customer_product_events (product_size_id);
create index if not exists customer_product_events_store_product_id_idx on public.customer_product_events (store_product_id);
create index if not exists customer_searches_session_id_idx on public.customer_searches (session_id);
create index if not exists store_order_item_adjustments_created_by_idx on public.store_order_item_adjustments (created_by);
create index if not exists store_order_item_adjustments_item_request_idx on public.store_order_item_adjustments (request_item_id, request_id);

-- 3) Evaluate auth.uid() once per statement instead of once per row. Same rule, same roles.
alter policy store_shipments_owner_read on public.store_shipments
  using (exists (
    select 1 from public.store_order_requests r
    where r.id = store_shipments.request_id and r.user_id = (select auth.uid())
  ));

commit;
