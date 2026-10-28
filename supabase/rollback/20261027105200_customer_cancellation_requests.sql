-- Rolls back migrations/20261027105200_customer_cancellation_requests.sql.
-- Removes the cancellation-request function and table. Requests already stored are dropped with the table (they only
-- recorded that a customer asked; the orders themselves were never changed by them). Notifications already sent
-- (type customer_cancel_requested) stay in public.notifications as history.
begin;

drop function if exists public.request_store_order_cancellation(uuid, text);
drop table if exists public.store_order_cancellation_requests;

commit;
