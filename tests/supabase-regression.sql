-- Manual Supabase regression scenario.
-- Run only in the Supabase SQL editor or an authenticated database session.
-- The final ROLLBACK is intentional: this test must never leave data behind.

begin;

insert into public.checkout_sessions
  (tracking_number, customer_name, customer_phone, customer_address, status, currency, subtotal, total_amount)
values
  ('TEST-NOTIFY-20261008', 'Regression Customer', '01000000000', 'Regression Address', 'transferred', 'EGP', 960, 960);

insert into public.store_order_requests
  (tracking_number, checkout_tracking_number, checkout_session_id, store_id,
   customer_name, customer_phone, customer_address, status, subtotal, total_amount,
   currency, initial_payload)
select
  'TEST-NOTIFY-REQ-20261008', 'TEST-NOTIFY-20261008', id,
  '67db0c38-4a66-4b71-a988-cede2b9645a6',
  'Regression Customer', '01000000000', 'Regression Address',
  'awaiting_store_confirmation', 960, 960, 'EGP', '{}'::jsonb
from public.checkout_sessions
where tracking_number = 'TEST-NOTIFY-20261008';

insert into public.store_order_request_items
  (request_id, store_product_id, product_size_id, product_name,
   quantity, unit_price, line_total, currency)
select
  r.id,
  'eb122705-dc92-4943-b4f6-380c3ce45d3a',
  '4cc72a96-2790-49e1-be01-b5e34abd9371',
  'Regression Perfume', 1, 960, 960, 'EGP'
from public.store_order_requests r
where r.tracking_number = 'TEST-NOTIFY-REQ-20261008';

select public.cancel_store_order_request(jsonb_build_object(
  'trackingNumber', 'TEST-NOTIFY-REQ-20261008',
  'storeId', '67db0c38-4a66-4b71-a988-cede2b9645a6',
  'reason', 'customer_cancelled',
  'items', jsonb_build_array(jsonb_build_object(
    'productSizeId', '4cc72a96-2790-49e1-be01-b5e34abd9371',
    'quantity', 1, 'unitPrice', 960, 'total', 960
  ))
)) as cancellation_result;

update public.store_order_cart_restorations
set status = 'restored', restored_at = now()
where tracking_number = 'TEST-NOTIFY-REQ-20261008';

-- Expected: request=store_cancelled, restoration=restored,
-- notification types include order_initial, store_cancelled, restore_completed.
select jsonb_build_object(
  'request_status', (select status from public.store_order_requests where tracking_number = 'TEST-NOTIFY-REQ-20261008'),
  'restoration_status', (select status from public.store_order_cart_restorations where tracking_number = 'TEST-NOTIFY-REQ-20261008'),
  'notification_types', (select array_agg(distinct type order by type) from public.notifications where tracking_number = 'TEST-NOTIFY-REQ-20261008')
) as verification;

rollback;
