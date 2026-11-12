-- Webhook idempotency regression test.
-- Uses a real active store/product and rolls back all rows.
-- Phase 2: the order is approved and paid (cash on delivery) before the merchant's notice can match.
begin;
create temporary table idem_context on commit drop as
select s.id as store_id,sp.id as store_product_id,ps.id as product_size_id,p.name as product_name,sp.price,sp.currency
from public.stores s join public.store_products sp on sp.store_id=s.id join public.product_sizes ps on ps.id=sp.product_size_id join public.products p on p.id=ps.product_id
where s.status='active' and p.is_active=true and sp.is_available=true limit 1;
create temporary table idem_user on commit drop as select gen_random_uuid() as id;
insert into auth.users (id, aud, role, email, raw_user_meta_data)
select id, 'authenticated', 'authenticated', 'idem-' || replace(id::text, '-', '') || '@example.invalid', '{"full_name":"Idempotency Customer"}'::jsonb from idem_user;
insert into public.checkout_sessions (tracking_number,customer_name,customer_phone,customer_address,status,currency,subtotal,total_amount)
select 'TEST-IDEMPOTENCY-20261010','Idempotency Customer','01000000000','Idempotency Address','open','EGP',c.price,c.price from idem_context c;
insert into public.store_order_requests (tracking_number,checkout_tracking_number,checkout_session_id,store_id,user_id,customer_name,customer_phone,customer_address,status,subtotal,total_amount,currency,initial_payload)
select 'TEST-IDEMPOTENCY-STORE-20261010','TEST-IDEMPOTENCY-20261010',cs.id,c.store_id,u.id,'Idempotency Customer','01000000000','Idempotency Address','awaiting_store_confirmation',c.price,c.price,c.currency,'{}'::jsonb
from idem_context c cross join idem_user u cross join public.checkout_sessions cs where cs.tracking_number='TEST-IDEMPOTENCY-20261010';
insert into public.store_order_request_items (request_id,store_product_id,product_size_id,product_name,quantity,unit_price,line_total,currency)
select r.id,c.store_product_id,c.product_size_id,c.product_name,1,c.price,c.price,c.currency from public.store_order_requests r cross join idem_context c where r.tracking_number='TEST-IDEMPOTENCY-STORE-20261010';

insert into public.store_payment_methods (store_id, kind, mode, provider, label_ar)
select store_id, 'cod', 'none', 'merchant', 'الدفع عند الاستلام' from idem_context on conflict do nothing;
update public.store_order_requests set status='store_confirmed',updated_at=now() where tracking_number='TEST-IDEMPOTENCY-STORE-20261010';
select public.select_order_payment_server(
  r.id, u.id,
  (select (o->>'id')::uuid from jsonb_array_elements(r.payment_options) o where o->>'kind'='cod' limit 1),
  'idem-pay-key-20261010') as payment_choice_result
from public.store_order_requests r cross join idem_user u where r.tracking_number='TEST-IDEMPOTENCY-STORE-20261010';

create temporary table idem_notice on commit drop as
select jsonb_build_object(
  'trackingNumber','TEST-IDEMPOTENCY-STORE-20261010','status','completed','idempotencyKey','idem-event-20261010',
  'merchantOrderNumber','MERCHANT-IDEM-20261010','merchantInvoiceNumber','INVOICE-IDEM-20261010',
  'subtotal',c.price,'shipping',0,'total',c.price,'currency','EGP',
  'customer',jsonb_build_object('id',u.id,'name','Idempotency Customer','phone','01000000000','address','Idempotency Address'),
  'items',jsonb_build_array(jsonb_build_object(
    'productSizeId',c.product_size_id::text,'quantity',1,'unitPrice',c.price,'total',c.price,'currency','EGP',
    'platformOrderNumber',(select i.platform_order_number from public.store_order_request_items i join public.store_order_requests r on r.id=i.request_id
                           where r.tracking_number='TEST-IDEMPOTENCY-STORE-20261010' limit 1))),
  'shipment',jsonb_build_object('status','preparing','carrier','Idempotency carrier')
) as payload
from idem_context c cross join idem_user u;

select public.receive_store_order_notification((select payload from idem_notice)) as first_delivery;
select public.receive_store_order_notification((select payload from idem_notice)) as second_delivery;

select jsonb_build_object('request_status',(select status from public.store_order_requests where tracking_number='TEST-IDEMPOTENCY-STORE-20261010'),'notifications',(select count(*) from public.store_order_notifications where tracking_number='TEST-IDEMPOTENCY-STORE-20261010'),'duplicate_key_count',(select count(*) from public.store_order_notifications where idempotency_key='idem-event-20261010')) as verification;

do $check$
declare
  v_first jsonb;
  v_second jsonb;
begin
  -- the second delivery of the same key is answered from the first, never applied twice
  v_second := public.receive_store_order_notification((select payload from idem_notice));
  assert (v_second->>'duplicate')::boolean, 'a repeated idempotency key is reported as a duplicate';
  assert (select count(*) from public.store_order_notifications where idempotency_key='idem-event-20261010') = 1,
    'the repeated key stored a single notification';
  assert (select reconciliation_status from public.store_order_requests where tracking_number='TEST-IDEMPOTENCY-STORE-20261010') = 'matched',
    'the first delivery matched the platform notice';
  assert (select merchant_order_number from public.store_order_requests where tracking_number='TEST-IDEMPOTENCY-STORE-20261010') = 'MERCHANT-IDEM-20261010',
    'the merchant order number was recorded once by the matched notice';
end;
$check$;
rollback;
