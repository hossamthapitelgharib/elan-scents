-- Webhook idempotency regression test.
-- Uses a real active store/product and rolls back all rows.
begin;
create temporary table idem_context on commit drop as
select s.id as store_id,sp.id as store_product_id,ps.id as product_size_id,p.name as product_name,sp.price,sp.currency
from public.stores s join public.store_products sp on sp.store_id=s.id join public.product_sizes ps on ps.id=sp.product_size_id join public.products p on p.id=ps.product_id
where s.status='active' and p.is_active=true and sp.is_available=true limit 1;
insert into public.checkout_sessions (tracking_number,customer_name,customer_phone,customer_address,status,currency,subtotal,total_amount)
values ('TEST-IDEMPOTENCY-20261010','Idempotency Customer','01000000000','Idempotency Address','open','EGP',960,960);
insert into public.store_order_requests (tracking_number,checkout_tracking_number,checkout_session_id,store_id,customer_name,customer_phone,customer_address,status,subtotal,total_amount,currency,initial_payload)
select 'TEST-IDEMPOTENCY-STORE-20261010','TEST-IDEMPOTENCY-20261010',cs.id,c.store_id,'Idempotency Customer','01000000000','Idempotency Address','awaiting_store_confirmation',c.price,c.price,c.currency,'{}'::jsonb from idem_context c cross join public.checkout_sessions cs where cs.tracking_number='TEST-IDEMPOTENCY-20261010';
insert into public.store_order_request_items (request_id,store_product_id,product_size_id,product_name,quantity,unit_price,line_total,currency)
select r.id,c.store_product_id,c.product_size_id,c.product_name,1,c.price,c.price,c.currency from public.store_order_requests r cross join idem_context c where r.tracking_number='TEST-IDEMPOTENCY-STORE-20261010';
select public.receive_store_order_notification(jsonb_build_object('trackingNumber','TEST-IDEMPOTENCY-STORE-20261010','status','completed','subtotal',960,'idempotencyKey','idem-event-20261010','items',jsonb_build_array(jsonb_build_object('productSizeId',(select product_size_id::text from idem_context),'quantity',1,'unitPrice',960,'total',960,'currency','EGP'))));
select public.receive_store_order_notification(jsonb_build_object('trackingNumber','TEST-IDEMPOTENCY-STORE-20261010','status','completed','subtotal',960,'idempotencyKey','idem-event-20261010','items',jsonb_build_array(jsonb_build_object('productSizeId',(select product_size_id::text from idem_context),'quantity',1,'unitPrice',960,'total',960,'currency','EGP'))));
select jsonb_build_object('request_status',(select status from public.store_order_requests where tracking_number='TEST-IDEMPOTENCY-STORE-20261010'),'notifications',(select count(*) from public.store_order_notifications where tracking_number='TEST-IDEMPOTENCY-STORE-20261010'),'duplicate_key_count',(select count(*) from public.store_order_notifications where idempotency_key='idem-event-20261010')) as verification;
rollback;
