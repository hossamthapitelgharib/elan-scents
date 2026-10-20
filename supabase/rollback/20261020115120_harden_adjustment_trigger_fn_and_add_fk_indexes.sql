-- Rolls back migrations/20261020115120_harden_adjustment_trigger_fn_and_add_fk_indexes.sql.
-- Restores the previous policy text and the previous EXECUTE grants, and drops the six indexes.
begin;

drop index if exists public.customer_product_events_session_id_idx;
drop index if exists public.customer_product_events_product_size_id_idx;
drop index if exists public.customer_product_events_store_product_id_idx;
drop index if exists public.customer_searches_session_id_idx;
drop index if exists public.store_order_item_adjustments_created_by_idx;
drop index if exists public.store_order_item_adjustments_item_request_idx;

alter policy store_shipments_owner_read on public.store_shipments
  using (exists (
    select 1 from public.store_order_requests r
    where r.id = store_shipments.request_id and r.user_id = auth.uid()
  ));

-- The previous state exposed the trigger function over RPC; restoring it re-opens that finding on purpose.
grant execute on function public.validate_store_order_item_adjustment() to public, anon, authenticated;

commit;
