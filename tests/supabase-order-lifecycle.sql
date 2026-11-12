-- End-to-end Supabase order lifecycle test.
-- Uses a real active store/product, then rolls back everything.
-- Phase 2: the store approves, the customer chooses cash on delivery, the platform writes its first notice, and only then does the
-- merchant's own notice (with its order and invoice numbers) match it.
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

create temporary table lifecycle_user on commit drop as select gen_random_uuid() as id;
insert into auth.users (id, aud, role, email, raw_user_meta_data)
select id, 'authenticated', 'authenticated', 'lifecycle-' || replace(id::text, '-', '') || '@example.invalid', '{"full_name":"Lifecycle Customer"}'::jsonb
from lifecycle_user;

insert into public.checkout_sessions
  (tracking_number,customer_name,customer_phone,customer_address,status,currency,subtotal,total_amount)
select 'TEST-LIFECYCLE-20261009','Lifecycle Customer','01000000000','Lifecycle Address','open','EGP',c.price,c.price
from lifecycle_context c;

insert into public.store_order_requests
  (tracking_number,checkout_tracking_number,checkout_session_id,store_id,user_id,
   customer_name,customer_phone,customer_address,status,subtotal,total_amount,
   currency,initial_payload)
select 'TEST-LIFECYCLE-STORE-20261009','TEST-LIFECYCLE-20261009',cs.id,c.store_id,u.id,
       'Lifecycle Customer','01000000000','Lifecycle Address','awaiting_store_confirmation',c.price,c.price,
       c.currency,jsonb_build_object('trackingNumber','TEST-LIFECYCLE-20261009')
from lifecycle_context c cross join lifecycle_user u cross join public.checkout_sessions cs
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

-- The store must offer a payment method before it approves; the approval freezes the payable amount.
insert into public.store_payment_methods (store_id, kind, mode, provider, label_ar)
select store_id, 'cod', 'none', 'merchant', 'الدفع عند الاستلام' from lifecycle_context
on conflict do nothing;
update public.store_order_requests set status='store_confirmed',updated_at=now() where tracking_number='TEST-LIFECYCLE-STORE-20261009';

-- The customer chooses cash on delivery: payment is recorded and the platform's first notice is written.
select public.select_order_payment_server(
  r.id, u.id,
  (select (o->>'id')::uuid from jsonb_array_elements(r.payment_options) o where o->>'kind'='cod' limit 1),
  'lifecycle-pay-key-20261009') as payment_choice_result
from public.store_order_requests r cross join lifecycle_user u
where r.tracking_number='TEST-LIFECYCLE-STORE-20261009';

update public.store_order_requests set status='processing',updated_at=now() where tracking_number='TEST-LIFECYCLE-STORE-20261009';
update public.store_order_requests set status='shipped',updated_at=now() where tracking_number='TEST-LIFECYCLE-STORE-20261009';

select public.receive_store_order_notification(jsonb_build_object(
  'trackingNumber','TEST-LIFECYCLE-STORE-20261009','status','completed',
  'merchantOrderNumber','MERCHANT-LIFECYCLE-20261009','merchantInvoiceNumber','INVOICE-LIFECYCLE-20261009',
  'subtotal',c.price,'shipping',0,'total',c.price,'currency','EGP',
  'customer',jsonb_build_object('id',u.id,'name','Lifecycle Customer','phone','01000000000','address','Lifecycle Address'),
  'items',jsonb_build_array(jsonb_build_object(
    'productSizeId',c.product_size_id::text,
    'quantity',1,'unitPrice',c.price,'total',c.price,'currency','EGP',
    'platformOrderNumber',(select i.platform_order_number from public.store_order_request_items i
                           join public.store_order_requests r on r.id=i.request_id
                           where r.tracking_number='TEST-LIFECYCLE-STORE-20261009' limit 1))),
  'shipment',jsonb_build_object('status','in_transit','carrier','Lifecycle carrier','trackingCode','LIFECYCLE-TRK-1')
)) as store_completion_result
from lifecycle_context c cross join lifecycle_user u;
update public.checkout_sessions set status='completed',updated_at=now() where tracking_number='TEST-LIFECYCLE-20261009';

select jsonb_build_object(
  'session_status',(select status from public.checkout_sessions where tracking_number='TEST-LIFECYCLE-20261009'),
  'request_status',(select status from public.store_order_requests where tracking_number='TEST-LIFECYCLE-STORE-20261009'),
  'reconciliation_status',(select reconciliation_status from public.store_order_requests where tracking_number='TEST-LIFECYCLE-STORE-20261009'),
  'notifications',(select count(*) from public.store_order_notifications where tracking_number='TEST-LIFECYCLE-STORE-20261009'),
  'reconciliation_checks',(select count(*) from public.order_reconciliation_checks where tracking_number='TEST-LIFECYCLE-STORE-20261009'),
  'operation_events',(select count(*) from public.order_operation_events where request_id=(select id from public.store_order_requests where tracking_number='TEST-LIFECYCLE-STORE-20261009'))
) as lifecycle_verification;

do $check$
declare
  v public.store_order_requests;
begin
  select * into v from public.store_order_requests where tracking_number='TEST-LIFECYCLE-STORE-20261009';
  assert v.payment_status = 'cod_selected' and v.payment_method = 'cod', 'cash on delivery was recorded by the platform';
  assert exists (select 1 from public.platform_order_notices where request_id = v.id), 'the platform wrote its first notice';
  assert v.reconciliation_status = 'matched', 'the merchant notice matched the platform notice: ' || coalesce(v.mismatch_fields::text, '');
  assert v.merchant_order_number = 'MERCHANT-LIFECYCLE-20261009' and v.merchant_invoice_number = 'INVOICE-LIFECYCLE-20261009',
    'the merchant order and invoice numbers are recorded only after the match';
  assert v.status = 'shipped', 'a matched report keeps the shipped status';
  assert (select count(*) from public.store_shipments where request_id = v.id) = 1, 'the shipment from the matched notice is recorded once';
  assert (select count(*) from public.store_shipment_events where request_id = v.id) >= 1, 'the shipment event is logged';
end;
$check$;
rollback;
