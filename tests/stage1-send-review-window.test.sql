-- Real-database test for supabase/migrations/<version>_stage1_send_review_payment_window.sql
-- (docs/purchase-flow-correction-plan.ar.md, stage 1: send to the merchant, the merchant's automatic review, the merchant-owned payment window).
-- Run AFTER the migration (or with the migration text first, in the same transaction), as the project owner. Everything is rolled back.
-- Synthetic users only; the catalog and the stores are read, and the catalog row that changes (stock, price) and the integration row that is
-- added (a fake https address and a fake secret) change inside the transaction and are rolled back with it.
begin;

-- Helpers that live only in this session.
create function pg_temp.place(p_user uuid, p_store uuid, p_prod uuid, p_qty integer, p_key text, p_draft uuid default null) returns jsonb language plpgsql as $f$
declare v_sub numeric;
begin
  delete from public.cart_items where user_id = p_user;
  insert into public.cart_items (user_id, store_product_id, quantity) values (p_user, p_prod, p_qty);
  select price * p_qty into v_sub from public.store_products where id = p_prod;
  return public.place_store_order_server(jsonb_build_object('storeId', p_store, 'idempotencyKey', p_key, 'expectedSubtotal', v_sub)
           || case when p_draft is null then '{}'::jsonb else jsonb_build_object('draftId', p_draft) end, p_user);
end $f$;

-- One send attempt as the Worker would run it: claim (the test does not wait ten seconds), then report the merchant's answer.
create function pg_temp.attempt(p_req uuid, p_kind text, p_result jsonb) returns jsonb language plpgsql as $f$
declare v jsonb; i jsonb;
begin
  update public.merchant_deliveries set next_attempt_at = now() where request_id = p_req and kind = p_kind and status = 'pending';
  v := public.claim_merchant_deliveries(p_req, 5);
  select e into i from jsonb_array_elements(v) e where e->>'kind' = p_kind limit 1;
  if i is null then return null; end if;
  return public.finish_merchant_delivery((i->>'deliveryId')::uuid, (i->>'attemptNo')::integer, p_result);
end $f$;

do $$
declare
  v_u1 constant uuid := 'b0000000-0000-4000-8000-0000000000f1';
  v_u2 constant uuid := 'b0000000-0000-4000-8000-0000000000f2';
  v_store uuid;
  a1 public.store_products;
  v_res jsonb; v_res2 jsonb; v_claim jsonb; v_fin jsonb; v_win jsonb; v_draft jsonb;
  v_req public.store_order_requests;
  v_id uuid; v_id2 uuid; v_trk text;
  v_n integer; v_w public.payment_windows; v_d public.merchant_deliveries;
  v_fail text[] := array['timeout', 'network', 'merchant_error', 'signature_rejected', 'timeout', 'network'];
  v_i integer; v_old_a uuid; v_old_b uuid; v_amount numeric;
begin
  select sp.store_id into v_store from public.store_products sp join public.stores s on s.id = sp.store_id
   where s.status = 'active' group by sp.store_id order by sp.store_id limit 1;
  assert v_store is not null, 'an active store with products exists to test with';
  select * into a1 from public.store_products where store_id = v_store order by id limit 1;
  update public.store_products set is_available = true, stock_quantity = 50, price = 120.00 where id = a1.id;

  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (v_u1, 'authenticated', 'authenticated', 'stage1-1@example.invalid', '{"full_name":"Stage One"}'::jsonb),
         (v_u2, 'authenticated', 'authenticated', 'stage1-2@example.invalid', '{"full_name":"Stage Two"}'::jsonb);
  insert into public.customer_details (user_id, full_name, phone, governorate, city, address, building_no, ship_same)
  values (v_u1, 'احمد محمد علي حسن', '01012345678', 'القاهرة', 'القاهرة', 'شارع التحرير', '5', true),
         (v_u2, 'منى سمير فتحي عبد', '01112345678', 'الجيزة', 'الجيزة', 'شارع الهرم', '10', true);

  -- 1. Who may call what, and what is gone.
  assert not has_function_privilege('anon', 'public.store_order_readiness()', 'execute') and not has_function_privilege('authenticated', 'public.store_order_readiness()', 'execute') and has_function_privilege('service_role', 'public.store_order_readiness()', 'execute'), 'the readiness list is read by the server only (the store page gets it from /api/store-order-readiness)';
  assert not has_function_privilege('anon', 'public.claim_merchant_deliveries(uuid, integer)', 'execute'), 'anon cannot claim deliveries';
  assert not has_function_privilege('authenticated', 'public.finish_merchant_delivery(uuid, integer, jsonb)', 'execute'), 'a browser token cannot report an attempt';
  assert not has_function_privilege('authenticated', 'public.open_payment_window(uuid, uuid)', 'execute'), 'the window is opened through the server only';
  assert not has_function_privilege('authenticated', 'public.merchant_review_order(uuid, jsonb)', 'execute'), 'a browser token cannot decide an order';
  assert has_function_privilege('service_role', 'public.expire_payment_windows()', 'execute'), 'the server expires windows';
  assert not has_table_privilege('authenticated', 'public.payment_windows', 'select'), 'no browser access to windows';
  assert not has_table_privilege('authenticated', 'public.merchant_deliveries', 'select'), 'no browser access to deliveries';
  assert not has_table_privilege('authenticated', 'public.merchant_delivery_attempts', 'select'), 'no browser access to attempts';
  assert not has_table_privilege('authenticated', 'public.order_drafts', 'select'), 'no browser access to drafts';
  assert to_regclass('public.store_payment_methods') is null, 'the payment-method table is gone';
  assert to_regprocedure('public.select_order_payment_server(uuid, uuid, uuid, text)') is null, 'the method chooser is gone';
  assert to_regprocedure('public.request_store_order_cancellation(uuid, text)') is null, 'the cancel request (customer button) is gone';
  assert to_regprocedure('public.request_store_order_cancellation_server(uuid, text, uuid)') is null, 'its server wrapper is gone';

  -- 2. The two trial orders the owner cancelled are "cancelled by the customer" at the recorded request time.
  v_old_a := 'ad3bd6ca-a627-41c5-adb7-fd41f8878683'; v_old_b := 'ab426df5-734d-4958-b016-26fa61ea532d';
  assert (select count(*) from public.store_order_requests r join public.store_order_cancellation_requests c on c.request_id = r.id
            where r.id in (v_old_a, v_old_b) and r.status = 'cancelled' and r.cancel_reason = 'customer_requested_before_payment' and r.cancelled_at = c.created_at) = 2,
         'both trial orders are cancelled by the customer at the time the request was recorded';

  -- 3. A store without a technical link takes no order and gives no order number.
  assert not private.store_order_ready(v_store), 'no integration: not ready';
  assert (select ready from public.store_order_readiness() where store_id = v_store) = false, 'the list says not ready';
  insert into public.cart_items (user_id, store_product_id, quantity) values (v_u1, a1.id, 1);
  begin
    perform public.place_store_order_server(jsonb_build_object('storeId', v_store, 'idempotencyKey', 'stage1-key-noint', 'expectedSubtotal', 120), v_u1);
    raise exception 'FAIL: ordered from an unlinked store';
  exception when raise_exception then assert sqlerrm = 'Store is not connected', 'unlinked store refusal: ' || sqlerrm; end;
  begin
    perform public.reserve_order_draft(v_u1, v_store);
    raise exception 'FAIL: reserved a number for an unlinked store';
  exception when raise_exception then assert sqlerrm = 'Store is not connected', 'draft refusal: ' || sqlerrm; end;
  delete from public.cart_items where user_id = v_u1;
  insert into public.store_integrations (store_id, enabled, base_url, cart_url, api_base_url, catalog_endpoint, api_key, webhook_secret, notes, order_endpoint)
  values (v_store, false, 'https://merchant.example.invalid', 'https://merchant.example.invalid/cart', 'https://merchant.example.invalid/api',
          '/catalog', 'fake-api-key-for-test', 'fake-webhook-secret-for-test-0000000000', '', 'https://merchant.example.invalid/elan/orders');
  assert not private.store_order_ready(v_store), 'a disabled integration is not a link';
  update public.store_integrations set order_endpoint = null, enabled = true where store_id = v_store;
  assert not private.store_order_ready(v_store), 'no order address is not a link';
  update public.store_integrations set order_endpoint = 'https://merchant.example.invalid/elan/orders', webhook_secret = 'short' where store_id = v_store;
  assert not private.store_order_ready(v_store), 'a short secret is not a link';
  begin
    update public.store_integrations set order_endpoint = 'http://merchant.example.invalid/x', webhook_secret = 'fake-webhook-secret-for-test-0000000000' where store_id = v_store;
    raise exception 'FAIL: a non-https order address was accepted';
  exception when check_violation then null; end;
  update public.store_integrations set webhook_secret = 'fake-webhook-secret-for-test-0000000000' where store_id = v_store;
  assert private.store_order_ready(v_store), 'enabled + https order address + secret: linked';
  assert (select ready from public.store_order_readiness() where store_id = v_store), 'the list says ready';

  -- 4. The order page's number is the order's number; a used or foreign draft is refused.
  v_draft := public.reserve_order_draft(v_u1, v_store);
  assert (public.reserve_order_draft(v_u1, v_store)->>'draftId') = v_draft->>'draftId', 'opening the page again keeps the same draft and number';
  assert (public.reserve_order_draft(v_u2, v_store)->>'trackingNumber') <> v_draft->>'trackingNumber', 'another customer gets another number';
  begin
    perform pg_temp.place(v_u2, v_store, a1.id, 1, 'stage1-key-foreign', (v_draft->>'draftId')::uuid);
    raise exception 'FAIL: used someone else''s draft';
  exception when raise_exception then assert sqlerrm = 'Order page expired', 'foreign draft refusal: ' || sqlerrm; end;
  v_res := pg_temp.place(v_u1, v_store, a1.id, 1, 'stage1-key-0001', (v_draft->>'draftId')::uuid);
  v_id := (v_res->>'id')::uuid;
  assert v_res->>'trackingNumber' = v_draft->>'trackingNumber', 'the order took the number the page showed';
  assert v_res->>'status' = 'awaiting_store_confirmation' and (v_res->>'duplicate')::boolean = false, 'the order is with the merchant';
  assert (select used_at is not null and request_id = v_id from public.order_drafts where id = (v_draft->>'draftId')::uuid), 'the draft is closed against the order';
  begin
    perform pg_temp.place(v_u1, v_store, a1.id, 2, 'stage1-key-reuse', (v_draft->>'draftId')::uuid);
    raise exception 'FAIL: reused a closed draft';
  exception when raise_exception then assert sqlerrm = 'Order page expired', 'used draft refusal: ' || sqlerrm; end;
  select * into v_d from public.merchant_deliveries where request_id = v_id and kind = 'order';
  assert v_d.status = 'pending' and v_d.attempts = 0 and v_d.max_attempts = 6, 'queued for the merchant with six attempts';
  assert (select count(*) from public.merchant_deliveries where request_id = v_id) = 1, 'only the order delivery exists';
  -- The same lines placed again with another key are the same order (a second tab).
  v_res2 := pg_temp.place(v_u1, v_store, a1.id, 1, 'stage1-key-0002');
  assert v_res2->>'id' = v_id::text and (v_res2->>'sameOpenOrder')::boolean, 'the same open order is returned';

  -- 5. The sender claims the delivery; the message is built from the frozen order and carries nothing of the customer's account id.
  v_claim := public.claim_merchant_deliveries(v_id, 5);
  assert jsonb_array_length(v_claim) = 1, 'one delivery claimed';
  assert v_claim->0->>'endpoint' = 'https://merchant.example.invalid/elan/orders' and length(v_claim->0->>'secret') >= 16, 'the endpoint and the secret reach only the server';
  assert v_claim->0->'payload'->>'trackingNumber' = v_draft->>'trackingNumber' and v_claim->0->'payload'->>'currency' = 'EGP', 'the payload carries the tracking number and EGP';
  assert (v_claim->0->'payload'->'items'->0->>'platformOrderNumber') = (v_draft->>'trackingNumber') || '-01', 'the first line number derives from the tracking number';
  assert position(v_u1::text in (v_claim->0->'payload')::text) = 0, 'the message never carries the customer''s account id';
  assert (v_claim->0->>'attemptNo')::integer = 1, 'first attempt';
  assert jsonb_array_length(public.claim_merchant_deliveries(v_id, 5)) = 0, 'a delivery being sent is not claimed twice';
  assert (public.finish_merchant_delivery((v_claim->0->>'deliveryId')::uuid, 7, '{"outcome":"failed"}'::jsonb)->>'ignored')::boolean, 'a report for the wrong attempt number is ignored';

  -- 6. Six failed attempts: each classified and reported to the platform, then the order is cancelled and the merchant is told.
  v_fin := public.finish_merchant_delivery((v_claim->0->>'deliveryId')::uuid, 1, jsonb_build_object('outcome', 'failed', 'failureKind', v_fail[1], 'httpStatus', null));
  assert (v_fin->>'ok')::boolean = false and v_fin->>'failureKind' = 'timeout', 'attempt 1 is a classified failure';
  select * into v_d from public.merchant_deliveries where request_id = v_id and kind = 'order';
  assert v_d.status = 'pending' and v_d.attempts = 1 and v_d.next_attempt_at > now() + interval '5 seconds', 'the next attempt waits about ten seconds';
  assert jsonb_array_length(public.claim_merchant_deliveries(v_id, 5)) = 0, 'not due yet: nothing is claimed early';
  for v_i in 2..6 loop
    v_fin := pg_temp.attempt(v_id, 'order', jsonb_build_object('outcome', 'failed', 'failureKind', v_fail[v_i]));
    assert v_fin is not null and v_fin->>'failureKind' = v_fail[v_i], 'attempt ' || v_i || ' recorded with its cause';
  end loop;
  assert (select count(*) from public.merchant_delivery_attempts where delivery_id = v_d.id and outcome = 'failed' and failure_kind is not null) = 6, 'six attempts, each with a cause';
  assert (select count(*) from public.notifications where request_id = v_id and recipient_role = 'platform_admin' and type = 'order_delivery_attempt_failed') = 6, 'the platform was told after every failed attempt';
  select * into v_req from public.store_order_requests where id = v_id;
  assert v_req.status = 'cancelled' and v_req.cancel_reason = 'store_unresponsive' and v_req.cancelled_at is not null, 'after the sixth the order is cancelled: the store did not respond';
  assert (select status from public.merchant_deliveries where id = v_d.id) = 'failed', 'the order delivery is closed as failed';
  assert exists (select 1 from public.merchant_deliveries where request_id = v_id and kind = 'cancel' and status = 'pending' and max_attempts = 8), 'the merchant is to be told of the cancellation';
  assert exists (select 1 from public.notifications where request_id = v_id and user_id = v_u1 and type = 'order_cancelled'
                   and body = 'نعتذر عن تنفيذ طلبك في الوقت الحالي، برجاء إعادة المحاولة بعد ساعة.'), 'the customer sees the apology';
  assert exists (select 1 from public.notifications where request_id = v_id and recipient_role = 'platform_admin' and type = 'order_cancelled'), 'the platform sees the cancellation';
  assert (select quantity from public.cart_items where user_id = v_u1 and store_product_id = a1.id) = 1, 'the products are still in the cart';
  begin
    perform public.merchant_review_order(v_store, jsonb_build_object('trackingNumber', v_req.tracking_number, 'decision', 'approve', 'paymentWindowUrl', 'https://pay.example.invalid/s/1'));
    raise exception 'FAIL: a late approval revived a cancelled order';
  exception when raise_exception then assert sqlerrm = 'Order is not waiting for the store', 'a cancelled order cannot be approved: ' || sqlerrm; end;
  -- The cancellation reaches the merchant: claim shows the reason; a 2xx closes it.
  v_fin := pg_temp.attempt(v_id, 'cancel', '{"outcome":"responded","httpStatus":200}'::jsonb);
  assert (v_fin->>'ok')::boolean and (select status from public.merchant_deliveries where request_id = v_id and kind = 'cancel') = 'delivered', 'the cancel message is delivered';

  -- 7. A rejection needs a reason; an approval needs the https address of the merchant's window; both are judged on the merchant's reply.
  v_res := pg_temp.place(v_u1, v_store, a1.id, 2, 'stage1-key-0003');
  v_id := (v_res->>'id')::uuid; v_trk := v_res->>'trackingNumber';
  assert v_res->>'status' = 'awaiting_store_confirmation', 'a new order after a cancelled one is a new order';
  v_fin := pg_temp.attempt(v_id, 'order', '{"outcome":"responded","httpStatus":200,"reply":{"decision":"reject"}}'::jsonb);
  assert v_fin->>'failureKind' = 'invalid_response', 'a rejection without a reason is not a valid answer';
  v_fin := pg_temp.attempt(v_id, 'order', '{"outcome":"responded","httpStatus":200,"reply":{"status":"received"}}'::jsonb);
  assert v_fin->>'failureKind' = 'no_decision', 'an answer without a decision is not a decision';
  v_fin := pg_temp.attempt(v_id, 'order', '{"outcome":"responded","httpStatus":200,"reply":{"decision":"approve"}}'::jsonb);
  assert v_fin->>'failureKind' = 'invalid_response', 'an approval without a payment window is refused';
  v_fin := pg_temp.attempt(v_id, 'order', '{"outcome":"responded","httpStatus":200,"reply":{"decision":"approve","paymentWindowUrl":"http://pay.example.invalid/s/1"}}'::jsonb);
  assert v_fin->>'failureKind' = 'invalid_response', 'a payment window must be https';
  v_fin := pg_temp.attempt(v_id, 'order', '{"outcome":"responded","httpStatus":200,"reply":{"decision":"approve","paymentWindowUrl":"https://pay.example.invalid/s/1","validitySeconds":3600}}'::jsonb);
  assert v_fin->>'failureKind' = 'invalid_response', 'a window valid for more than 30 minutes is refused';
  assert (select status from public.store_order_requests where id = v_id) = 'awaiting_store_confirmation', 'refused answers changed nothing on the order';
  v_fin := pg_temp.attempt(v_id, 'order', '{"outcome":"responded","httpStatus":200,"reply":{"decision":"reject","reason":"المنتج غير متوفر"}}'::jsonb);
  assert (v_fin->>'ok')::boolean and v_fin->>'decision' = 'reject', 'a rejection with a reason is accepted';
  select * into v_req from public.store_order_requests where id = v_id;
  assert v_req.status = 'store_rejected' and v_req.failure_reason = 'المنتج غير متوفر', 'the rejection and its reason are on the order (the customer sees the reason)';
  assert (select status from public.merchant_deliveries where request_id = v_id and kind = 'order') = 'delivered', 'the delivery is closed by the decision';
  assert not exists (select 1 from public.merchant_deliveries where request_id = v_id and kind = 'cancel'), 'a rejected order is not "cancelled": no cancel message';
  assert not exists (select 1 from public.payment_windows where request_id = v_id), 'a rejected order has no payment window';

  -- 8. An approval opens the merchant's window with its own validity; nothing in Elan lists payment methods any more.
  v_res := pg_temp.place(v_u1, v_store, a1.id, 3, 'stage1-key-0004');
  v_id := (v_res->>'id')::uuid; v_trk := v_res->>'trackingNumber';
  v_fin := pg_temp.attempt(v_id, 'order', '{"outcome":"responded","httpStatus":200,"reply":{"decision":"approve","paymentWindowUrl":"https://pay.example.invalid/s/abc?x=1","validitySeconds":600,"shipping":30}}'::jsonb);
  assert (v_fin->>'ok')::boolean and v_fin->>'decision' = 'approve', 'an approval with a window is accepted';
  select * into v_req from public.store_order_requests where id = v_id;
  assert v_req.status = 'store_confirmed' and v_req.approved_at is not null, 'approved';
  assert v_req.shipping_amount = 30 and v_req.payable_amount = 390 and v_req.total_amount = 390, 'the amount to pay is frozen: 3 x 120 + 30 shipping';
  assert v_req.payment_options is null and v_req.payment_status = 'not_started', 'no payment method was chosen or offered by Elan';
  select * into v_w from public.payment_windows where request_id = v_id;
  assert v_w.state = 'issued' and v_w.url = 'https://pay.example.invalid/s/abc?x=1' and v_w.store_id = v_store, 'the merchant''s window is recorded';
  assert v_w.expires_at - v_w.issued_at = interval '10 minutes', 'its validity is the merchant''s 600 seconds';
  -- The same lines are the same order while it waits for payment.
  v_res2 := pg_temp.place(v_u1, v_store, a1.id, 3, 'stage1-key-0005');
  assert v_res2->>'id' = v_id::text, 'an approved order waiting for payment is returned for the same lines, not duplicated';
  -- The approved terms are fixed.
  begin
    update public.store_order_requests set payable_amount = 1 where id = v_id;
    raise exception 'FAIL: the approved amount changed';
  exception when raise_exception then assert sqlerrm = 'The approved payment terms are fixed', 'approved amount is fixed: ' || sqlerrm; end;

  -- 9. Opening the window: only its owner, only while it is valid; it proves nothing about payment.
  begin
    perform public.open_payment_window(v_id, v_u2);
    raise exception 'FAIL: another customer opened the window';
  exception when raise_exception then assert sqlerrm = 'Order not found', 'another customer cannot open it: ' || sqlerrm; end;
  v_win := public.open_payment_window(v_id, v_u1);
  assert v_win->>'state' = 'opened' and v_win->>'url' = 'https://pay.example.invalid/s/abc?x=1', 'the customer gets the merchant''s window address';
  assert (select payment_status from public.store_order_requests where id = v_id) = 'not_started', 'opening a window is not a payment';
  -- Returning with "success" is only a claim: the order stays waiting for a neutral confirmation, and a later close does not cancel it.
  v_win := public.payment_window_return(v_id, v_u1, 'success');
  assert v_win->>'state' = 'success_claimed', 'the success claim is recorded';
  assert (select status from public.store_order_requests where id = v_id) = 'store_confirmed' and (select payment_status from public.store_order_requests where id = v_id) = 'not_started', 'a claim does not mark anything paid';
  v_win := public.payment_window_return(v_id, v_u1, 'closed');
  assert (v_win->>'ignored')::boolean and (select status from public.store_order_requests where id = v_id) = 'store_confirmed', 'closing after the customer said OK does not cancel';
  update public.payment_windows set issued_at = now() - interval '40 minutes', expires_at = now() - interval '10 minutes' where request_id = v_id;
  perform public.expire_payment_windows();
  assert (select status from public.store_order_requests where id = v_id) = 'store_confirmed' and (select state from public.payment_windows where request_id = v_id) = 'success_claimed', 'the clock does not cancel an order whose customer returned with OK';
  -- A trusted payment still settles it (the interim signed event, until the neutral adapters of stage 2) and then nothing can cancel it.
  v_amount := 390;
  v_fin := public.record_payment_event(v_store, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'stage1-evt-1', 'eventType', 'payment.succeeded',
             'providerTransactionId', 'stage1-txn-1', 'amount', v_amount, 'currency', 'EGP'));
  assert (v_fin->>'applied')::boolean, 'a trusted payment event settles the approved order';
  assert (select payment_status from public.store_order_requests where id = v_id) = 'paid', 'paid';
  assert not exists (select 1 from public.cart_items where user_id = v_u1 and store_product_id = a1.id), 'the paid lines left the cart (and only on payment)';
  assert (public.payment_window_return(v_id, v_u1, 'cancel')->>'state') = 'paid', 'a paid order is not cancelled by a window return';
  assert not private.cancel_unpaid_order(v_id, 'payment_window_closed', null), 'a paid order is never cancelled';
  assert (select status from public.store_order_requests where id = v_id) = 'store_confirmed', 'still confirmed';

  -- 10. Closing the window before payment cancels at once, tells the merchant, keeps the cart, and is never reopened.
  v_res := pg_temp.place(v_u1, v_store, a1.id, 4, 'stage1-key-0006');
  v_id := (v_res->>'id')::uuid; v_trk := v_res->>'trackingNumber';
  v_fin := pg_temp.attempt(v_id, 'order', '{"outcome":"responded","httpStatus":200,"reply":{"decision":"approve","paymentWindowUrl":"https://pay.example.invalid/s/2"}}'::jsonb);
  assert (v_fin->>'ok')::boolean, 'approved';
  select * into v_w from public.payment_windows where request_id = v_id;
  assert v_w.expires_at - v_w.issued_at = interval '30 minutes', 'the default validity is 30 minutes';
  perform public.open_payment_window(v_id, v_u1);
  v_win := public.payment_window_return(v_id, v_u1, 'closed');
  assert v_win->>'state' = 'cancelled' and v_win->>'cancelReason' = 'payment_window_closed', 'a closed window cancels the order';
  select * into v_req from public.store_order_requests where id = v_id;
  assert v_req.status = 'cancelled' and v_req.cancel_reason = 'payment_window_closed', 'cancelled on the order';
  assert (select state from public.payment_windows where request_id = v_id) = 'closed', 'the window is closed';
  assert exists (select 1 from public.merchant_deliveries where request_id = v_id and kind = 'cancel' and status = 'pending'), 'the merchant is told to void the payment session';
  assert (select quantity from public.cart_items where user_id = v_u1 and store_product_id = a1.id) = 4, 'the products stay in the cart';
  assert (public.open_payment_window(v_id, v_u1)->>'state') = 'cancelled', 'a cancelled order''s window is not reopened';
  assert (public.payment_window_return(v_id, v_u1, 'success')->>'state') = 'cancelled', 'a late success claim does not revive it';
  assert exists (select 1 from public.notifications where request_id = v_id and user_id = v_u1 and type = 'order_cancelled' and body like 'أُلغي الطلب لأن نافذة الدفع%'), 'the customer is told';
  assert exists (select 1 from public.notifications where request_id = v_id and recipient_role = 'platform_admin' and type = 'order_cancelled'), 'the platform is told';
  -- A payment that arrives for a cancelled order is not applied (a mismatch case for the admin in stage 3).
  v_fin := public.record_payment_event(v_store, jsonb_build_object('trackingNumber', v_trk, 'eventId', 'stage1-evt-2', 'eventType', 'payment.succeeded',
             'providerTransactionId', 'stage1-txn-2', 'amount', 480, 'currency', 'EGP'));
  assert not (v_fin->>'applied')::boolean and v_fin->>'outcome' = 'state_rejected', 'no payment is applied to a cancelled order';
  assert (select payment_status from public.store_order_requests where id = v_id) = 'not_started', 'the order did not become paid';

  -- 11. Cancelling in the window (the cancel button of the merchant's page) and the clock.
  v_res := pg_temp.place(v_u1, v_store, a1.id, 5, 'stage1-key-0007');
  v_id := (v_res->>'id')::uuid;
  perform pg_temp.attempt(v_id, 'order', '{"outcome":"responded","httpStatus":200,"reply":{"decision":"approve","paymentWindowUrl":"https://pay.example.invalid/s/3"}}'::jsonb);
  assert (public.payment_window_return(v_id, v_u1, 'cancel')->>'cancelReason') = 'payment_window_cancelled', 'the window''s own cancel is its own reason';
  v_res := pg_temp.place(v_u1, v_store, a1.id, 6, 'stage1-key-0008');
  v_id := (v_res->>'id')::uuid;
  perform pg_temp.attempt(v_id, 'order', '{"outcome":"responded","httpStatus":200,"reply":{"decision":"approve","paymentWindowUrl":"https://pay.example.invalid/s/4","validitySeconds":120}}'::jsonb);
  perform public.expire_payment_windows();
  assert (select status from public.store_order_requests where id = v_id) = 'store_confirmed', 'a window still valid is not expired';
  update public.payment_windows set issued_at = now() - interval '5 minutes', expires_at = now() - interval '3 minutes' where request_id = v_id;
  assert public.expire_payment_windows() >= 1, 'an expired window is cancelled by the clock';
  select * into v_req from public.store_order_requests where id = v_id;
  assert v_req.status = 'cancelled' and v_req.cancel_reason = 'payment_window_expired' and (select state from public.payment_windows where request_id = v_id) = 'expired', 'cancelled by expiry';
  assert exists (select 1 from public.merchant_deliveries where request_id = v_id and kind = 'cancel'), 'the merchant is told of the expiry';
  v_res := pg_temp.place(v_u1, v_store, a1.id, 7, 'stage1-key-0009');
  v_id := (v_res->>'id')::uuid;
  perform pg_temp.attempt(v_id, 'order', '{"outcome":"responded","httpStatus":200,"reply":{"decision":"approve","paymentWindowUrl":"https://pay.example.invalid/s/5"}}'::jsonb);
  update public.payment_windows set issued_at = now() - interval '40 minutes', expires_at = now() - interval '10 minutes' where request_id = v_id;
  assert (public.open_payment_window(v_id, v_u1)->>'cancelReason') = 'payment_window_expired', 'opening an expired window cancels the order (no cron needed)';

  -- 12. The state the page polls: delivery progress and the window, never the window address.
  v_res := pg_temp.place(v_u1, v_store, a1.id, 8, 'stage1-key-0010');
  v_id := (v_res->>'id')::uuid;
  v_win := public.customer_order_state(v_id, v_u1);
  assert v_win->'delivery'->>'state' = 'pending' and (v_win->'delivery'->>'maxAttempts')::integer = 6 and v_win->'window' = 'null'::jsonb, 'the page can say it is being sent';
  perform pg_temp.attempt(v_id, 'order', '{"outcome":"responded","httpStatus":200,"reply":{"decision":"approve","paymentWindowUrl":"https://pay.example.invalid/s/6"}}'::jsonb);
  v_win := public.customer_order_state(v_id, v_u1);
  assert v_win->'window'->>'state' = 'issued' and position('pay.example.invalid' in v_win::text) = 0, 'the poll never carries the window address';
  begin
    perform public.customer_order_state(v_id, v_u2);
    raise exception 'FAIL: another customer read the state';
  exception when raise_exception then assert sqlerrm = 'Order not found', 'state is the owner''s only: ' || sqlerrm; end;

  -- 13. A merchant that decides by the signed callback instead (the existing adapter) closes the delivery too, for the right store only.
  v_res := pg_temp.place(v_u2, v_store, a1.id, 1, 'stage1-key-0011');
  v_id := (v_res->>'id')::uuid; v_trk := v_res->>'trackingNumber';
  begin
    perform public.merchant_review_order(gen_random_uuid(), jsonb_build_object('trackingNumber', v_trk, 'decision', 'reject', 'reason', 'x'));
    raise exception 'FAIL: a foreign store decided the order';
  exception when raise_exception then assert sqlerrm = 'Order not found', 'a foreign store cannot decide it: ' || sqlerrm; end;
  perform public.merchant_review_order(v_store, jsonb_build_object('trackingNumber', v_trk, 'decision', 'reject', 'reason', 'مغلق اليوم', 'eventId', 'cb-1'));
  assert (select status from public.store_order_requests where id = v_id) = 'store_rejected', 'the callback decided it';
  assert (select status from public.merchant_deliveries where request_id = v_id and kind = 'order') = 'delivered', 'the callback closed the delivery';

  -- 14. A worker that died mid-attempt is recovered by the safety net: the open attempt is closed as lost and the next one proceeds.
  v_res := pg_temp.place(v_u2, v_store, a1.id, 2, 'stage1-key-0012');
  v_id := (v_res->>'id')::uuid;
  perform public.claim_merchant_deliveries(v_id, 5);
  update public.merchant_deliveries set locked_until = now() - interval '1 second', next_attempt_at = now() where request_id = v_id and kind = 'order';
  v_claim := public.claim_merchant_deliveries(v_id, 5);
  assert (select failure_kind from public.merchant_delivery_attempts a join public.merchant_deliveries d on d.id = a.delivery_id where d.request_id = v_id and a.attempt_no = 1) = 'worker_lost', 'the lost attempt is recorded as such';
  assert jsonb_array_length(v_claim) in (0, 1), 'the safety net moves on (the next attempt waits its ten seconds)';

  raise exception 'ALL CHECKS PASSED';
end $$;
rollback;
