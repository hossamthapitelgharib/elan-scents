begin;
drop policy if exists order_operation_events_platform_read on public.order_operation_events;
drop policy if exists order_operation_events_store_read on public.order_operation_events;
create policy order_operation_events_internal_read on public.order_operation_events for select to authenticated using (private.is_platform_admin() or exists (select 1 from public.store_order_requests r where r.id=order_operation_events.request_id and private.is_store_member(r.store_id)));
drop policy if exists order_reconciliation_checks_platform_read on public.order_reconciliation_checks;
drop policy if exists order_reconciliation_checks_store_read on public.order_reconciliation_checks;
create policy order_reconciliation_checks_internal_read on public.order_reconciliation_checks for select to authenticated using (private.is_platform_admin() or exists (select 1 from public.store_order_requests r where r.id=order_reconciliation_checks.request_id and private.is_store_member(r.store_id)));
commit;
