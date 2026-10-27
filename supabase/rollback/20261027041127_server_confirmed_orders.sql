-- Rolls back migrations/20261027041127_server_confirmed_orders.sql.
-- Removes place_store_order, the tracking-number maker, the retry-key table (only short-lived keys, no order data) and the
-- cron job that cleans it. Orders already created keep their server-made tracking numbers; the two older order
-- functions were never changed, so browsers that still use them keep working.
begin;

select cron.unschedule('order-idempotency-retention-7d')
where exists (select 1 from cron.job where jobname = 'order-idempotency-retention-7d');

drop function if exists public.place_store_order(jsonb);
drop function if exists private.new_tracking_number();
drop table if exists private.store_order_idempotency;

commit;
