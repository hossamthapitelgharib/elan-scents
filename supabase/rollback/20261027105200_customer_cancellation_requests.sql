-- Rolls back migrations/20261027105200_customer_cancellation_requests.sql.
-- Removes the cancellation-request function and table. Requests already recorded are lost (they are only requests:
-- orders keep their own status, and nothing was ever cancelled by a request alone).
begin;

drop function if exists public.request_store_order_cancellation(uuid, text);
drop table if exists public.store_order_cancellation_requests;

commit;
