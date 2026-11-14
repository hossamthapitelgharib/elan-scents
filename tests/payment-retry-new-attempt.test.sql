-- Real-database test for supabase/migrations/<version>_payment_retry_new_attempt.sql
-- (review of the orders page, 2026-11-13, finding 3: a retry after a failed or cancelled attempt must open a NEW attempt).
-- Run AFTER the migration (or with the migration text first, in the same transaction), as the project owner. Everything is rolled back.
-- Synthetic user only; the catalog and the store are read, and the one catalog row that changes (stock, price) changes inside the transaction.
begin;

do $$
declare
  v_u1 constant uuid := 'b0000000-0000-4000-8000-0000000000e1';
  v_u2 constant uuid := 'b0000000-0000-4000-8000-0000000000e2';
  v_store uuid;
  a1 public.store_products;
  v_res jsonb;
  v_p1 jsonb;
  v_p2 jsonb;
  v_p3 jsonb;
  v_p4 jsonb;
  v_p5 jsonb;
  v_req public.store_order_requests;
  v_id uuid;
  v_trk text;
  v_m_card uuid;
  v_m_wallet uuid;
  v_n integer;
begin
  select sp.store_id into v_store from public.store_products sp join public.stores s on s.id = sp.store_id
   where s.status = 'active' group by sp.store_id order by sp.store_id limit 1;
  assert v_store is not null, 'an active store with products exists to test with';
  select * into a1 from public.store_products where store_id = v_store order by id limit 1;
  update public.store_products set is_available = true, stock_quantity = 50, price = 120.00 where id = a1.id;
  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (v_u1, 'authenticated', 'authenticated', 'retry-1@example.invalid', '{"full_name":"Retry One"}'::jsonb),
         (v_u2, 'authenticated', 'authenticated', 'retry-2@example.invalid', '{"full_name":"Retry Two"}'::jsonb);
  insert into public.customer_details (user_id, full_name, phone, governorate, city, address, building_no, floor_no, apartment_no, ship_same)
  values (v_u1, 'احمد محمد علي حسن', '01012345678', 'القاهرة', 'القاهرة', 'شارع التحرير', '5', '3', '12', true),
         (v_u2, 'منى سمير فتحي عبد', '01112345678', 'الجيزة', 'الجيزة', 'شارع الهرم', '10', '2', '4', true);

  -- An approved order offering two online methods (a card page and a wallet page).
  insert into public.cart_items (user_id, store_product_id, quantity) values (v_u1, a1.id, 1);
  v_res := public.place_store_order_server(jsonb_build_object('storeId', v_store, 'idempotencyKey', 'retry-order-key-1'), v_u1);
  v_id := (v_res->>'id')::uuid; v_trk := v_res->>'trackingNumber';
  insert into public.store_payment_methods (store_id, kind, mode, provider, label_ar, redirect_url)
  values (v_store, 'card', 'redirect', 'retrycard', 'بطاقة بنكية', 'https://pay.example.com/card') returning id into v_m_card;
  insert into public.store_payment_methods (store_id, kind, mode, provider, label_ar, redirect_url)
  values (v_store, 'other', 'redirect', 'retrywallet', 'محفظة إلكترونية', 'https://pay.example.com/wallet') returning id into v_m_wallet;
  perform public.merchant_review_order(v_store, jsonb_build_object('trackingNumber', v_trk, 'decision', 'approve', 'shipping', 10, 'eventId', 'retry-dec-1'));
  select * into v_req from public.store_order_requests where id = v_id;
  assert v_req.payment_status = 'not_started' and v_req.status = 'store_confirmed', 'the order is approved and unpaid';
  assert exists (select 1 from jsonb_array_elements(v_req.payment_options) o where o->>'id' = v_m_card::text)
     and exists (select 1 from jsonb_array_elements(v_req.payment_options) o where o->>'id' = v_m_wallet::text), 'the order offers both methods';

  -- 1. The retry key still protects against a double tap: while the attempt is alive the same key answers with the same attempt.
  v_p1 := public.select_order_payment_server(v_id, v_u1, v_m_card, 'retry-key-card-1');
  assert v_p1->>'status' = 'initiated' and v_p1->>'paymentStatus' = 'awaiting_payment', 'first card attempt is open';
  assert public.select_order_payment_server(v_id, v_u1, v_m_card, 'retry-key-card-1')->>'paymentId' = v_p1->>'paymentId', 'a double tap is the same attempt';
  assert (select count(*) from public.order_payments where request_id = v_id) = 1, 'one attempt so far';

  -- 2. Only the owner, and only a well-formed key.
  begin
    perform public.select_order_payment_server(v_id, v_u2, v_m_card, 'retry-key-card-1');
    raise exception 'FAIL: another customer reached the attempt through its key';
  exception when raise_exception then
    assert sqlerrm = 'Order not found', 'another customer gets nothing: ' || sqlerrm;
  end;
  begin
    perform public.select_order_payment_server(v_id, v_u1, v_m_card, 'short');
    raise exception 'FAIL: a malformed key was accepted';
  exception when raise_exception then
    assert sqlerrm = 'Invalid retry key', 'a malformed key is refused: ' || sqlerrm;
  end;

  -- 3. The attempt fails (signed event). The SAME key now opens a NEW attempt: it does not answer with the dead one.
  v_res := public.record_payment_event(v_store, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'retry-fail-1', 'eventType', 'payment.failed', 'reason', 'card declined', 'provider', 'retrycard'));
  assert v_res->>'paymentStatus' = 'failed', 'a signed failure is recorded';
  assert (select status from public.order_payments where id = (v_p1->>'paymentId')::uuid) = 'failed', 'the first attempt is failed';
  v_p2 := public.select_order_payment_server(v_id, v_u1, v_m_card, 'retry-key-card-1');
  assert v_p2->>'paymentId' <> v_p1->>'paymentId', 'the same key after a failure opens a new attempt';
  assert v_p2->>'status' = 'initiated' and v_p2->>'paymentStatus' = 'awaiting_payment' and v_p2->>'redirectUrl' = 'https://pay.example.com/card', 'the new attempt is open and points at the card page';
  assert (select s.status from public.store_order_requests s where s.id = v_id) = 'store_confirmed', 'the order itself is unchanged';
  assert (select payment_status from public.store_order_requests where id = v_id) = 'awaiting_payment', 'the order is awaiting payment again, not failed';
  assert (select status from public.order_payments where id = (v_p1->>'paymentId')::uuid) = 'failed', 'the failed attempt is left as history';
  assert public.select_order_payment_server(v_id, v_u1, v_m_card, 'retry-key-card-1')->>'paymentId' = v_p2->>'paymentId', 'a double tap on the retry is the retry';
  assert (select count(*) from public.order_payments where request_id = v_id) = 2, 'two attempts, no third from the double tap';

  -- 4. Choosing the wallet cancels the open card attempt and records the wallet as the method on the order.
  v_p3 := public.select_order_payment_server(v_id, v_u1, v_m_wallet, 'retry-key-wallet-1');
  assert v_p3->>'status' = 'initiated' and v_p3->>'redirectUrl' = 'https://pay.example.com/wallet', 'the wallet attempt is open';
  assert (select status from public.order_payments where id = (v_p2->>'paymentId')::uuid) = 'cancelled', 'the card attempt was cancelled';
  select * into v_req from public.store_order_requests where id = v_id;
  assert v_req.payment_method = 'other' and v_req.payment_provider = 'retrywallet', 'the order records the wallet';

  -- 5. Back to the card with the key the page still holds: it must be a real new card attempt, not the cancelled one, and the order must say card.
  v_p4 := public.select_order_payment_server(v_id, v_u1, v_m_card, 'retry-key-card-1');
  assert v_p4->>'paymentId' not in (v_p1->>'paymentId', v_p2->>'paymentId', v_p3->>'paymentId'), 'a fresh attempt, not the old ones';
  assert v_p4->>'status' = 'initiated' and v_p4->>'redirectUrl' = 'https://pay.example.com/card', 'it points at the card page';
  assert (select status from public.order_payments where id = (v_p3->>'paymentId')::uuid) = 'cancelled', 'the wallet attempt was cancelled';
  select * into v_req from public.store_order_requests where id = v_id;
  assert v_req.payment_method = 'card' and v_req.payment_provider = 'retrycard' and v_req.payment_status = 'awaiting_payment', 'the order records the card, not the first method';
  select count(*) into v_n from public.order_payments where request_id = v_id and status = 'initiated';
  assert v_n = 1, 'exactly one open attempt at a time';
  v_p5 := public.select_order_payment_server(v_id, v_u1, v_m_wallet, 'retry-key-wallet-1');
  assert v_p5->>'paymentId' <> v_p3->>'paymentId' and v_p5->>'status' = 'initiated', 'the wallet key opens a new wallet attempt too';
  assert (select count(*) from public.order_payments where request_id = v_id and status = 'initiated') = 1, 'still exactly one open attempt';
  assert (select count(distinct idempotency_key) from public.order_payments where request_id = v_id) = (select count(*) from public.order_payments where request_id = v_id), 'every attempt has its own internal key';

  -- 6. Only a signed event settles. A success for the wrong amount settles nothing; the right one settles the LAST attempt only.
  v_res := public.record_payment_event(v_store, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'retry-ok-0', 'eventType', 'payment.succeeded', 'providerTransactionId', 'RT-0', 'amount', 1, 'provider', 'retrywallet'));
  assert v_res->>'outcome' = 'amount_mismatch', 'a wrong amount is not applied';
  v_res := public.record_payment_event(v_store, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'retry-ok-1', 'eventType', 'payment.succeeded', 'providerTransactionId', 'RT-1',
            'amount', v_req.payable_amount, 'currency', 'EGP', 'provider', 'retrywallet'));
  assert (v_res->>'applied')::boolean and v_res->>'paymentStatus' = 'paid', 'the signed success is applied';
  assert (select count(*) from public.order_payments where request_id = v_id and status = 'paid') = 1, 'one paid attempt';
  assert (select count(*) from public.order_payments where request_id = v_id) = 5, 'five attempts in all, all kept';

  -- 7. Once settled no key opens anything new.
  begin
    perform public.select_order_payment_server(v_id, v_u1, v_m_card, 'retry-key-card-1');
    raise exception 'FAIL: chose again after paying';
  exception when raise_exception then
    assert sqlerrm = 'Payment is already settled' or sqlerrm like 'Order is not approved%', 'a paid order opens no new attempt: ' || sqlerrm;
  end;
  assert (select count(*) from public.order_payments where request_id = v_id) = 5, 'no attempt was added after payment';

  raise exception 'ALL CHECKS PASSED';
end $$;

rollback;
