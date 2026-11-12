-- اختبار تكاملي حي لترحيلات دفتر العمولات والتسويات.
-- ينشئ بيانات اصطناعية ويعدّل شروط متجر داخل معاملة واحدة تنتهي دائمًا بـROLLBACK.
begin;
do $test$
declare
  v_user uuid := gen_random_uuid();
  v_store uuid;
  v_store_product uuid;
  v_product_size uuid;
  v_request uuid := gen_random_uuid();
  v_tracking text := 'ELN-TEST-' || replace(gen_random_uuid()::text, '-', '');
  v_platform_number text;
  v_commission public.commissions;
  v_result jsonb;
  v_notice jsonb;
  v_settlement_id uuid;
  v_delivered_at timestamptz := now() - interval '1 day';
  v_rate numeric;
  v_days integer;
begin
  assert not has_function_privilege('anon', 'public.platform_set_store_commercial_terms(uuid,integer,uuid)', 'execute'), 'anon cannot set merchant terms';
  assert not has_function_privilege('authenticated', 'public.platform_mark_commission_paid(uuid,text,uuid)', 'execute'), 'authenticated cannot settle commissions directly';
  assert not has_function_privilege('authenticated', 'public.platform_verify_store_delivery(uuid,timestamp with time zone,text,uuid)', 'execute'), 'authenticated cannot verify delivery directly';
  assert has_function_privilege('service_role', 'public.platform_verify_store_delivery(uuid,timestamp with time zone,text,uuid)', 'execute'), 'server may perform delivery verification';
  assert not has_function_privilege('authenticated', 'public.platform_request_commission_settlement(uuid,uuid)', 'execute'), 'authenticated cannot request settlement directly';
  assert has_function_privilege('service_role', 'public.platform_mark_commission_settlement_paid(uuid,text,uuid)', 'execute'), 'server may finalize a verified settlement';

  select sp.store_id, sp.id, sp.product_size_id into v_store, v_store_product, v_product_size
  from public.store_products sp order by sp.id limit 1;
  assert v_store is not null and v_store_product is not null and v_product_size is not null, 'an existing catalog row is available for a rolled-back test';
  update public.stores set commission_rate=0, return_window_days=null where id=v_store;

  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (v_user, 'authenticated', 'authenticated', 'commission-test-' || replace(v_user::text, '-', '') || '@example.invalid', '{"full_name":"Synthetic Commission Test"}'::jsonb);

  -- تفعيل الشروط قبل إنشاء الطلب حتى يأخذ الطلب لقطة غير قابلة للتغيير بنسبة 15%.
  perform public.platform_set_store_commercial_terms(v_store,14,null);
  insert into public.store_order_requests
    (id, tracking_number, store_id, user_id, customer_name, customer_phone, customer_email, customer_address,
     status, subtotal, shipping_amount, total_amount, currency, reconciliation_status, created_at, updated_at)
  values
    (v_request, v_tracking, v_store, v_user, 'Synthetic Commission Test', '+201000000000',
     'commission-test@example.invalid', 'Synthetic address for rollback test', 'awaiting_store_confirmation',
     200, 80, 280, 'EGP', 'pending', now() - interval '2 days', now() - interval '2 days');
  select commission_rate into v_rate from public.store_order_requests where id=v_request limit 1;
  assert v_rate=15, 'order stores an immutable 15 percent commission snapshot';

  insert into public.store_order_request_items
    (request_id, store_product_id, product_size_id, product_name, brand_name, size_label, quantity, unit_price, line_total, currency)
  values (v_request, v_store_product, v_product_size, 'Synthetic perfume', 'Synthetic brand', '50 ml', 2, 100, 200, 'EGP');
  select platform_order_number into v_platform_number from public.store_order_request_items where request_id=v_request limit 1;
  assert v_platform_number = v_tracking || '-01', 'platform generates the line-level order number';
  assert not exists (select 1 from public.commissions where store_order_request_item_id in (select id from public.store_order_request_items where request_id=v_request limit 1) limit 1), 'no commission accrues before a matched merchant completion notice';

  -- (phase 2) The store offers cash on delivery and approves, the customer chooses it, and only then may the order ship and the
  -- merchant's own notice match the platform's first notice.
  insert into public.store_payment_methods (store_id, kind, mode, provider, label_ar)
  values (v_store, 'cod', 'none', 'merchant', 'الدفع عند الاستلام') on conflict do nothing;
  update public.store_order_requests set status = 'store_confirmed' where id = v_request;
  perform public.select_order_payment_server(v_request, v_user,
    (select (o->>'id')::uuid from public.store_order_requests r, jsonb_array_elements(r.payment_options) o
      where r.id = v_request and o->>'kind' = 'cod' limit 1), 'commission-pay-key-1');
  assert exists (select 1 from public.platform_order_notices where request_id = v_request), 'the platform first notice exists before the merchant reports';

  insert into public.store_shipments(request_id,store_id,carrier_name,tracking_code,shipping_status)
  values(v_request,v_store,'Synthetic carrier','TEST-SHIP-001','in_transit');

  v_result := public.receive_store_order_notification(jsonb_build_object(
    'trackingNumber',v_tracking,'idempotencyKey','commission-test-' || replace(v_request::text,'-',''),
    'status','completed','merchantOrderNumber','MERCHANT-ORDER-TEST','merchantInvoiceNumber','INVOICE-TEST','subtotal',200,'shipping',80,'total',280,'currency','EGP',
    'customer',jsonb_build_object('id',v_user,'name','Synthetic Commission Test','phone','+201000000000','email','commission-test@example.invalid','address','Synthetic address for rollback test'),
    'items',jsonb_build_array(jsonb_build_object('productSizeId',v_product_size,'quantity',2,'unitPrice',100,'total',200,'currency','EGP',
      'platformOrderNumber',v_platform_number,'merchantOrderReference','MERCHANT-LINE-TEST')),
    'shipment',jsonb_build_object('status','in_transit','carrier','Synthetic carrier','trackingCode','TEST-SHIP-001')));
  assert (v_result->>'matched')::boolean, 'merchant completion notice matches the platform order';
  select * into v_commission from public.commissions where store_order_request_item_id in (select id from public.store_order_request_items where request_id=v_request limit 1) limit 1;
  assert found, 'one commission accrues into the original commissions ledger';
  assert v_commission.order_item_id is null, 'new store line does not require a legacy order_items row';
  assert v_commission.rate=15 and v_commission.amount=30, '15 percent applies to 200 product amount and excludes 80 shipping';
  assert v_commission.status='pending' and v_commission.return_deadline_at is null, 'commission waits for trusted delivery evidence';
  select merchant_order_reference into v_platform_number from public.store_order_request_items where request_id=v_request limit 1;
  assert v_platform_number='MERCHANT-LINE-TEST', 'merchant line reference is saved for later claim';

  update public.store_shipments set shipping_status='delivered', delivered_at=now() where request_id=v_request;
  select * into v_commission from public.commissions where id=v_commission.id limit 1;
  assert v_commission.return_deadline_at is null, 'store-reported delivery alone does not start the return window';

  v_result := public.platform_verify_store_delivery(v_request,v_delivered_at,'carrier portal TEST-SHIP-001',v_user);
  assert v_result->>'shippingStatus'='delivered' and not (v_result->>'alreadyVerified')::boolean, 'platform verification records delivery';
  select * into v_commission from public.commissions where id=v_commission.id limit 1;
  assert v_commission.return_deadline_at=v_delivered_at+interval '14 days', 'return window starts from carrier-verified delivery time';
  v_result := public.platform_verify_store_delivery(v_request,v_delivered_at,'carrier portal TEST-SHIP-001',v_user);
  assert (v_result->>'alreadyVerified')::boolean, 'repeating the same evidence is idempotent';

  insert into public.store_order_item_adjustments(request_id,request_item_id,adjustment_type,status,quantity,amount,currency,reason)
  select v_request,id,'return','completed',1,0,'EGP','Synthetic partial return' from public.store_order_request_items where request_id=v_request limit 1;
  select * into v_commission from public.commissions where id=v_commission.id limit 1;
  assert v_commission.amount=15, 'completed partial return reduces the commission for that line only';

  update public.commissions set return_deadline_at=now()-interval '1 second' where id=v_commission.id;
  perform private.release_due_commissions();
  select * into v_commission from public.commissions where id=v_commission.id limit 1;
  assert v_commission.status='payable', 'only an expired verified return window releases the claim';
  select payload into v_notice from public.notifications where request_id=v_request and type='commission_claim' and recipient_role='platform_admin' order by created_at desc limit 1;
  assert v_notice->>'merchantOrderReference'='MERCHANT-LINE-TEST' and (v_notice->>'amount')::numeric=15, 'claim uses merchant reference and net per-line commission';

  v_result := public.platform_request_commission_settlement(v_commission.id,v_user);
  v_settlement_id := (v_result->>'id')::uuid;
  assert v_result->>'status'='payment_requested' and v_result->>'currency'='EGP', 'payable commission creates a settlement request with the request-line currency';
  v_result := public.platform_submit_commission_settlement(v_settlement_id,'BANK-TEST-REFERENCE','TEST-EVIDENCE-001',v_user);
  assert v_result->>'status'='payment_submitted', 'merchant payment details and evidence are recorded';
  v_result := public.platform_verify_commission_settlement(v_settlement_id,v_user);
  assert v_result->>'status'='payment_verified', 'settlement requires independent verification before payment';
  v_result := public.platform_mark_commission_paid(v_commission.id,'BANK-TEST-REFERENCE',v_user);
  assert v_result->>'status'='paid' and v_result->>'paymentReference'='BANK-TEST-REFERENCE', 'verified settlement finalizes commission payment';
  assert exists (select 1 from public.commission_settlements where id=v_settlement_id and status='paid' limit 1), 'settlement and commission payment states agree';
end;
$test$;
rollback;
