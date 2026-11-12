-- Real-database test for supabase/migrations/<version>_phase2_payment_merchant_shipping.sql
-- (docs/implementation-phase-2-payment-merchant-shipping.ar.md).
-- Run AFTER the migration (or with the migration text first, in the same transaction), as the project owner. Everything is rolled back.
-- Synthetic users only; the catalog and the stores are read, and the few catalog rows that change (stock, price) change inside the transaction.
-- Order of the story: no payment method -> no approval; merchant approval; the customer chooses; a signed event (never the browser) settles a card payment;
-- the FIRST platform notice and the cart; the merchant's notice matched against it; shipping events; delivery proof; cash on delivery; rejection; failure and retry.
begin;

do $$
declare
  v_u1 constant uuid := 'b0000000-0000-4000-8000-0000000000d1';
  v_u2 constant uuid := 'b0000000-0000-4000-8000-0000000000d2';
  v_store_a uuid;
  v_store_b uuid;
  a1 public.store_products;
  a2 public.store_products;
  b1 public.store_products;
  v_res jsonb;
  v_pay jsonb;
  v_req public.store_order_requests;
  v_id uuid;
  v_trk text;
  v_items jsonb;
  v_it record;
  v_n integer;
  v_m_card uuid;
  v_m_cod uuid;
  v_total numeric;
  v_sub numeric;
  v_ref text;
  v_id2 uuid;
  v_trk2 text;
  v_total2 numeric;
  v_id3 uuid;
  v_trk3 text;
  v_notice jsonb;
