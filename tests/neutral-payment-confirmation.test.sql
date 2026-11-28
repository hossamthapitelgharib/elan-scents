-- Real-database test for supabase/migrations/<version>_stage2_neutral_payment_confirmation.sql
-- (stage 2 of docs/purchase-flow-correction-plan.ar.md, with the owner's clarification of 26 Nov 2026: payment providers, financiers and carriers are
--  contracted with the MERCHANT only; a payment is confirmed by a notice that leaves the provider's system for Élan's address, sealed with the key the
--  merchant gave; the platform records what the provider confirmed as it is, refuses no real money, and opens a discrepancy for what it cannot apply;
--  a channel applies money only once a real signed notice has proved its key; cash on delivery is the merchant's signed report and is not money).
-- Run AFTER the migration (or with the migration text first, in the same transaction), as the project owner. Everything is rolled back.
-- Synthetic users only; the integration rows, channels and keys that are added (fake addresses, fake keys) live and die inside the transaction.
begin;

create function pg_temp.place(p_user uuid, p_store uuid, p_prod uuid, p_qty integer, p_key text) returns jsonb language plpgsql as $f$
declare v_sub numeric;
begin
  delete from public.cart_items where user_id = p_user;
  insert into public.cart_items (user_id, store_product_id, quantity) values (p_user, p_prod, p_qty);
  select price * p_qty into v_sub from public.store_products where id = p_prod;
  return public.place_store_order_server(jsonb_build_object('storeId', p_store, 'idempotencyKey', p_key, 'expectedSubtotal', v_sub), p_user);
end $f$;

create function pg_temp.approved(p_user uuid, p_store uuid, p_prod uuid, p_qty integer, p_key text) returns uuid language plpgsql as $f$
declare v_res jsonb; v_id uuid; v_trk text;
begin
  v_res := pg_temp.place(p_user, p_store, p_prod, p_qty, p_key);
  v_id := (v_res->>'id')::uuid;
  select tracking_number into v_trk from public.store_order_requests where id = v_id;
  perform public.merchant_review_order(p_store, jsonb_build_object('trackingNumber', v_trk, 'decision', 'approve', 'paymentWindowUrl', 'https://pay.example.invalid/s/' || p_key));
  return v_id;
end $f$;

-- A normalised provider event, the way the Worker hands it to the database.
create function pg_temp.ev(p_trk text, p_id text, p_type text, p_txn text, p_amount text, p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $f$
  select jsonb_strip_nulls(jsonb_build_object('trackingNumber', p_trk, 'eventId', p_id, 'eventType', p_type, 'providerTransactionId', p_txn,
                                              'amount', p_amount, 'currency', 'EGP', 'paymentMethod', 'card')) || p_extra
$f$;

-- Runs one statement and requires it to fail with exactly this message.
create function pg_temp.expect(p_sql text, p_msg text) returns void language plpgsql as $f$
declare v_got text;
begin
  begin
    execute p_sql;
  exception when raise_exception then v_got := sqlerrm;
  end;
  if v_got is null then raise exception 'FAIL: expected "%" but it succeeded: %', p_msg, p_sql; end if;
  if v_got <> p_msg then raise exception 'FAIL: expected "%" but got "%": %', p_msg, v_got, p_sql; end if;
end $f$;

do $$
declare
  v_u uuid[] := array[]::uuid[];
  v_store uuid; v_store2 uuid;
  a1 public.store_products;
  v_ch uuid; v_ch2 uuid; v_chx uuid; v_chb uuid;
  v_a uuid; v_b uuid; v_c uuid; v_d uuid; v_e uuid; v_f uuid; v_g uuid; v_h uuid; v_i uuid; v_l uuid;
  v_ta text; v_tb text; v_tc text; v_td text; v_te text; v_tf text; v_tg text; v_th text; v_ti text; v_tl text;
  v_r jsonb; v_o public.store_order_requests; v_n integer; v_pw text;
begin
  select sp.store_id into v_store from public.store_products sp join public.stores s on s.id = sp.store_id
   where s.status = 'active' group by sp.store_id order by sp.store_id limit 1;
  assert v_store is not null, 'an active store with products exists to test with';
  select id into v_store2 from public.stores where id <> v_store order by id limit 1;
  select * into a1 from public.store_products where store_id = v_store order by id limit 1;
  update public.store_products set is_available = true, stock_quantity = 100, price = 120.00 where id = a1.id;
  for i in 1 .. 12 loop
    v_u := v_u || ('b0000000-0000-4000-8000-0000000000' || lpad(to_hex(208 + i), 2, '0'))::uuid;
    insert into auth.users (id, aud, role, email, raw_user_meta_data)
    values (v_u[i], 'authenticated', 'authenticated', 'neutral-' || i || '@example.invalid', '{"full_name":"Neutral Test"}'::jsonb);
    insert into public.customer_details (user_id, full_name, phone, governorate, city, address, building_no, ship_same)
    values (v_u[i], 'احمد محمد علي حسن', '01012345678', 'القاهرة', 'القاهرة', 'شارع التحرير', '5', true);
  end loop;
  insert into public.store_integrations (store_id, enabled, base_url, cart_url, api_base_url, catalog_endpoint, api_key, webhook_secret, notes, order_endpoint, payment_hosts)
  values (v_store, true, 'https://merchant.example.invalid', 'https://merchant.example.invalid/cart', 'https://merchant.example.invalid/api',
          '/catalog', 'fake-api-key-for-test', 'fake-webhook-secret-for-test-0000000000', '', 'https://merchant.example.invalid/elan/orders', array['pay.example.invalid']);

  -- 0. Structure, grants and who may call what: everything here is server-only.
  assert (select count(*) from pg_class where oid in ('public.store_payment_channels'::regclass, 'public.payment_channel_log'::regclass, 'public.order_discrepancies'::regclass) and relrowsecurity) = 3, 'row level security is on for the three tables';
  assert not has_table_privilege('anon', 'public.store_payment_channels', 'select') and not has_table_privilege('authenticated', 'public.store_payment_channels', 'select')
     and not has_table_privilege('authenticated', 'public.store_payment_channels', 'insert') and not has_table_privilege('authenticated', 'public.store_payment_channels', 'update'), 'no browser token reads or writes the channels (they hold keys)';
  assert not has_table_privilege('anon', 'public.payment_channel_log', 'select') and not has_table_privilege('authenticated', 'public.payment_channel_log', 'select')
     and not has_table_privilege('authenticated', 'public.payment_channel_log', 'insert'), 'no browser token reads or writes the channel log';
  assert not has_table_privilege('anon', 'public.order_discrepancies', 'select') and not has_table_privilege('authenticated', 'public.order_discrepancies', 'select')
     and not has_table_privilege('authenticated', 'public.order_discrepancies', 'update') and not has_table_privilege('authenticated', 'public.order_discrepancies', 'delete'), 'no browser token reads or changes the discrepancies';
  assert has_table_privilege('service_role', 'public.store_payment_channels', 'select') and has_table_privilege('service_role', 'public.order_discrepancies', 'insert'), 'the server reaches them';
  assert has_function_privilege('service_role', 'public.record_payment_event(uuid, jsonb)', 'execute') and has_function_privilege('service_role', 'public.record_cod_selection(uuid, jsonb)', 'execute')
     and has_function_privilege('service_role', 'public.payment_channel_candidates(text, text)', 'execute') and has_function_privilege('service_role', 'public.record_channel_event(uuid, jsonb)', 'execute')
     and has_function_privilege('service_role', 'public.verify_payment_channel(uuid)', 'execute'), 'the server runs the payment functions';
  assert not (has_function_privilege('anon', 'public.record_payment_event(uuid, jsonb)', 'execute') or has_function_privilege('authenticated', 'public.record_payment_event(uuid, jsonb)', 'execute')
              or has_function_privilege('anon', 'public.record_cod_selection(uuid, jsonb)', 'execute') or has_function_privilege('authenticated', 'public.record_cod_selection(uuid, jsonb)', 'execute')
              or has_function_privilege('anon', 'public.payment_channel_candidates(text, text)', 'execute') or has_function_privilege('authenticated', 'public.payment_channel_candidates(text, text)', 'execute')
              or has_function_privilege('anon', 'public.record_channel_event(uuid, jsonb)', 'execute') or has_function_privilege('authenticated', 'public.record_channel_event(uuid, jsonb)', 'execute')
              or has_function_privilege('anon', 'public.verify_payment_channel(uuid)', 'execute') or has_function_privilege('authenticated', 'public.verify_payment_channel(uuid)', 'execute')
              or has_function_privilege('authenticated', 'private.open_discrepancy(uuid, text, text, jsonb)', 'execute')
              or has_function_privilege('authenticated', 'private.notify_platform_admin(text, text, text, jsonb, uuid, uuid)', 'execute')), 'no browser token can record a payment, a choice of cash on delivery or open a case';
  assert to_regprocedure('public.record_payment_event(uuid, jsonb)') is not null, 'the signature of the payment event function is unchanged';

  -- The channels of this store: one live for the tests, one that never receives a test notice.
  insert into public.store_payment_channels (store_id, provider, verification_key) values (v_store, 'testpay', 'fake-verification-key-0000') returning id into v_ch;
  insert into public.store_payment_channels (store_id, provider, verification_key) values (v_store, 'otherpay', 'fake-verification-key-1111') returning id into v_ch2;
  begin
    insert into public.store_payment_channels (store_id, provider, verification_key) values (v_store, 'testpay', 'another-key-0000');
    raise exception 'FAIL: a second channel for the same provider';
  exception when unique_violation then null; end;
  begin
    insert into public.store_payment_channels (store_id, provider, verification_key) values (v_store, 'Bad Name', 'abcdefgh');
    raise exception 'FAIL: accepted a provider name with spaces and capitals';
  exception when check_violation then null; end;
  begin
    insert into public.store_payment_channels (store_id, provider, verification_key) values (v_store, 'shortkey', 'abc');
    raise exception 'FAIL: accepted a key shorter than 8 characters';
  exception when check_violation then null; end;
  assert (select status from public.store_payment_channels where id = v_ch) = 'pending_test', 'a new channel waits for its test';

  -- 1. THE GATE. A channel applies no money until a real signed notice has arrived on it and the channel is verified.
  v_a := pg_temp.approved(v_u[1], v_store, a1.id, 2, 'neutral-key-0001');
  select tracking_number into v_ta from public.store_order_requests where id = v_a;
  assert (select payable_amount from public.store_order_requests where id = v_a) = 240.00 and (select shipping_amount from public.store_order_requests where id = v_a) is null, 'the approved order owes the products and nothing else';
  perform pg_temp.expect(format($q$select public.record_payment_event(%L::uuid, %L::jsonb)$q$, v_store, pg_temp.ev(v_ta, 'gate-0', 'payment.succeeded', 'TXN-GATE', '240.00', '{"provider":"testpay"}')),
                         'Payment channel is not verified');
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_ta, 'gate-1', 'payment.succeeded', 'TXN-GATE', '240.00'));
  assert v_r->>'outcome' = 'test_received' and not (v_r->>'applied')::boolean and not (v_r->>'duplicate')::boolean, 'the first notice on a pending channel is the test: logged, applied to nothing';
  assert (select payment_status from public.store_order_requests where id = v_a) not in ('paid', 'cod_selected') and not exists (select 1 from public.order_payments where request_id = v_a)
     and not exists (select 1 from public.order_payment_events where request_id = v_a), 'a test notice moves no money and records no payment';
  assert not exists (select 1 from public.platform_order_notices where request_id = v_a) and exists (select 1 from public.cart_items where user_id = v_u[1]), 'no first notice, the cart is kept';
  assert (select count(*) from public.payment_channel_log where channel_id = v_ch and event_id = 'gate-1' and outcome = 'test_received') = 1 and (select last_event_at from public.store_payment_channels where id = v_ch) is not null, 'the test notice is kept in the channel log';
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_ta, 'gate-1', 'payment.succeeded', 'TXN-GATE', '240.00'));
  assert (v_r->>'duplicate')::boolean and (select count(*) from public.payment_channel_log where channel_id = v_ch and event_id = 'gate-1') = 1, 'the same notice again is a duplicate, not a second log line';
  perform pg_temp.expect(format($q$select public.verify_payment_channel(%L::uuid)$q$, v_ch2), 'No signed test notice has arrived on this channel');
  perform pg_temp.expect(format($q$select public.verify_payment_channel(%L::uuid)$q$, gen_random_uuid()), 'Payment channel not found');
  v_r := public.verify_payment_channel(v_ch);
  assert v_r->>'status' = 'verified' and (v_r->>'changed')::boolean and (select verified_at from public.store_payment_channels where id = v_ch) is not null, 'a channel that received a signed test is verified';
  assert not ((public.verify_payment_channel(v_ch))->>'changed')::boolean, 'verifying twice changes nothing';

  -- 2. A confirmed payment is recorded AS IT IS: here more than the products (the merchant's shipping), by the provider's own words.
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_ta, 'evt-1', 'payment.succeeded', 'TXN-1', '270.50', '{"occurredAt":"2026-11-27T10:00:00Z"}'));
  assert (v_r->>'applied')::boolean and v_r->>'outcome' = 'applied' and v_r->>'paymentStatus' = 'paid', 'the confirmed payment is applied';
  select * into v_o from public.store_order_requests where id = v_a;
  assert v_o.payment_status = 'paid' and v_o.payment_method = 'card' and v_o.payment_provider = 'testpay' and v_o.payment_reference = 'TXN-1' and v_o.paid_at is not null, 'paid, by the provider''s name and the provider''s transaction';
  assert v_o.payable_amount = 270.50 and v_o.total_amount = 270.50 and v_o.shipping_amount is null, 'the order owes what the provider confirmed; the shipping is not guessed';
  assert v_o.status = 'store_confirmed' and v_o.payment_failure_reason is null, 'the order itself is untouched otherwise';
  assert (select count(*) from public.order_payments where request_id = v_a and status = 'paid' and method_kind = 'card' and mode = 'hosted' and provider = 'testpay'
            and provider_transaction_id = 'TXN-1' and amount = 270.50 and currency = 'EGP') = 1, 'one paid payment row by the provider''s transaction';
  assert (select count(*) from public.order_payment_events where request_id = v_a and event_id = 'evt-1' and outcome = 'applied' and event_type = 'payment.succeeded' and amount = 270.50) = 1, 'the event is kept';
  assert (select count(*) from public.platform_order_notices where request_id = v_a) = 1
     and (select (payload->>'total')::numeric from public.platform_order_notices where request_id = v_a) = 270.50
     and (select payload#>>'{payment,status}' from public.platform_order_notices where request_id = v_a) = 'paid'
     and (select jsonb_typeof(payload->'shipping') from public.platform_order_notices where request_id = v_a) = 'null', 'the first notice carries what was confirmed';
  assert not exists (select 1 from public.cart_items where user_id = v_u[1]), 'the paid lines leave the cart';
  assert exists (select 1 from public.notifications where request_id = v_a and user_id = v_u[1] and type = 'order_payment_recorded'), 'the customer is told';
  assert (select outcome from public.payment_channel_log where channel_id = v_ch and event_id = 'evt-1') = 'applied', 'the channel log says applied';

  -- 3. The same payment again, however it comes, changes nothing; a different payment for a paid order is a discrepancy, not a second payment.
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_ta, 'evt-1', 'payment.succeeded', 'TXN-1', '270.50'));
  assert (v_r->>'duplicate')::boolean and not (v_r->>'applied')::boolean, 'the same event id again is a duplicate';
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_ta, 'evt-1b', 'payment.succeeded', 'TXN-1', '270.50'));
  assert v_r->>'outcome' = 'duplicate_payment' and not (v_r->>'applied')::boolean, 'the same transaction under another event id is a duplicate payment';
  assert not exists (select 1 from public.order_discrepancies where request_id = v_a), 'telling the same payment twice opens no case';
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_ta, 'evt-2', 'payment.succeeded', 'TXN-2', '270.50'));
  assert v_r->>'outcome' = 'duplicate_payment' and not (v_r->>'applied')::boolean, 'a second transaction for a paid order is not applied';
  assert (select count(*) from public.order_payments where request_id = v_a) = 1 and (select payable_amount from public.store_order_requests where id = v_a) = 270.50
     and (select payment_reference from public.store_order_requests where id = v_a) = 'TXN-1', 'the order is exactly as it was';
  assert (select count(*) from public.order_discrepancies where request_id = v_a and kind = 'double_payment' and status = 'open') = 1, 'a case is opened for the platform';
  assert exists (select 1 from public.notifications where request_id = v_a and recipient_role = 'platform_admin' and type = 'order_discrepancy')
     and not exists (select 1 from public.notifications where request_id = v_a and type = 'order_discrepancy' and (user_id is not null or recipient_role <> 'platform_admin')), 'only the platform admin is told of a discrepancy';
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_ta, 'evt-2', 'payment.succeeded', 'TXN-2', '270.50'));
  assert (v_r->>'duplicate')::boolean and (select count(*) from public.order_discrepancies where request_id = v_a) = 1, 'the same second payment told again opens no second case';
  assert (select count(*) from public.platform_order_notices where request_id = v_a) = 1, 'there is one first notice, once';

  -- 4. A confirmed payment smaller than the products is still recorded (the money is real); the comparison is the matching of stage 3.
  v_b := pg_temp.approved(v_u[2], v_store, a1.id, 1, 'neutral-key-0002');
  select tracking_number into v_tb from public.store_order_requests where id = v_b;
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_tb, 'evt-b1', 'payment.succeeded', 'TXN-B1', '100.00'));
  assert (v_r->>'applied')::boolean and (select payable_amount from public.store_order_requests where id = v_b) = 100.00 and (select payment_status from public.store_order_requests where id = v_b) = 'paid', 'less than the products is recorded as paid for what was paid';
  -- A provider that says it failed after the order is paid does not touch the paid order.
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_tb, 'evt-b2', 'payment.failed', null, null, '{"reason":"late failure"}'));
  assert v_r->>'outcome' = 'failed_recorded' and (select payment_failure_reason from public.store_order_requests where id = v_b) is null and (select payment_status from public.store_order_requests where id = v_b) = 'paid', 'a failure notice never undoes a paid order';
  -- The amount may come as a JSON number too.
  v_l := pg_temp.approved(v_u[12], v_store, a1.id, 3, 'neutral-key-0012');
  select tracking_number into v_tl from public.store_order_requests where id = v_l;
  v_r := public.record_channel_event(v_ch, jsonb_build_object('trackingNumber', v_tl, 'eventId', 'evt-l1', 'eventType', 'payment.succeeded', 'providerTransactionId', 'TXN-L1', 'amount', 360.5, 'currency', 'EGP', 'paymentMethod', 'other'));
  assert (v_r->>'applied')::boolean and (select payable_amount from public.store_order_requests where id = v_l) = 360.50 and (select payment_method from public.store_order_requests where id = v_l) = 'other'
     and (select method_kind from public.order_payments where request_id = v_l) = 'other', 'a JSON number amount and a financier (other) method are recorded';

  -- 5. A refusal by the provider leaves the order open and gives the customer the provider's own words; a later success clears them.
  v_c := pg_temp.approved(v_u[3], v_store, a1.id, 1, 'neutral-key-0003');
  select tracking_number into v_tc from public.store_order_requests where id = v_c;
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_tc, 'evt-c1', 'payment.failed', null, null, jsonb_build_object('reason', E'Insufficient\nfunds\t(5001)')));
  assert v_r->>'outcome' = 'failed_recorded' and not (v_r->>'applied')::boolean, 'the refusal is recorded';
  select * into v_o from public.store_order_requests where id = v_c;
  assert v_o.status = 'store_confirmed' and v_o.payment_status not in ('paid', 'cod_selected', 'failed') and v_o.payment_failure_reason = 'Insufficient funds (5001)' and v_o.payment_failed_at is not null, 'the order stays open with the provider''s words, control characters cleaned';
  assert not exists (select 1 from public.order_payments where request_id = v_c) and exists (select 1 from public.cart_items where user_id = v_u[3]), 'nothing was paid, the cart is kept';
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_tc, 'evt-c2', 'payment.failed', null, null, '{}'));
  assert (select payment_failure_reason from public.store_order_requests where id = v_c) = 'لم يذكر مزود الدفع سببًا', 'a refusal without a reason says so';
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_tc, 'evt-c3', 'payment.succeeded', 'TXN-C3', '120.00'));
  assert (v_r->>'applied')::boolean and (select payment_failure_reason from public.store_order_requests where id = v_c) is null and (select payment_failed_at from public.store_order_requests where id = v_c) is null, 'the customer tried again and paid: the refusal is cleared';

  -- 6. Money that arrives for an order that was cancelled does NOT bring the order back: a discrepancy for the platform, the cart is kept.
  v_d := pg_temp.approved(v_u[4], v_store, a1.id, 4, 'neutral-key-0004');
  select tracking_number into v_td from public.store_order_requests where id = v_d;
  update public.payment_windows set idle_deadline_at = now() - interval '1 second' where request_id = v_d;
  v_n := public.close_idle_payment_windows();      -- (the sweep and the check are two statements: one statement does not see what its own function changed)
  assert v_n >= 1 and (select status from public.store_order_requests where id = v_d) = 'cancelled', 'the order is cancelled (the customer left the merchant''s window)';
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_td, 'evt-d1', 'payment.succeeded', 'TXN-D1', '480.00'));
  assert v_r->>'outcome' = 'late_after_cancel' and not (v_r->>'applied')::boolean, 'a payment after the cancellation is not applied';
  select * into v_o from public.store_order_requests where id = v_d;
  assert v_o.status = 'cancelled' and v_o.payment_status not in ('paid', 'cod_selected') and v_o.paid_at is null and not exists (select 1 from public.order_payments where request_id = v_d)
     and not exists (select 1 from public.platform_order_notices where request_id = v_d) and exists (select 1 from public.cart_items where user_id = v_u[4]), 'the order stays cancelled, nothing is recorded as paid, the cart is kept';
  assert (select count(*) from public.order_discrepancies where request_id = v_d and kind = 'payment_after_cancel' and status = 'open') = 1
     and (select (detail->>'amount')::numeric from public.order_discrepancies where request_id = v_d) = 480.00
     and (select detail->>'providerTransactionId' from public.order_discrepancies where request_id = v_d) = 'TXN-D1', 'the case holds the provider''s transaction and amount, to be returned or settled by the platform';
  assert exists (select 1 from public.order_payment_events where request_id = v_d and event_id = 'evt-d1' and outcome = 'late_after_cancel'), 'the event is kept';
  perform public.record_channel_event(v_ch, pg_temp.ev(v_td, 'evt-d1', 'payment.succeeded', 'TXN-D1', '480.00'));
  assert (select count(*) from public.order_discrepancies where request_id = v_d) = 1, 'told again, still one case';

  -- 7. A payment for an order the merchant never approved: a discrepancy, the order is untouched.
  v_e := (pg_temp.place(v_u[5], v_store, a1.id, 5, 'neutral-key-0005')->>'id')::uuid;
  select tracking_number into v_te from public.store_order_requests where id = v_e;
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_te, 'evt-e1', 'payment.succeeded', 'TXN-E1', '600.00'));
  assert v_r->>'outcome' = 'state_rejected' and (select count(*) from public.order_discrepancies where request_id = v_e and kind = 'payment_without_approval') = 1
     and (select status from public.store_order_requests where id = v_e) = 'awaiting_store_confirmation' and (select payment_status from public.store_order_requests where id = v_e) not in ('paid', 'cod_selected'), 'an unapproved order is not paid by a notice; a case is opened';
  perform pg_temp.expect(format($q$select public.record_cod_selection(%L::uuid, %L::jsonb)$q$, v_store, jsonb_build_object('trackingNumber', v_te, 'eventId', 'cod-e1')), 'Order is not waiting for payment');

  -- 8. Cash on delivery: the merchant's signed report; a choice, not money. The amount owed stays what was approved unless the merchant gives its total.
  v_f := pg_temp.approved(v_u[6], v_store, a1.id, 1, 'neutral-key-0006');
  select tracking_number into v_tf from public.store_order_requests where id = v_f;
  v_r := public.record_cod_selection(v_store, jsonb_build_object('trackingNumber', v_tf, 'eventId', 'cod-f1', 'occurredAt', '2026-11-27T10:05:00Z'));
  assert (v_r->>'applied')::boolean and v_r->>'outcome' = 'cod_recorded' and v_r->>'paymentStatus' = 'cod_selected', 'the choice of cash on delivery is recorded';
  select * into v_o from public.store_order_requests where id = v_f;
  assert v_o.payment_status = 'cod_selected' and v_o.payment_method = 'cod' and v_o.payment_provider is null and v_o.payment_reference = 'COD-' || v_tf and v_o.paid_at is null
     and v_o.payable_amount = 120.00 and v_o.status = 'store_confirmed', 'cash on delivery is not paid: no paid time, the approved amount stays';
  assert (select count(*) from public.order_payments where request_id = v_f and method_kind = 'cod' and mode = 'none' and provider = 'cod' and status = 'cod_selected' and amount = 120.00) = 1, 'one cod row, no provider';
  assert (select count(*) from public.platform_order_notices where request_id = v_f) = 1 and (select payload#>>'{payment,status}' from public.platform_order_notices where request_id = v_f) = 'cash_on_delivery'
     and not exists (select 1 from public.cart_items where user_id = v_u[6]), 'the first notice is written and the lines leave the cart';
  assert exists (select 1 from public.notifications where request_id = v_f and user_id = v_u[6] and type = 'order_cod_selected'), 'the customer is told';
  v_r := public.record_cod_selection(v_store, jsonb_build_object('trackingNumber', v_tf, 'eventId', 'cod-f1'));
  assert (v_r->>'duplicate')::boolean, 'the same report again is a duplicate';
  v_r := public.record_cod_selection(v_store, jsonb_build_object('trackingNumber', v_tf, 'eventId', 'cod-f2'));
  assert v_r->>'outcome' = 'duplicate_payment' and not (v_r->>'applied')::boolean and not exists (select 1 from public.order_discrepancies where request_id = v_f), 'the same choice under another event id changes nothing and opens no case';
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_tf, 'evt-f1', 'payment.succeeded', 'TXN-F1', '120.00'));
  assert v_r->>'outcome' = 'state_rejected' and (select count(*) from public.order_discrepancies where request_id = v_f and kind = 'payment_after_cod') = 1
     and (select payment_status from public.store_order_requests where id = v_f) = 'cod_selected' and not exists (select 1 from public.order_payments where request_id = v_f and status = 'paid'), 'an electronic payment after cash on delivery was chosen is a case, not a second payment';
  -- With the merchant's own total.
  v_g := pg_temp.approved(v_u[7], v_store, a1.id, 1, 'neutral-key-0007');
  select tracking_number into v_tg from public.store_order_requests where id = v_g;
  v_r := public.record_cod_selection(v_store, jsonb_build_object('trackingNumber', v_tg, 'eventId', 'cod-g1', 'total', '150.00', 'currency', 'EGP'));
  assert (v_r->>'applied')::boolean and (select payable_amount from public.store_order_requests where id = v_g) = 150.00 and (select total_amount from public.store_order_requests where id = v_g) = 150.00, 'the merchant''s total with the shipping is recorded';
  -- Cash on delivery for an order already paid or cancelled.
  v_r := public.record_cod_selection(v_store, jsonb_build_object('trackingNumber', v_ta, 'eventId', 'cod-a1'));
  assert v_r->>'outcome' = 'state_rejected' and (select count(*) from public.order_discrepancies where request_id = v_a and kind = 'cod_after_payment') = 1 and (select payment_status from public.store_order_requests where id = v_a) = 'paid', 'cod after an electronic payment is a case and the order stays paid';
  v_r := public.record_cod_selection(v_store, jsonb_build_object('trackingNumber', v_td, 'eventId', 'cod-d1'));
  assert v_r->>'outcome' = 'late_after_cancel' and (select count(*) from public.order_discrepancies where request_id = v_d and kind = 'cod_after_cancel') = 1 and (select status from public.store_order_requests where id = v_d) = 'cancelled', 'cod for a cancelled order is a case and the order stays cancelled';
  -- Refusals.
  v_h := pg_temp.approved(v_u[8], v_store, a1.id, 1, 'neutral-key-0008');
  select tracking_number into v_th from public.store_order_requests where id = v_h;
  perform pg_temp.expect(format($q$select public.record_cod_selection(%L::uuid, %L::jsonb)$q$, v_store, jsonb_build_object('trackingNumber', v_th, 'eventId', 'cod-h1', 'total', 'abc')), 'Invalid total amount');
  perform pg_temp.expect(format($q$select public.record_cod_selection(%L::uuid, %L::jsonb)$q$, v_store, jsonb_build_object('trackingNumber', v_th, 'eventId', 'cod-h2', 'total', '-5')), 'Invalid total amount');
  perform pg_temp.expect(format($q$select public.record_cod_selection(%L::uuid, %L::jsonb)$q$, v_store, jsonb_build_object('trackingNumber', v_th, 'eventId', 'cod-h3', 'total', '0')), 'Invalid total amount');
  perform pg_temp.expect(format($q$select public.record_cod_selection(%L::uuid, %L::jsonb)$q$, v_store, jsonb_build_object('trackingNumber', v_th, 'eventId', 'cod-h4', 'currency', 'USD')), 'Invalid total amount');
  perform pg_temp.expect(format($q$select public.record_cod_selection(%L::uuid, %L::jsonb)$q$, v_store, jsonb_build_object('trackingNumber', 'ELN-00000000-000000', 'eventId', 'cod-h5')), 'Order not found');
  perform pg_temp.expect(format($q$select public.record_cod_selection(%L::uuid, %L::jsonb)$q$, gen_random_uuid(), jsonb_build_object('trackingNumber', v_th, 'eventId', 'cod-h6')), 'Order not found');
  perform pg_temp.expect(format($q$select public.record_cod_selection(%L::uuid, %L::jsonb)$q$, v_store, jsonb_build_object('trackingNumber', v_th)), 'Invalid event id');
  perform pg_temp.expect(format($q$select public.record_cod_selection(%L::uuid, %L::jsonb)$q$, v_store, jsonb_build_object('trackingNumber', v_th, 'eventId', 'cod-h7', 'occurredAt', 'not a time')), 'Invalid time');
  assert (select payment_status from public.store_order_requests where id = v_h) not in ('paid', 'cod_selected') and not exists (select 1 from public.order_payment_events where request_id = v_h), 'a refused report changes nothing';

  -- 9. A payment in another currency: recorded as a case (the order table holds Egyptian pounds only), the order is untouched.
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_th, 'evt-h1', 'payment.succeeded', 'TXN-H1', '120.00', '{"currency":"USD"}'));
  assert v_r->>'outcome' = 'currency_mismatch' and (select count(*) from public.order_discrepancies where request_id = v_h and kind = 'payment_currency') = 1
     and (select payment_status from public.store_order_requests where id = v_h) not in ('paid', 'cod_selected'), 'a non-EGP payment is a case; the order is not marked paid';

  -- 10. What a payment event must carry.
  v_i := pg_temp.approved(v_u[9], v_store, a1.id, 1, 'neutral-key-0009');
  select tracking_number into v_ti from public.store_order_requests where id = v_i;
  perform pg_temp.expect(format($q$select public.record_payment_event(%L::uuid, %L::jsonb)$q$, v_store, pg_temp.ev(v_ti, 'v-1', 'payment.succeeded', null, '120.00', '{"provider":"testpay"}')), 'A provider transaction id is required');
  perform pg_temp.expect(format($q$select public.record_payment_event(%L::uuid, %L::jsonb)$q$, v_store, pg_temp.ev(v_ti, 'v-2', 'payment.succeeded', 'TXN-V2', null, '{"provider":"testpay"}')), 'Invalid amount');
  for v_pw in select unnest(array['0', '-1', '1e3', '12.345', '1,000', 'abc', '1234567890']) loop
    perform pg_temp.expect(format($q$select public.record_payment_event(%L::uuid, %L::jsonb)$q$, v_store, pg_temp.ev(v_ti, 'v-3', 'payment.succeeded', 'TXN-V3', v_pw, '{"provider":"testpay"}')), 'Invalid amount');
  end loop;
  perform pg_temp.expect(format($q$select public.record_payment_event(%L::uuid, %L::jsonb)$q$, v_store, pg_temp.ev(v_ti, 'v-4', 'payment.refunded', 'TXN-V4', '120.00', '{"provider":"testpay"}')), 'Invalid event type');
  perform pg_temp.expect(format($q$select public.record_payment_event(%L::uuid, %L::jsonb)$q$, v_store, pg_temp.ev(v_ti, repeat('x', 201), 'payment.succeeded', 'TXN-V5', '120.00', '{"provider":"testpay"}')), 'Invalid event id');
  perform pg_temp.expect(format($q$select public.record_payment_event(%L::uuid, %L::jsonb)$q$, v_store, pg_temp.ev('ELN-00000000-000000', 'v-6', 'payment.succeeded', 'TXN-V6', '120.00', '{"provider":"testpay"}')), 'Order not found');
  perform pg_temp.expect(format($q$select public.record_payment_event(%L::uuid, %L::jsonb)$q$, gen_random_uuid(), pg_temp.ev(v_ti, 'v-7', 'payment.succeeded', 'TXN-V7', '120.00', '{"provider":"testpay"}')), 'Payment channel is not verified');
  perform pg_temp.expect(format($q$select public.record_payment_event(%L::uuid, %L::jsonb)$q$, v_store, pg_temp.ev(v_ti, 'v-8', 'payment.succeeded', 'TXN-V8', '120.00', '{"provider":"nobody"}')), 'Payment channel is not verified');
  perform pg_temp.expect(format($q$select public.record_payment_event(%L::uuid, %L::jsonb)$q$, v_store, pg_temp.ev(v_ti, 'v-9', 'payment.succeeded', 'TXN-V9', '120.00', '{"provider":"otherpay"}')), 'Payment channel is not verified');
  assert not exists (select 1 from public.order_payment_events where request_id = v_i) and (select payment_status from public.store_order_requests where id = v_i) not in ('paid', 'cod_selected'), 'every refused event left no trace on the order';

  -- 11. A notice whose reference matches no order of the store is kept and shown to the admin, never applied; one for another store's order is the same.
  v_n := (select count(*) from public.notifications where recipient_role = 'platform_admin' and type = 'payment_unmatched');
  v_r := public.record_channel_event(v_ch, pg_temp.ev('ELN-00000000-000000', 'evt-u1', 'payment.succeeded', 'TXN-U1', '99.00'));
  assert v_r->>'outcome' = 'unmatched_reference' and not (v_r->>'applied')::boolean, 'a genuine notice for no order is kept';
  assert (select count(*) from public.payment_channel_log where channel_id = v_ch and event_id = 'evt-u1' and outcome = 'unmatched_reference' and amount = 99.00) = 1
     and (select count(*) from public.notifications where recipient_role = 'platform_admin' and type = 'payment_unmatched') = v_n + 1, 'it is in the channel log and the admin is told once';
  v_r := public.record_channel_event(v_ch, pg_temp.ev('ELN-00000000-000000', 'evt-u1', 'payment.succeeded', 'TXN-U1', '99.00'));
  assert (v_r->>'duplicate')::boolean and (select count(*) from public.notifications where recipient_role = 'platform_admin' and type = 'payment_unmatched') = v_n + 1, 'told again, the admin is not told again';
  v_r := public.record_channel_event(v_ch, pg_temp.ev(null, 'evt-u2', 'payment.succeeded', 'TXN-U2', '99.00'));
  assert v_r->>'outcome' = 'unmatched_reference', 'a notice with no reference at all is kept too';
  v_r := public.record_channel_event(v_ch, pg_temp.ev(v_tf, 'evt-un1', 'unsupported', null, '120.00'));
  assert v_r->>'outcome' = 'unsupported_kind' and exists (select 1 from public.notifications where recipient_role = 'platform_admin' and type = 'payment_unsupported' and store_id = v_store), 'a refund or an authorisation is logged and shown to the admin, not silently dropped, not applied';
  assert not exists (select 1 from public.order_payment_events where request_id = v_f and event_id = 'evt-un1'), 'and it is not an order event';
  if v_store2 is not null then
    insert into public.store_payment_channels (store_id, provider, verification_key, status, verified_at) values (v_store2, 'testpay', 'fake-verification-key-2222', 'verified', now()) returning id into v_chx;
    v_r := public.record_channel_event(v_chx, pg_temp.ev(v_ti, 'evt-x1', 'payment.succeeded', 'TXN-X1', '120.00'));
    assert v_r->>'outcome' = 'unmatched_reference' and (select payment_status from public.store_order_requests where id = v_i) not in ('paid', 'cod_selected'), 'another store''s verified channel can never pay this store''s order';
    -- Which channels could have sealed a notice: a known reference narrows it to that order's store; an unknown one is every live channel of the provider.
    assert (select count(*) from public.payment_channel_candidates('testpay', v_ti)) = 1 and (select store_id from public.payment_channel_candidates('testpay', v_ti)) = v_store
       and (select order_found from public.payment_channel_candidates('testpay', v_ti)), 'a known reference gives that order''s store channel only';
    assert (select count(*) from public.payment_channel_candidates('testpay', 'ELN-00000000-000000')) >= 2 and not exists (select 1 from public.payment_channel_candidates('testpay', 'ELN-00000000-000000') where order_found), 'an unknown reference gives every live channel of the provider';
    update public.store_payment_channels set status = 'disabled' where id = v_chx;
    assert (select count(*) from public.payment_channel_candidates('testpay', 'ELN-00000000-000000')) = (select count(*) from public.store_payment_channels where provider = 'testpay' and status <> 'disabled'), 'a disabled channel is never a candidate';
    perform pg_temp.expect(format($q$select public.record_channel_event(%L::uuid, %L::jsonb)$q$, v_chx, pg_temp.ev(v_ti, 'evt-x2', 'payment.succeeded', 'TXN-X2', '120.00')), 'Payment channel not found');
  end if;
  assert (select count(*) from public.payment_channel_candidates('nobody', v_ti)) = 0, 'a provider with no channel has no candidates';
  assert not exists (select 1 from public.payment_channel_candidates('testpay', 'x; drop table y') where order_found), 'a reference of an odd shape matches nothing';
  perform pg_temp.expect(format($q$select public.record_channel_event(%L::uuid, %L::jsonb)$q$, v_ch, pg_temp.ev(v_ti, 'evt-bad', 'payment.refunded', 'TXN-B', '1.00')), 'Invalid event type');
  perform pg_temp.expect(format($q$select public.record_channel_event(%L::uuid, %L::jsonb)$q$, v_ch, pg_temp.ev(v_ti, null, 'payment.succeeded', 'TXN-B', '1.00')), 'Invalid event id');

  -- 12. A disabled channel applies nothing, whatever it was before.
  update public.store_payment_channels set status = 'disabled' where id = v_ch;
  perform pg_temp.expect(format($q$select public.record_payment_event(%L::uuid, %L::jsonb)$q$, v_store, pg_temp.ev(v_ti, 'dis-1', 'payment.succeeded', 'TXN-DIS', '120.00', '{"provider":"testpay"}')), 'Payment channel is not verified');
  perform pg_temp.expect(format($q$select public.record_channel_event(%L::uuid, %L::jsonb)$q$, v_ch, pg_temp.ev(v_ti, 'dis-2', 'payment.succeeded', 'TXN-DIS', '120.00')), 'Payment channel not found');
  perform pg_temp.expect(format($q$select public.verify_payment_channel(%L::uuid)$q$, v_ch), 'Payment channel not found');
  update public.store_payment_channels set status = 'verified' where id = v_ch;

  -- 13. The guards on the order itself: no browser token (not even a store admin) can write the payment fields or move the approved amount.
  perform pg_temp.expect(format($q$update public.store_order_requests set payment_status = 'paid' where id = %L$q$, v_i), 'Payment fields are written only by the payment functions');
  perform pg_temp.expect(format($q$update public.store_order_requests set payment_failure_reason = 'x' where id = %L$q$, v_i), 'Payment fields are written only by the payment functions');
  perform pg_temp.expect(format($q$update public.store_order_requests set payment_failed_at = now() where id = %L$q$, v_i), 'Payment fields are written only by the payment functions');
  perform pg_temp.expect(format($q$update public.store_order_requests set payable_amount = 1 where id = %L$q$, v_i), 'The approved payment terms are fixed');
  perform pg_temp.expect(format($q$update public.store_order_requests set approved_at = approved_at + interval '1 second' where id = %L$q$, v_i), 'The approved payment terms are fixed');
  perform set_config('elan.terms_write', 'on', true);
  perform pg_temp.expect(format($q$update public.store_order_requests set payable_amount = 1 where id = %L$q$, v_a), 'The approved payment terms are fixed');   -- paid: never again
  perform pg_temp.expect(format($q$update public.store_order_requests set payment_options = '{}'::jsonb where id = %L$q$, v_i), 'The approved payment terms are fixed');
  perform set_config('elan.terms_write', 'off', true);
  assert (select payable_amount from public.store_order_requests where id = v_a) = 270.50 and (select payable_amount from public.store_order_requests where id = v_i) = 120.00, 'the amounts are as they were after the refused writes';

  -- 14. Append-only: events and cases are never changed or deleted, and the key-holding tables keep their shape.
  perform pg_temp.expect($q$update public.order_payment_events set outcome = 'applied'$q$, 'This record is append-only and is never changed or removed');
  perform pg_temp.expect($q$delete from public.order_payment_events$q$, 'This record is append-only and is never changed or removed');
  perform pg_temp.expect($q$delete from public.order_discrepancies$q$, 'This record is append-only and is never changed or removed');
  assert (select count(*) from public.order_payment_events where request_id = v_f and event_type = 'cod.selected' and outcome = 'cod_recorded') = 1, 'the cod report is an event of the order';

  raise exception 'ALL CHECKS PASSED';
end $$;
rollback;
