-- End-to-end Supabase order lifecycle test.
-- Uses a real active store/product, then rolls back everything.
begin;
create temporary table lifecycle_context on commit drop as
select s.id as store_id, sp.id as store_product_id, ps.id as product_size_id,
       p.name as product_name, sp.price, sp.currency
from public.stores s
join public.store_products sp on sp.store_id=s.id
join public.product_sizes ps on ps.id=sp.product_size_id
join public.products p on p.id=ps.product_id
where s.status='active' and p.is_active=true and sp.is_available=true
limit 1;

insert into public.checkout_sessions
  (tracking_number,customer_name,customer_phone,customer_address,status,currency,subtotal,total_amount)
values
  ('TEST-LIFECYCLE-20261009','Lifecycle Customer','01000000000','Lifecycle Address','open','EGP',960,960);

insert into public.store_order_requests
  (tracking_number,checkout_tracking_number,checkout_session_id,store_id,
   customer_name,customer_phone,customer_address,status,subtotal,total_amount,
   currency,initial_payload)
select 'TEST-LIFECYCLE-STORE-20261009','TEST-LIFECYCLE-20261009',cs.id,c.store_id,
       'Lifecycle Customer','01000000000','Lifecycle Address','awaiting_store_confirmation',c.price,c.price,
       c.currency,jsonb_build_object('trackingNumber','TEST-LIFECYCLE-20261009')
from lifecycle_context c cross join public.checkout_sessions cs
where cs.tracking_number='TEST-LIFECYCLE-20261009';

insert into public.store_order_request_items
  (request_id,store_product_id,product_size_id,product_name,quantity,unit_price,line_total,currency)
select r.id,c.store_product_id,c.product_size_id,c.product_name,1,c.price,c.price,c.currency
from public.store_order_requests r cross join lifecycle_context c
where r.tracking_number='TEST-LIFECYCLE-STORE-20261009';

insert into public.store_order_notifications
  (request_id,tracking_number,event_type,store_status,match_status,mismatch_fields,payload)
select r.id,r.tracking_number,'initial_submitted','awaiting_store_confirmation','matched','[]'::jsonb,
       jsonb_build_object('source','customer','trackingNumber',r.tracking_number)
from public.store_order_requests r where r.tracking_number='TEST-LIFECYCLE-STORE-20261009';

update public.store_order_requests set status='store_confirmed',updated_at=now() where tracking_number='TEST-LIFECYCLE-STORE-20261009';
update public.store_order_requests set status='processing',updated_at=now() where tracking_number='TEST-LIFECYCLE-STORE-20261009';
update public.store_order_requests set status='shipped',updated_at=now() where tracking_number='TEST-LIFECYCLE-STORE-20261009';

select public.receive_store_order_notification(jsonb_build_object(
  'trackingNumber','TEST-LIFECYCLE-STORE-20261009','status','completed',
  'subtotal',960,'items',jsonb_build_array(jsonb_build_object(
    'productSizeId',(select product_size_id::text from lifecycle_context),
    'quantity',1,'unitPrice',960,'total',960,'currency','EGP'))
)) as store_completion_result;
update public.checkout_sessions set status='completed',updated_at=now() where tracking_number='TEST-LIFECYCLE-20261009';

select jsonb_build_object(
  'session_status',(select status from public.checkout_sessions where tracking_number='TEST-LIFECYCLE-20261009'),
  'request_status',(select status from public.store_order_requests where tracking_number='TEST-LIFECYCLE-STORE-20261009'),
  'reconciliation_status',(select reconciliation_status from public.store_order_requests where tracking_number='TEST-LIFECYCLE-STORE-20261009'),
  'notifications',(select count(*) from public.store_order_notifications where tracking_number='TEST-LIFECYCLE-STORE-20261009'),
  'reconciliation_checks',(select count(*) from public.order_reconciliation_checks where tracking_number='TEST-LIFECYCLE-STORE-20261009'),
  'operation_events',(select count(*) from public.order_operation_events where request_id=(select id from public.store_order_requests where tracking_number='TEST-LIFECYCLE-STORE-20261009'))
) as lifecycle_verification;
rollback;
