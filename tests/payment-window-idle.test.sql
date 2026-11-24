-- Real-database test for supabase/migrations/<version>_payment_window_idle_clock.sql
-- (owner's ruling 22-23 Nov 2026: a customer who stops moving in the merchant's window for the merchant's idle time, 30 minutes when none is given,
--  cancels the purchase in the customer's own words; the time counts from the LAST interaction, so every interaction starts it again; going on to the
--  provider's window stops it for good; closing cancels at once; the 24 hours alert is only for "went on to the provider, then nothing came back").
-- Run AFTER the migration (or with the migration text first, in the same transaction), as the project owner. Everything is rolled back.
-- Synthetic users only; the integration row that is added (a fake https address, a fake secret, a fake payment host) lives and dies inside the transaction.
begin;

create function pg_temp.place(p_user uuid, p_store uuid, p_prod uuid, p_qty integer, p_key text) returns jsonb language plpgsql as $f$
declare v_sub numeric;
begin
  delete from public.cart_items where user_id = p_user;
  insert into public.cart_items (user_id, store_product_id, quantity) values (p_user, p_prod, p_qty);
  select price * p_qty into v_sub from public.store_products where id = p_prod;
  return public.place_store_order_server(jsonb_build_object('storeId', p_store, 'idempotencyKey', p_key, 'expectedSubtotal', v_sub), p_user);
end $f$;

-- Places an order and has the merchant approve it with the given reply fields; returns the request id.
create function pg_temp.approved(p_user uuid, p_store uuid, p_prod uuid, p_qty integer, p_key text, p_extra jsonb default '{}'::jsonb) returns uuid language plpgsql as $f$
declare v_res jsonb; v_id uuid; v_trk text;
begin
  v_res := pg_temp.place(p_user, p_store, p_prod, p_qty, p_key);
  v_id := (v_res->>'id')::uuid;
  select tracking_number into v_trk from public.store_order_requests where id = v_id;
  perform public.merchant_review_order(p_store, jsonb_build_object('trackingNumber', v_trk, 'decision', 'approve', 'paymentWindowUrl', 'https://pay.example.invalid/s/' || p_key) || p_extra);
  return v_id;
end $f$;

do $$
declare
  v_u constant uuid[] := array['b0000000-0000-4000-8000-0000000000c1'::uuid, 'b0000000-0000-4000-8000-0000000000c2', 'b0000000-0000-4000-8000-0000000000c3',
                               'b0000000-0000-4000-8000-0000000000c4', 'b0000000-0000-4000-8000-0000000000c5', 'b0000000-0000-4000-8000-0000000000c6',
                               'b0000000-0000-4000-8000-0000000000c7', 'b0000000-0000-4000-8000-0000000000c8'];
  v_store uuid;
  a1 public.store_products;
  v_id uuid; v_id2 uuid; v_id3 uuid; v_trk text; v_w public.payment_windows; v_r jsonb; v_n integer; v_bad jsonb;
begin
  select sp.store_id into v_store from public.store_products sp join public.stores s on s.id = sp.store_id
   where s.status = 'active' group by sp.store_id order by sp.store_id limit 1;
  assert v_store is not null, 'an active store with products exists to test with';
  select * into a1 from public.store_products where store_id = v_store order by id limit 1;
  update public.store_products set is_available = true, stock_quantity = 50, price = 120.00 where id = a1.id;
  for i in 1 .. array_length(v_u, 1) loop
    insert into auth.users (id, aud, role, email, raw_user_meta_data)
    values (v_u[i], 'authenticated', 'authenticated', 'idle-' || i || '@example.invalid', '{"full_name":"Idle Test"}'::jsonb);
    insert into public.customer_details (user_id, full_name, phone, governorate, city, address, building_no, ship_same)
    values (v_u[i], 'احمد محمد علي حسن', '01012345678', 'القاهرة', 'القاهرة', 'شارع التحرير', '5', true);
  end loop;
  insert into public.store_integrations (store_id, enabled, base_url, cart_url, api_base_url, catalog_endpoint, api_key, webhook_secret, notes, order_endpoint, payment_hosts)
  values (v_store, true, 'https://merchant.example.invalid', 'https://merchant.example.invalid/cart', 'https://merchant.example.invalid/api',
          '/catalog', 'fake-api-key-for-test', 'fake-webhook-secret-for-test-0000000000', '', 'https://merchant.example.invalid/elan/orders', array['pay.example.invalid']);

  -- 1. Structure and who may call what.
  assert (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'payment_windows'
            and column_name in ('idle_seconds', 'idle_deadline_at', 'interacted_at', 'clock_stopped_at')) = 4, 'the window has its idle clock columns';
  assert to_regprocedure('public.expire_payment_windows()') is null, 'the old clock function is still gone';
  assert has_function_privilege('service_role', 'public.merchant_window_interaction(uuid, jsonb)', 'execute') and has_function_privilege('service_role', 'public.close_idle_payment_windows()', 'execute'), 'the server runs the interaction report and the sweep';
  assert not has_function_privilege('authenticated', 'public.merchant_window_interaction(uuid, jsonb)', 'execute') and not has_function_privilege('anon', 'public.merchant_window_interaction(uuid, jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public.close_idle_payment_windows()', 'execute') and not has_function_privilege('anon', 'public.close_idle_payment_windows()', 'execute'), 'no browser token can move or run the clock';
  assert position('idle_deadline_at <= now()' in pg_get_functiondef('public.place_store_order(jsonb)'::regprocedure)) > 0, 'place_store_order ignores an order whose idle time ran out';

  -- 2. The idle time: the merchant's own, 30 minutes when it gives none, never read from any other field.
  v_id := pg_temp.approved(v_u[1], v_store, a1.id, 1, 'idle-key-0001', '{"validitySeconds":5,"shipping":30,"total":999}'::jsonb);
  select * into v_w from public.payment_windows where request_id = v_id;
  assert v_w.idle_seconds = 1800 and v_w.idle_deadline_at between now() + interval '29 minutes' and now() + interval '31 minutes' and v_w.interacted_at is null and v_w.clock_stopped_at is null, 'no idle time given: 30 minutes from the opening';
  assert (select payable_amount from public.store_order_requests where id = v_id) = 120.00, 'shipping and total of the reply are still not read';
  v_id2 := pg_temp.approved(v_u[2], v_store, a1.id, 2, 'idle-key-0002', '{"idleSeconds":120}'::jsonb);
  select * into v_w from public.payment_windows where request_id = v_id2;
  assert v_w.idle_seconds = 120 and v_w.idle_deadline_at between now() + interval '110 seconds' and now() + interval '130 seconds', 'the merchant''s own idle time is used';
  v_id3 := (pg_temp.place(v_u[3], v_store, a1.id, 3, 'idle-key-0003')->>'id')::uuid;
  select tracking_number into v_trk from public.store_order_requests where id = v_id3;
  for v_bad in select * from jsonb_array_elements('[59, 86401, 0, -5, "600", 600.5, true, [1], {"a":1}]'::jsonb) loop
    begin
      perform public.merchant_review_order(v_store, jsonb_build_object('trackingNumber', v_trk, 'decision', 'approve', 'paymentWindowUrl', 'https://pay.example.invalid/s/x', 'idleSeconds', v_bad));
      raise exception 'FAIL: accepted idleSeconds %', v_bad;
    exception when raise_exception then
      assert sqlerrm = 'idleSeconds must be a whole number of seconds between 60 and 86400', 'idleSeconds refusal for ' || v_bad::text || ': ' || sqlerrm;
    end;
  end loop;
  assert (select status from public.store_order_requests where id = v_id3) = 'awaiting_store_confirmation' and not exists (select 1 from public.payment_windows where store_id = v_store and url like '%/x'), 'a refused idle time changes nothing';
  perform public.merchant_review_order(v_store, jsonb_build_object('trackingNumber', v_trk, 'decision', 'approve', 'paymentWindowUrl', 'https://pay.example.invalid/s/ok', 'idleSeconds', null));
  assert (select idle_seconds from public.payment_windows where request_id = v_id3) = 1800, 'a null idle time means the default';

  -- 3. A window whose customer never moved for its idle time is closed by the sweep: the purchase is cancelled in the customer's words, the cart is kept,
  --    the customer, the platform dashboard and the store are told.
  assert public.close_idle_payment_windows() = 0, 'nothing is closed while every window is within its idle time';
  update public.payment_windows set idle_deadline_at = now() - interval '1 second' where request_id = v_id;
  assert public.close_idle_payment_windows() = 1, 'the window past its idle time is closed';
  assert (select status from public.store_order_requests where id = v_id) = 'cancelled' and (select cancel_reason from public.store_order_requests where id = v_id) = 'payment_window_expired', 'the purchase is cancelled, with the real cause kept';
  assert (select state from public.payment_windows where request_id = v_id) = 'expired', 'the window is expired';
  assert (select payment_status from public.store_order_requests where id = v_id) in ('not_started', 'awaiting_payment') and not exists (select 1 from public.order_payments where request_id = v_id), 'no payment exists';
  assert exists (select 1 from public.cart_items where user_id = v_u[1]), 'the cart is kept';
  assert exists (select 1 from public.notifications where request_id = v_id and user_id = v_u[1] and type = 'order_cancelled' and body like 'تم إلغاء المعاملة برغبة العميل%'
                   and payload->>'byCustomer' = 'true' and payload->>'paymentMade' = 'false' and payload->>'cancelReason' = 'payment_window_expired'), 'the customer is told in the owner''s words, nothing was paid';
  assert exists (select 1 from public.notifications where request_id = v_id and recipient_role = 'platform_admin' and type = 'order_cancelled' and body like 'تم إلغاء المعاملة برغبة العميل%'), 'the platform dashboard is told in the same words';
  assert exists (select 1 from public.merchant_deliveries where request_id = v_id and kind = 'cancel'), 'the store is told';
  assert public.close_idle_payment_windows() = 0, 'a window is closed once';

  -- 4. The idle time counts from the LAST interaction: every interaction the merchant reports starts it again (the owner's five minutes of trying,
  --    then stopping: the whole idle time from the moment of stopping, not a single chance from the opening).
  v_id := pg_temp.approved(v_u[4], v_store, a1.id, 4, 'idle-key-0004', '{"idleSeconds":600}'::jsonb);
  select tracking_number into v_trk from public.store_order_requests where id = v_id;
  update public.payment_windows set idle_deadline_at = now() + interval '10 seconds' where request_id = v_id;     -- five minutes of trying have almost used it up
  v_r := public.merchant_window_interaction(v_store, jsonb_build_object('trackingNumber', v_trk));
  assert not (v_r->>'clockStopped')::boolean and not (v_r->>'duplicate')::boolean and (v_r->>'idleSeconds')::integer = 600, 'an interaction does not stop the clock, it restarts it';
  select * into v_w from public.payment_windows where request_id = v_id;
  assert v_w.interacted_at is not null and v_w.clock_stopped_at is null and v_w.idle_deadline_at between now() + interval '590 seconds' and now() + interval '610 seconds', 'the whole idle time is there again';
  v_r := public.merchant_window_interaction(v_store, jsonb_build_object('trackingNumber', v_trk, 'event', 'activity'));
  assert not (v_r->>'clockStopped')::boolean, 'the same report again restarts it again (not a duplicate to ignore)';
  assert public.close_idle_payment_windows() = 0 and (select status from public.store_order_requests where id = v_id) = 'store_confirmed', 'a window within its renewed idle time stays open';
  update public.payment_windows set idle_deadline_at = now() - interval '1 second' where request_id = v_id;         -- ... and then the customer stops completely
  v_n := public.close_idle_payment_windows();
  assert v_n = 1, 'when the customer stops for the whole idle time the sweep closes the window';
  assert (select status from public.store_order_requests where id = v_id) = 'cancelled', 'and the purchase is cancelled';
  begin
    perform public.merchant_window_interaction(v_store, jsonb_build_object('trackingNumber', v_trk, 'event', 'typing'));
    raise exception 'FAIL: accepted an unknown event';
  exception when raise_exception then assert sqlerrm = 'event must be activity or provider_window', 'unknown event: ' || sqlerrm; end;

  -- 5. Going on to the provider's window stops the clock for good: whatever the time, and whatever else is reported.
  v_id := pg_temp.approved(v_u[5], v_store, a1.id, 5, 'idle-key-0005');
  select tracking_number into v_trk from public.store_order_requests where id = v_id;
  v_r := public.merchant_window_interaction(v_store, jsonb_build_object('trackingNumber', v_trk, 'event', 'provider_window'));
  assert (v_r->>'clockStopped')::boolean and not (v_r->>'duplicate')::boolean, 'the move to the provider stops the clock';
  select * into v_w from public.payment_windows where request_id = v_id;
  assert v_w.idle_deadline_at is null and v_w.clock_stopped_at is not null and v_w.interacted_at is not null, 'no deadline is left';
  v_r := public.merchant_window_interaction(v_store, jsonb_build_object('trackingNumber', v_trk, 'event', 'activity'));
  assert (v_r->>'clockStopped')::boolean and (v_r->>'duplicate')::boolean, 'a later activity report does not restart a stopped clock';
  assert (select idle_deadline_at from public.payment_windows where request_id = v_id) is null, 'still no deadline';
  update public.payment_windows set issued_at = now() - interval '5 days', opened_at = now() - interval '5 days' where request_id = v_id;
  assert public.close_idle_payment_windows() = 0 and (select status from public.store_order_requests where id = v_id) = 'store_confirmed', 'a window the customer took to the provider is never closed by the sweep';
  perform public.open_payment_window(v_id, v_u[5]);
  assert (select idle_deadline_at from public.payment_windows where request_id = v_id) is null, 'opening it again does not start the clock again';
  begin
    perform public.merchant_window_interaction(v_store, jsonb_build_object('trackingNumber', 'ELN-00000000-000000'));
    raise exception 'FAIL: reported an interaction on an unknown order';
  exception when raise_exception then assert sqlerrm = 'Order not found', 'unknown order: ' || sqlerrm; end;
  begin
    perform public.merchant_window_interaction(gen_random_uuid(), jsonb_build_object('trackingNumber', v_trk));
    raise exception 'FAIL: another store reported on this order';
  exception when raise_exception then assert sqlerrm = 'Order not found', 'another store: ' || sqlerrm; end;

  -- 6. Opening the window starts the idle time from that moment (a customer may be sent to it a while after the approval), and a window already past its
  --    time is not opened: it is over, whether or not the sweep has reached it.
  v_id := pg_temp.approved(v_u[6], v_store, a1.id, 6, 'idle-key-0006', '{"idleSeconds":600}'::jsonb);
  update public.payment_windows set idle_deadline_at = now() + interval '20 seconds' where request_id = v_id;
  v_r := public.open_payment_window(v_id, v_u[6]);
  assert v_r->>'state' = 'opened' and v_r->>'url' is not null, 'the window opens';
  assert (select idle_deadline_at from public.payment_windows where request_id = v_id) between now() + interval '590 seconds' and now() + interval '610 seconds', 'the idle time runs from the opening';
  update public.payment_windows set idle_deadline_at = now() - interval '1 second' where request_id = v_id;
  v_r := public.open_payment_window(v_id, v_u[6]);
  assert v_r->>'state' = 'cancelled' and v_r->>'cancelReason' = 'payment_window_expired' and v_r->>'url' is null, 'a window past its idle time is not opened';
  assert (select status from public.store_order_requests where id = v_id) = 'cancelled', 'and the purchase is cancelled';

  -- 7. A report that comes after the idle time ran out is too late, and a cancelled order is never reopened by a report.
  v_id := pg_temp.approved(v_u[7], v_store, a1.id, 7, 'idle-key-0007');
  select tracking_number into v_trk from public.store_order_requests where id = v_id;
  update public.payment_windows set idle_deadline_at = now() - interval '1 second' where request_id = v_id;
  v_r := public.merchant_window_interaction(v_store, jsonb_build_object('trackingNumber', v_trk));
  assert v_r->>'status' = 'cancelled' and (v_r->>'ignored')::boolean, 'too late: the purchase is cancelled';
  assert (public.merchant_window_interaction(v_store, jsonb_build_object('trackingNumber', v_trk))->>'ignored')::boolean, 'a cancelled order is never reopened by a report';

  -- 8. The customer's own return "success" stops the clock too (the payment itself is still only proven by a neutral confirmation).
  v_id := pg_temp.approved(v_u[8], v_store, a1.id, 8, 'idle-key-0008');
  perform public.open_payment_window(v_id, v_u[8]);
  v_r := public.payment_window_return(v_id, v_u[8], 'success');
  assert v_r->>'state' = 'success_claimed', 'the return is recorded';
  select * into v_w from public.payment_windows where request_id = v_id;
  assert v_w.idle_deadline_at is null and v_w.clock_stopped_at is not null, 'the clock is stopped';
  assert (select payment_status from public.store_order_requests where id = v_id) <> 'paid', 'nothing is paid by a browser claim';
  assert public.close_idle_payment_windows() = 0 and (select status from public.store_order_requests where id = v_id) = 'store_confirmed', 'and the sweep leaves it alone';

  -- 9. The 24 hours alert: only for a customer who went on to the provider and then nothing came back.
  update public.payment_windows set issued_at = now() - interval '40 hours' where request_id = v_id;
  assert public.alert_stale_payment_windows() = 0, 'a window whose clock stopped just now is not alerted, however old its issue';
  update public.payment_windows set clock_stopped_at = now() - interval '30 hours' where request_id = v_id;
  v_n := public.alert_stale_payment_windows();
  assert v_n >= 1, 'a window the customer took to the provider more than 24 hours ago, with no outcome, is alerted';
  assert (select count(*) from public.notifications where request_id = v_id and type = 'payment_window_stale') = 1
     and (select recipient_role from public.notifications where request_id = v_id and type = 'payment_window_stale') = 'platform_admin', 'only the platform dashboard is told';
  assert public.alert_stale_payment_windows() = 0, 'it is told once';
  assert (select status from public.store_order_requests where id = v_id) = 'store_confirmed', 'nothing is cancelled by the alert';
  -- A window whose clock still runs is never "stale": the idle time closes it.
  v_id := pg_temp.approved(v_u[3], v_store, a1.id, 9, 'idle-key-0009');
  update public.payment_windows set issued_at = now() - interval '40 hours', interacted_at = now() - interval '30 hours' where request_id = v_id;
  perform public.alert_stale_payment_windows();
  assert not exists (select 1 from public.notifications where request_id = v_id and type = 'payment_window_stale'), 'a window with a running clock is not alerted';

  -- 10. A window past its idle time that the sweep has not reached yet does not make the same lines come back as "the open order".
  v_id := (pg_temp.place(v_u[1], v_store, a1.id, 8, 'idle-key-0010')->>'id')::uuid;
  perform public.merchant_review_order(v_store, jsonb_build_object('trackingNumber', (select tracking_number from public.store_order_requests where id = v_id), 'decision', 'approve', 'paymentWindowUrl', 'https://pay.example.invalid/s/10'));
  assert (pg_temp.place(v_u[1], v_store, a1.id, 8, 'idle-key-0010b')->>'id')::uuid = v_id, 'within its idle time the same lines are the same open order';
  update public.payment_windows set idle_deadline_at = now() - interval '1 second' where request_id = v_id;
  assert (pg_temp.place(v_u[1], v_store, a1.id, 8, 'idle-key-0010c')->>'id')::uuid <> v_id, 'past its idle time it is not the open order any more';

  raise exception 'ALL CHECKS PASSED';
end $$;
rollback;