begin
  select sp.store_id into v_store_a from public.store_products sp join public.stores s on s.id = sp.store_id
   where s.status = 'active' group by sp.store_id having count(*) >= 2 order by sp.store_id limit 1;
  select sp.store_id into v_store_b from public.store_products sp join public.stores s on s.id = sp.store_id
   where s.status = 'active' and sp.store_id <> v_store_a group by sp.store_id order by sp.store_id limit 1;
  assert v_store_a is not null and v_store_b is not null, 'two active stores with products exist to test with';
  select * into a1 from public.store_products where store_id = v_store_a order by id limit 1;
  select * into a2 from public.store_products where store_id = v_store_a and id <> a1.id order by id limit 1;
  select * into b1 from public.store_products where store_id = v_store_b order by id limit 1;
  update public.store_products set is_available = true, stock_quantity = 50, price = 120.00 where id = a1.id;
  update public.store_products set is_available = true, stock_quantity = 50, price = 80.50 where id = a2.id;
  update public.store_products set is_available = true, stock_quantity = 50, price = 200.00 where id = b1.id;
  select * into a1 from public.store_products where id = a1.id;
  select * into a2 from public.store_products where id = a2.id;
  select * into b1 from public.store_products where id = b1.id;
  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (v_u1, 'authenticated', 'authenticated', 'phase2-1@example.invalid', '{"full_name":"Pay One"}'::jsonb),
         (v_u2, 'authenticated', 'authenticated', 'phase2-2@example.invalid', '{"full_name":"Pay Two"}'::jsonb);
  insert into public.customer_details (user_id, full_name, phone, governorate, city, address, building_no, floor_no, apartment_no, ship_same)
  values (v_u1, 'احمد محمد علي حسن', '01012345678', 'القاهرة', 'القاهرة', 'شارع التحرير', '5', '3', '12', true),
         (v_u2, 'منى سمير فتحي عبد', '01112345678', 'الجيزة', 'الجيزة', 'شارع الهرم', '10', '2', '4', true);

  -- 1. Who may call what: the server only. The browser role reads, never writes, the payment records.
  assert has_function_privilege('service_role', 'public.merchant_review_order(uuid, jsonb)', 'execute'), 'the server records the merchant decision';
  assert has_function_privilege('service_role', 'public.select_order_payment_server(uuid, uuid, uuid, text)', 'execute'), 'the server records the customer choice';
  assert has_function_privilege('service_role', 'public.record_payment_event(uuid, jsonb)', 'execute'), 'the server records signed payment events';
  assert has_function_privilege('service_role', 'public.record_shipment_event(uuid, jsonb)', 'execute'), 'the server records signed shipping events';
  assert not has_function_privilege('authenticated', 'public.merchant_review_order(uuid, jsonb)', 'execute') and not has_function_privilege('anon', 'public.merchant_review_order(uuid, jsonb)', 'execute'), 'no browser role decides an order';
  assert not has_function_privilege('authenticated', 'public.select_order_payment_server(uuid, uuid, uuid, text)', 'execute'), 'no browser role chooses a payment';
  assert not has_function_privilege('authenticated', 'public.record_payment_event(uuid, jsonb)', 'execute') and not has_function_privilege('anon', 'public.record_payment_event(uuid, jsonb)', 'execute'), 'no browser role marks an order paid';
  assert not has_function_privilege('authenticated', 'public.record_shipment_event(uuid, jsonb)', 'execute'), 'no browser role records shipping';
  assert not has_function_privilege('authenticated', 'public.receive_store_order_notification(jsonb)', 'execute'), 'no browser role sends the merchant notice';
  assert not has_function_privilege('authenticated', 'private.finalize_payment(uuid)', 'execute'), 'the notice and cart step is internal';
  assert not has_table_privilege('authenticated', 'public.order_payments', 'insert') and not has_table_privilege('authenticated', 'public.order_payments', 'update')
     and not has_table_privilege('authenticated', 'public.platform_order_notices', 'insert') and not has_table_privilege('authenticated', 'public.store_shipment_events', 'insert')
     and not has_table_privilege('authenticated', 'public.order_payment_events', 'insert') and not has_table_privilege('authenticated', 'public.store_payment_methods', 'insert'),
     'the payment tables are read-only for a browser token';
  assert not has_table_privilege('anon', 'public.order_payments', 'select') and not has_table_privilege('anon', 'public.platform_order_notices', 'select'), 'anon reads none of them';
  assert not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('order_payments', 'order_payment_events', 'platform_order_notices', 'store_shipment_events', 'store_payment_methods') and policyname not like '%_admin_all'), 'no policy opens these tables to a customer or a store';

  -- 2. An order, built by the Phase 1 path (u1: both stores in the cart).
  insert into public.cart_items (user_id, store_product_id, quantity) values (v_u1, a1.id, 2), (v_u1, a2.id, 1), (v_u1, b1.id, 2);
  v_res := public.place_store_order_server(jsonb_build_object('storeId', v_store_a, 'idempotencyKey', 'phase2-key-0001'), v_u1);
  v_id := (v_res->>'id')::uuid; v_trk := v_res->>'trackingNumber';
  select * into v_req from public.store_order_requests where id = v_id;
  v_sub := v_req.subtotal;
  assert v_req.payment_status = 'not_started' and v_req.approved_at is null and v_req.payable_amount is null and v_req.payment_reference is null, 'a new order has no payment and no terms';
  select coalesce(jsonb_agg(jsonb_build_object('productSizeId', i.product_size_id, 'quantity', i.quantity, 'unitPrice', i.unit_price, 'currency', i.currency,
           'total', i.line_total, 'platformOrderNumber', i.platform_order_number) order by i.id), '[]'::jsonb) into v_items
    from public.store_order_request_items i where i.request_id = v_id;
  assert (select count(*) from public.cart_items where user_id = v_u1) = 3, 'the cart is untouched by creating the order';

  -- 3. No payment method, no approval (by either door). Another store cannot touch the order.
  begin
    perform public.merchant_review_order(v_store_a, jsonb_build_object('trackingNumber', v_trk, 'decision', 'approve'));
    raise exception 'FAIL: approved without a payment method';
  exception when raise_exception then
    assert sqlerrm like 'Configure a payment method%', 'approval needs a payment method: ' || sqlerrm;
  end;
  begin
    update public.store_order_requests set status = 'store_confirmed' where id = v_id;
    raise exception 'FAIL: dashboard approval without a payment method';
  exception when raise_exception then
    assert sqlerrm like 'Configure a payment method%', 'the dashboard door is closed too: ' || sqlerrm;
  end;
  begin
    perform public.merchant_review_order(v_store_b, jsonb_build_object('trackingNumber', v_trk, 'decision', 'approve'));
    raise exception 'FAIL: a foreign merchant decided the order';
  exception when raise_exception then
    assert sqlerrm = 'Order not found', 'a merchant cannot touch another store''s order: ' || sqlerrm;
  end;
  begin
    perform public.record_payment_event(v_store_b, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'x1', 'eventType', 'payment.succeeded', 'providerTransactionId', 'TX', 'amount', v_sub));
    raise exception 'FAIL: a foreign merchant paid the order';
  exception when raise_exception then
    assert sqlerrm = 'Order not found', 'nor mark it paid: ' || sqlerrm;
  end;
  begin
    perform public.record_shipment_event(v_store_b, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'x2', 'status', 'preparing'));
    raise exception 'FAIL: a foreign merchant shipped the order';
  exception when raise_exception then
    assert sqlerrm = 'Order not found', 'nor ship it: ' || sqlerrm;
  end;

  -- 4. The store's payment methods: only a safe page, never a card or a secret.
  insert into public.store_payment_methods (store_id, kind, mode, provider, label_ar, redirect_url)
  values (v_store_a, 'card', 'redirect', 'paymob', 'بطاقة بنكية', 'https://pay.example.com/checkout') returning id into v_m_card;
  insert into public.store_payment_methods (store_id, kind, mode, provider, label_ar) values (v_store_a, 'cod', 'none', 'merchant', 'الدفع عند الاستلام') returning id into v_m_cod;
  begin
    insert into public.store_payment_methods (store_id, kind, mode, provider, label_ar, redirect_url) values (v_store_a, 'other', 'redirect', 'plain', 'x', 'http://insecure.example.com');
    raise exception 'FAIL: a plain http payment page was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.store_payment_methods (store_id, kind, mode, provider, label_ar, redirect_url, hosted_config) values (v_store_a, 'other', 'hosted', 'h', 'x', 'https://ok.example.com', '{"card_number":"4111"}');
    raise exception 'FAIL: card data in a method was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.store_payment_methods (store_id, kind, mode, provider, label_ar, redirect_url) values (v_store_a, 'cod', 'none', 'cod2', 'x', 'https://ok.example.com');
    raise exception 'FAIL: cash on delivery with a page was accepted';
  exception when check_violation then null; end;

  -- 5. The merchant decides. A rejection needs a reason. An approval freezes the amount and the methods.
  begin
    perform public.merchant_review_order(v_store_a, jsonb_build_object('trackingNumber', v_trk, 'decision', 'reject'));
    raise exception 'FAIL: rejected without a reason';
  exception when raise_exception then
    assert sqlerrm = 'A rejection needs a reason', 'rejection needs a reason: ' || sqlerrm;
  end;
  begin
    perform public.merchant_review_order(v_store_a, jsonb_build_object('trackingNumber', v_trk, 'decision', 'approve', 'total', 1));
    raise exception 'FAIL: a total below the products was accepted';
  exception when raise_exception then
    assert sqlerrm = 'Total is below the products total', 'the total cannot undercut the products: ' || sqlerrm;
  end;
  v_res := public.merchant_review_order(v_store_a, jsonb_build_object('trackingNumber', v_trk, 'decision', 'approve', 'eventId', 'dec-1', 'shipping', 30));
  v_total := v_sub + 30;
  assert v_res->>'status' = 'store_confirmed' and (v_res->>'payableAmount')::numeric = v_total, 'approved; the payable amount is products plus shipping';
  assert (public.merchant_review_order(v_store_a, jsonb_build_object('trackingNumber', v_trk, 'decision', 'approve', 'eventId', 'dec-1', 'shipping', 99))->>'duplicate')::boolean, 'a replayed decision changes nothing';
  select * into v_req from public.store_order_requests where id = v_id;
  assert v_req.approved_at is not null and v_req.payable_amount = v_total and v_req.total_amount = v_total and jsonb_array_length(v_req.payment_options) = 2, 'the terms are frozen on the order';
  begin
    update public.store_order_requests set payable_amount = 1 where id = v_id;
    raise exception 'FAIL: the approved amount changed';
  exception when raise_exception then
    assert sqlerrm like 'The approved payment terms are fixed%', 'the approved terms are fixed: ' || sqlerrm;
  end;

  -- 6. Nothing marks an order paid but the payment functions; nothing ships before payment.
  begin
    update public.store_order_requests set payment_status = 'paid' where id = v_id;
    raise exception 'FAIL: payment status written directly';
  exception when raise_exception then
    assert sqlerrm like 'Payment fields are written only%', 'a direct write is refused: ' || sqlerrm;
  end;
  begin
    update public.store_order_requests set status = 'shipped' where id = v_id;
    raise exception 'FAIL: shipped without payment';
  exception when raise_exception then
    assert sqlerrm like 'Payment is required%', 'no shipped status without payment: ' || sqlerrm;
  end;
  begin
    perform public.record_shipment_event(v_store_a, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'ship-0', 'status', 'handed_to_carrier', 'carrier', 'Aramex', 'trackingCode', 'W-1'));
    raise exception 'FAIL: shipping event before payment';
  exception when raise_exception then
    assert sqlerrm like 'Payment is required before shipping%', 'a shipping event needs payment: ' || sqlerrm;
  end;
  begin
    insert into public.store_shipments (request_id, store_id, shipping_status) values (v_id, v_store_a, 'in_transit');
    raise exception 'FAIL: shipment row before payment';
  exception when raise_exception then
    assert sqlerrm like 'Payment is required before shipping%', 'nor a shipment row: ' || sqlerrm;
  end;

  -- 7. The customer chooses the card (the browser only receives where to go). Another customer cannot choose for this order.
  begin
    perform public.select_order_payment_server(v_id, v_u2, v_m_card, 'phase2-pay-key-x');
    raise exception 'FAIL: another customer chose the payment';
  exception when raise_exception then
    assert sqlerrm = 'Order not found', 'only the owner chooses: ' || sqlerrm;
  end;
  begin
    perform public.select_order_payment_server(v_id, v_u1, gen_random_uuid(), 'phase2-pay-key-y');
    raise exception 'FAIL: a method the store does not offer';
  exception when raise_exception then
    assert sqlerrm like 'Payment method is not offered%', 'only an offered method: ' || sqlerrm;
  end;
  v_pay := public.select_order_payment_server(v_id, v_u1, v_m_card, 'phase2-pay-key-1');
  assert v_pay->>'status' = 'initiated' and v_pay->>'paymentStatus' = 'awaiting_payment' and v_pay->>'redirectUrl' = 'https://pay.example.com/checkout'
     and (v_pay->>'amount')::numeric = v_total and v_pay->>'currency' = 'EGP', 'a card attempt is open; the page address comes from the approved terms';
  assert public.select_order_payment_server(v_id, v_u1, v_m_card, 'phase2-pay-key-1')->>'paymentId' = v_pay->>'paymentId', 'the same retry key returns the same attempt';
  assert (select count(*) from public.platform_order_notices where request_id = v_id) = 0 and (select count(*) from public.cart_items where user_id = v_u1) = 3, 'choosing is not paying: no notice, the cart stays';

  -- 8. The signed event settles it. A wrong amount or currency settles nothing; the browser's return changes nothing.
  v_res := public.record_payment_event(v_store_a, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'pay-ev-1', 'eventType', 'payment.succeeded', 'providerTransactionId', 'TXN-1', 'amount', v_total - 1, 'provider', 'paymob'));
  assert v_res->>'outcome' = 'amount_mismatch' and (v_res->>'applied')::boolean is false, 'a wrong amount is recorded and not applied';
  v_res := public.record_payment_event(v_store_a, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'pay-ev-2', 'eventType', 'payment.succeeded', 'providerTransactionId', 'TXN-1', 'amount', v_total, 'currency', 'USD', 'provider', 'paymob'));
  assert v_res->>'outcome' = 'currency_mismatch', 'a wrong currency is recorded and not applied';
  assert (select payment_status from public.store_order_requests where id = v_id) = 'awaiting_payment' and (select count(*) from public.platform_order_notices where request_id = v_id) = 0, 'still awaiting; no first notice yet';
  assert (select count(*) from public.order_payment_events where request_id = v_id) = 2, 'both events are in the log';
  v_res := public.record_payment_event(v_store_a, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'pay-ev-3', 'eventType', 'payment.succeeded', 'providerTransactionId', 'TXN-1',
            'paymentReference', 'PAYREF-1', 'amount', v_total, 'currency', 'EGP', 'provider', 'paymob', 'occurredAt', '2026-11-10T10:00:00Z'));
  assert (v_res->>'applied')::boolean and v_res->>'paymentStatus' = 'paid', 'the signed success is applied';
  select * into v_req from public.store_order_requests where id = v_id;
  assert v_req.payment_status = 'paid' and v_req.payment_method = 'card' and v_req.payment_provider = 'paymob' and v_req.payment_reference = 'PAYREF-1' and v_req.paid_at is not null, 'the payment is recorded on the order';
  assert v_req.merchant_order_number is null and v_req.merchant_invoice_number is null, 'no merchant number just because it was paid';

  -- 9. The first platform notice (once, immutable) and the paid lines leaving the cart (once, only this store's).
  assert (select count(*) from public.platform_order_notices where request_id = v_id) = 1, 'one first notice';
  select payload into v_notice from public.platform_order_notices where request_id = v_id;
  assert v_notice->>'trackingNumber' = v_trk and (v_notice->>'total')::numeric = v_total and v_notice->>'currency' = 'EGP' and v_notice#>>'{payment,reference}' = 'PAYREF-1'
     and jsonb_array_length(v_notice->'items') = 2 and v_notice#>>'{store,id}' = v_store_a::text, 'the notice carries the order, the store, the items, the total, the currency and the payment reference';
  assert v_req.cart_cleared_at is not null, 'the order records when the cart was cleared';
  assert (select count(*) from public.cart_items where user_id = v_u1 and store_product_id in (a1.id, a2.id)) = 0, 'the paid store''s lines left the cart';
  assert (select count(*) from public.cart_items where user_id = v_u1 and store_product_id = b1.id and quantity = 2) = 1, 'the other store''s line is untouched';
  begin
    update public.platform_order_notices set payload = '{}'::jsonb where request_id = v_id;
    raise exception 'FAIL: the first notice changed';
  exception when raise_exception then
    assert sqlerrm like 'This record is append-only%', 'the first notice is immutable: ' || sqlerrm;
  end;
  assert (public.record_payment_event(v_store_a, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'pay-ev-3', 'eventType', 'payment.succeeded', 'providerTransactionId', 'TXN-1', 'amount', v_total, 'provider', 'paymob'))->>'duplicate')::boolean, 'a replayed event is ignored';
  v_res := public.record_payment_event(v_store_a, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'pay-ev-4', 'eventType', 'payment.succeeded', 'providerTransactionId', 'TXN-2', 'amount', v_total, 'provider', 'paymob'));
  assert v_res->>'outcome' = 'duplicate_payment', 'a second payment for a paid order is recorded, not applied';
  assert (select count(*) from public.platform_order_notices where request_id = v_id) = 1 and (select count(*) from public.order_payments where request_id = v_id and status = 'paid') = 1, 'still one notice, one paid payment';
  begin
    perform public.select_order_payment_server(v_id, v_u1, v_m_cod, 'phase2-pay-key-2');
    raise exception 'FAIL: chose again after paying';
  exception when raise_exception then
    assert sqlerrm = 'Payment is already settled', 'no second choice after payment: ' || sqlerrm;
  end;

  -- 10. The merchant's own notice, matched against the first one. Differences are recorded and nothing is overwritten.
  v_notice := jsonb_build_object('trackingNumber', v_trk, 'status', 'completed', 'subtotal', v_sub, 'shipping', 30, 'total', v_total, 'currency', 'EGP',
     'merchantOrderNumber', 'M-1001', 'merchantInvoiceNumber', 'INV-2001', 'paymentReference', 'PAYREF-1',
     'customer', jsonb_build_object('id', v_u1, 'name', 'احمد محمد علي حسن', 'phone', '01012345678', 'address', 'القاهرة'),
     'items', v_items, 'shipment', jsonb_build_object('carrier', 'Aramex', 'trackingCode', 'WB-1', 'status', 'handed_to_carrier'));
  v_res := public.receive_store_order_notification(v_notice || jsonb_build_object('paymentReference', 'WRONG-REF', 'idempotencyKey', 'p2-n1'));
  assert (v_res->>'matched')::boolean is false and v_res->'mismatches' ? 'paymentReference', 'a different payment reference does not match';
  select * into v_req from public.store_order_requests where id = v_id;
  assert v_req.merchant_order_number is null and v_req.merchant_invoice_number is null, 'a mismatch records no merchant number';
  assert not exists (select 1 from public.store_shipments where request_id = v_id), 'a mismatch records no shipment';
  v_res := public.receive_store_order_notification((v_notice - 'merchantInvoiceNumber') || jsonb_build_object('idempotencyKey', 'p2-n2'));
  assert (v_res->>'matched')::boolean is false and v_res->'mismatches' ? 'merchantInvoiceNumber', 'the invoice number is required';
  v_res := public.receive_store_order_notification(jsonb_set(v_notice, '{items,0,quantity}', '99'::jsonb) || jsonb_build_object('idempotencyKey', 'p2-n3'));
  assert (v_res->>'matched')::boolean is false and v_res->'mismatches' ? 'items', 'a different quantity does not match';
  v_res := public.receive_store_order_notification(v_notice || jsonb_build_object('total', v_total + 5, 'idempotencyKey', 'p2-n4'));
  assert (v_res->>'matched')::boolean is false and v_res->'mismatches' ? 'total', 'a different total does not match';
  v_res := public.receive_store_order_notification(v_notice || jsonb_build_object('currency', 'USD', 'idempotencyKey', 'p2-n5'));
  assert (v_res->>'matched')::boolean is false and v_res->'mismatches' ? 'currency', 'a different currency does not match';
  v_res := public.receive_store_order_notification(v_notice || jsonb_build_object('idempotencyKey', 'p2-n6'));
  assert (v_res->>'matched')::boolean, 'the matching notice matches: ' || v_res::text;
  select * into v_req from public.store_order_requests where id = v_id;
  assert v_req.merchant_order_number = 'M-1001' and v_req.merchant_invoice_number = 'INV-2001' and v_req.reconciliation_status = 'matched' and v_req.payment_reference = 'PAYREF-1',
     'the match records the merchant order number, the invoice number and keeps the payment reference';
  assert (select shipping_status from public.store_shipments where request_id = v_id) = 'handed_to_carrier'
     and (select tracking_code from public.store_shipments where request_id = v_id) = 'WB-1', 'the match records the waybill';
  v_res := public.receive_store_order_notification((v_notice || jsonb_build_object('merchantOrderNumber', 'M-9999', 'idempotencyKey', 'p2-n7')));
  assert (v_res->>'matched')::boolean is false and v_res->'mismatches' ? 'merchantOrderNumber.conflict', 'another order number is a recorded conflict';
  select * into v_req from public.store_order_requests where id = v_id;
  assert v_req.merchant_order_number = 'M-1001', 'a recorded merchant order number is never overwritten';
  assert (public.receive_store_order_notification(v_notice || jsonb_build_object('idempotencyKey', 'p2-n6'))->>'duplicate')::boolean, 'a replayed notice is ignored';
  begin
    update public.store_order_requests set merchant_order_number = 'FORGED' where id = v_id;
    raise exception 'FAIL: merchant number written outside a match';
  exception when raise_exception then null; end;

  -- 11. Shipping events (signed, logged, in order); delivery with a waybill is the documented receipt.
  v_res := public.record_shipment_event(v_store_a, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'sh-1', 'status', 'in_transit', 'note', 'left the warehouse'));
  assert v_res->>'shippingStatus' = 'in_transit' and (v_res->>'saleProven')::boolean is false, 'in transit; the sale is not proven yet';
  assert (public.record_shipment_event(v_store_a, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'sh-1', 'status', 'in_transit'))->>'duplicate')::boolean, 'a replayed shipping event is ignored';
  begin
    perform public.record_shipment_event(v_store_a, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'sh-2', 'status', 'preparing'));
    raise exception 'FAIL: shipping went backwards';
  exception when raise_exception then
    assert sqlerrm = 'Invalid shipping transition', 'shipping does not go backwards: ' || sqlerrm;
  end;
  begin
    perform public.record_shipment_event(v_store_a, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'sh-3', 'status', 'sideways'));
    raise exception 'FAIL: unknown shipping status';
  exception when raise_exception then
    assert sqlerrm = 'Invalid shipping status', 'only known statuses: ' || sqlerrm;
  end;
  assert (select sale_proven_at from public.store_order_requests where id = v_id) is null, 'no proof before delivery';
  v_res := public.record_shipment_event(v_store_a, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'sh-4', 'status', 'delivered', 'occurredAt', '2026-11-12T12:00:00Z'));
  assert (v_res->>'saleProven')::boolean, 'delivery with a waybill proves the sale';
  select * into v_req from public.store_order_requests where id = v_id;
  assert v_req.sale_proven_at = '2026-11-12T12:00:00Z'::timestamptz, 'the proof time is the carrier''s delivery time';
  assert (select delivery_verification_source from public.store_shipments where request_id = v_id) = 'carrier_api', 'verified by the signed delivered event';
  select count(*) into v_n from public.store_shipment_events where request_id = v_id;
  assert v_n = 3, 'the matched notice, in transit and delivered are in the log: ' || v_n;
  assert (select count(*) from public.store_shipment_events where request_id = v_id and source = 'merchant_notice') = 1 and (select count(*) from public.store_shipment_events where request_id = v_id and source = 'merchant_api') = 2, 'each event says where it came from';
  begin
    update public.store_shipment_events set note = 'x' where request_id = v_id;
    raise exception 'FAIL: the shipping log changed';
  exception when raise_exception then
    assert sqlerrm like 'This record is append-only%', 'the shipping log is append-only: ' || sqlerrm;
  end;

  -- 12. The payment tables are server-only, like every order table: a browser token (a customer's, a store's, a stranger's) reads none of them.
  assert not has_table_privilege('authenticated', 'public.order_payments', 'select') and not has_table_privilege('authenticated', 'public.order_payment_events', 'select')
     and not has_table_privilege('authenticated', 'public.platform_order_notices', 'select') and not has_table_privilege('authenticated', 'public.store_shipment_events', 'select')
     and not has_table_privilege('authenticated', 'public.store_payment_methods', 'select'), 'no browser role has a grant on the payment tables';
  perform set_config('request.jwt.claims', json_build_object('sub', v_u1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_u1::text, true);
  execute 'set local role authenticated';
  begin
    execute 'select count(*) from public.order_payments';
    raise exception 'FAIL: the owner read the payments directly';
  exception when insufficient_privilege then null; end;
  begin
    execute 'select count(*) from public.platform_order_notices';
    raise exception 'FAIL: the owner read the first notice directly';
  exception when insufficient_privilege then null; end;
  begin
    execute 'select count(*) from public.store_shipment_events';
    raise exception 'FAIL: the owner read the shipping log directly';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.jwt.claim.sub', '', true);

  -- 13. Cash on delivery goes through the same cycle: chosen = recorded, first notice, cart, then the same shipping.
  insert into public.cart_items (user_id, store_product_id, quantity) values (v_u2, a1.id, 1), (v_u2, b1.id, 1);
  v_res := public.place_store_order_server(jsonb_build_object('storeId', v_store_a, 'idempotencyKey', 'phase2-key-0002'), v_u2);
  v_id2 := (v_res->>'id')::uuid; v_trk2 := v_res->>'trackingNumber';
  perform public.merchant_review_order(v_store_a, jsonb_build_object('trackingNumber', v_trk2, 'decision', 'approve', 'shipping', 20,
            'paymentMethods', jsonb_build_array(jsonb_build_object('kind', 'cod', 'labelAr', 'الدفع عند الاستلام'))));
  select * into v_req from public.store_order_requests where id = v_id2;
  assert jsonb_array_length(v_req.payment_options) = 1 and v_req.payment_options->0->>'kind' = 'cod', 'the merchant offered only cash on delivery';
  v_total2 := v_req.payable_amount;
  begin
    perform public.select_order_payment_server(v_id2, v_u2, v_m_card, 'phase2-pay-key-3');
    raise exception 'FAIL: a method outside the order''s offer';
  exception when raise_exception then
    assert sqlerrm like 'Payment method is not offered%', 'the order''s own offer is the only one: ' || sqlerrm;
  end;
  v_pay := public.select_order_payment_server(v_id2, v_u2, (v_req.payment_options->0->>'id')::uuid, 'phase2-pay-key-4');
  assert v_pay->>'status' = 'cod_selected', 'cash on delivery is recorded at once';
  select * into v_req from public.store_order_requests where id = v_id2;
  assert v_req.payment_status = 'cod_selected' and v_req.payment_method = 'cod' and v_req.cart_cleared_at is not null, 'recorded on the order, cart cleared';
  assert (select count(*) from public.platform_order_notices where request_id = v_id2) = 1, 'the first notice exists for cash on delivery too';
  assert (select count(*) from public.cart_items where user_id = v_u2 and store_product_id = a1.id) = 0 and (select count(*) from public.cart_items where user_id = v_u2 and store_product_id = b1.id) = 1, 'only the paid store''s line left the cart';
  v_res := public.record_payment_event(v_store_a, jsonb_build_object('trackingNumber', v_trk2, 'eventId', 'cod-ev-1', 'eventType', 'payment.succeeded', 'providerTransactionId', 'TXN-C', 'amount', v_total2, 'provider', 'x'));
  assert v_res->>'outcome' = 'state_rejected', 'a card event cannot settle a cash-on-delivery order';
  select coalesce(jsonb_agg(jsonb_build_object('productSizeId', i.product_size_id, 'quantity', i.quantity, 'unitPrice', i.unit_price, 'currency', i.currency,
           'total', i.line_total, 'platformOrderNumber', i.platform_order_number) order by i.id), '[]'::jsonb) into v_items from public.store_order_request_items i where i.request_id = v_id2;
  v_res := public.receive_store_order_notification(jsonb_build_object('trackingNumber', v_trk2, 'status', 'completed', 'subtotal', (select subtotal from public.store_order_requests where id = v_id2),
     'shipping', 20, 'total', v_total2, 'currency', 'EGP', 'merchantOrderNumber', 'M-2002', 'merchantInvoiceNumber', 'INV-3002', 'paymentReference', 'COD-77',
     'customer', jsonb_build_object('id', v_u2, 'name', 'منى سمير فتحي عبد', 'phone', '01112345678', 'address', 'الجيزة'), 'items', v_items,
     'shipment', jsonb_build_object('carrier', 'Bosta', 'trackingCode', 'BW-9', 'status', 'handed_to_carrier'), 'idempotencyKey', 'p2-cod-n1'));
  assert (v_res->>'matched')::boolean, 'the cash-on-delivery notice matches: ' || v_res::text;
  assert (select merchant_order_number from public.store_order_requests where id = v_id2) = 'M-2002', 'merchant numbers recorded after the match';
  v_res := public.record_shipment_event(v_store_a, jsonb_build_object('trackingNumber', v_trk2, 'eventId', 'cod-sh-1', 'status', 'delivered'));
  assert (v_res->>'saleProven')::boolean, 'the cash-on-delivery sale is proven by delivery too';

  -- 14. Rejection (reason mandatory, closes the order, no payment afterwards) and a failed card payment that is retried.
  insert into public.cart_items (user_id, store_product_id, quantity) values (v_u2, a2.id, 1);
  v_res := public.place_store_order_server(jsonb_build_object('storeId', v_store_a, 'idempotencyKey', 'phase2-key-0003'), v_u2);
  v_id3 := (v_res->>'id')::uuid; v_trk3 := v_res->>'trackingNumber';
  v_res := public.merchant_review_order(v_store_a, jsonb_build_object('trackingNumber', v_trk3, 'decision', 'reject', 'reason', 'out of stock', 'eventId', 'rej-1'));
  assert v_res->>'status' = 'store_rejected', 'rejected';
  select * into v_req from public.store_order_requests where id = v_id3;
  assert v_req.status = 'store_rejected' and v_req.failure_reason = 'out of stock', 'the reason is stored for the customer';
  begin
    perform public.select_order_payment_server(v_id3, v_u2, v_m_card, 'phase2-pay-key-5');
    raise exception 'FAIL: paid a rejected order';
  exception when raise_exception then
    assert sqlerrm like 'Order is not approved for payment%', 'no payment on a rejected order: ' || sqlerrm;
  end;
  assert (public.record_payment_event(v_store_a, jsonb_build_object('trackingNumber', v_trk3, 'eventId', 'rej-pay-1', 'eventType', 'payment.succeeded', 'providerTransactionId', 'TXN-R', 'amount', 100, 'provider', 'x'))->>'outcome') = 'state_rejected', 'a payment event for a rejected order is recorded, not applied';
  assert (select payment_status from public.store_order_requests where id = v_id3) = 'not_started', 'a rejected order never had a payment';

  insert into public.cart_items (user_id, store_product_id, quantity) values (v_u1, a2.id, 1);
  v_res := public.place_store_order_server(jsonb_build_object('storeId', v_store_a, 'idempotencyKey', 'phase2-key-0004'), v_u1);
  v_id3 := (v_res->>'id')::uuid; v_trk3 := v_res->>'trackingNumber';
  perform public.merchant_review_order(v_store_a, jsonb_build_object('trackingNumber', v_trk3, 'decision', 'approve'));
  select * into v_req from public.store_order_requests where id = v_id3;
  v_pay := public.select_order_payment_server(v_id3, v_u1, v_m_card, 'phase2-pay-key-6');
  v_res := public.record_payment_event(v_store_a, jsonb_build_object('trackingNumber', v_trk3, 'eventId', 'fail-1', 'eventType', 'payment.failed', 'reason', 'card declined', 'provider', 'paymob'));
  assert v_res->>'paymentStatus' = 'failed', 'a signed failure is recorded';
  assert (select count(*) from public.platform_order_notices where request_id = v_id3) = 0 and (select count(*) from public.cart_items where user_id = v_u1 and store_product_id = a2.id) = 1, 'a failed payment writes no notice and keeps the cart';
  v_pay := public.select_order_payment_server(v_id3, v_u1, v_m_card, 'phase2-pay-key-7');
  assert v_pay->>'paymentStatus' = 'awaiting_payment', 'the customer can try again after a failure';
  v_res := public.record_payment_event(v_store_a, jsonb_build_object('trackingNumber', v_trk3, 'eventId', 'ok-1', 'eventType', 'payment.succeeded', 'providerTransactionId', 'TXN-9', 'amount', v_req.payable_amount, 'provider', 'paymob'));
  assert (v_res->>'applied')::boolean, 'the retry is settled';
  assert (select payment_reference from public.store_order_requests where id = v_id3) = 'TXN-9', 'with no separate reference the transaction id is the reference';

  -- 15. EGP only, at every step.
  begin
    perform public.select_order_payment_server(v_id3, v_u1, v_m_card, 'phase2-pay-key-8');
    raise exception 'FAIL: chose after settled';
  exception when raise_exception then
    assert sqlerrm = 'Payment is already settled', 'a settled order is closed to a new choice';
  end;
  begin
    insert into public.order_payments (request_id, store_id, user_id, method_kind, mode, provider, status, amount, currency, idempotency_key)
    values (v_id3, v_store_a, v_u1, 'card', 'redirect', 'x', 'initiated', 10, 'USD', 'phase2-cur-key-1');
    raise exception 'FAIL: a USD payment row';
  exception when check_violation then null; end;

  raise exception 'ALL CHECKS PASSED';
end $$;

rollback;
