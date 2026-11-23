-- Real-database test for supabase/migrations/<version>_payment_hosts_allowlist.sql
-- (docs/purchase-flow-correction-plan.ar.md, stage 1: a store is linked only with a technical link; the payment page must be on a host the store listed).
-- Run AFTER the migration (or with the migration text first, in the same transaction), as the project owner. Everything is rolled back.
-- Synthetic users only; the integration row that is added (a fake https address, a fake secret, fake hosts) lives and dies inside the transaction.
begin;

create function pg_temp.place(p_user uuid, p_store uuid, p_prod uuid, p_qty integer, p_key text) returns jsonb language plpgsql as $f$
declare v_sub numeric;
begin
  delete from public.cart_items where user_id = p_user;
  insert into public.cart_items (user_id, store_product_id, quantity) values (p_user, p_prod, p_qty);
  select price * p_qty into v_sub from public.store_products where id = p_prod;
  return public.place_store_order_server(jsonb_build_object('storeId', p_store, 'idempotencyKey', p_key, 'expectedSubtotal', v_sub), p_user);
end $f$;

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
  v_u1 constant uuid := 'b0000000-0000-4000-8000-0000000000e1';
  v_store uuid;
  a1 public.store_products;
  v_res jsonb; v_id uuid; v_trk text; v_fin jsonb; v_state jsonb;
  v_bad text[];
  v_urls constant text[] := array['https://evil.example.invalid/pay', 'https://pay.example.invalid.evil.example.invalid/x', 'https://notpay.example.invalid/x',
                                  'https://pay.example.invalid@evil.example.invalid/x', 'https://example.invalid/x'];
  v_w public.payment_windows;
begin
  select sp.store_id into v_store from public.store_products sp join public.stores s on s.id = sp.store_id
   where s.status = 'active' group by sp.store_id order by sp.store_id limit 1;
  assert v_store is not null, 'an active store with products exists to test with';
  select * into a1 from public.store_products where store_id = v_store order by id limit 1;
  update public.store_products set is_available = true, stock_quantity = 50, price = 120.00 where id = a1.id;
  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (v_u1, 'authenticated', 'authenticated', 'hosts-1@example.invalid', '{"full_name":"Hosts One"}'::jsonb);
  insert into public.customer_details (user_id, full_name, phone, governorate, city, address, building_no, ship_same)
  values (v_u1, 'احمد محمد علي حسن', '01012345678', 'القاهرة', 'القاهرة', 'شارع التحرير', '5', true);

  -- 1. The host of an address: lower-case, no port, no path; anything that is not https has none.
  assert private.payment_host_of('https://Pay.Example.invalid:8443/s/1?x=1') = 'pay.example.invalid', 'host: case, port, path and query are dropped';
  assert private.payment_host_of('https://pay.example.invalid') = 'pay.example.invalid', 'host: no path';
  assert private.payment_host_of('http://pay.example.invalid/x') is null, 'host: http has none';
  assert private.payment_host_of(null) is null, 'host: null has none';
  assert not has_function_privilege('authenticated', 'private.payment_host_of(text)', 'execute') and not has_function_privilege('anon', 'private.payment_host_of(text)', 'execute'), 'the host helper is not reachable from a browser token';

  -- 2. The list: a store without a host is not linked, whatever else it has.
  insert into public.store_integrations (store_id, enabled, base_url, cart_url, api_base_url, catalog_endpoint, api_key, webhook_secret, notes, order_endpoint)
  values (v_store, true, 'https://merchant.example.invalid', 'https://merchant.example.invalid/cart', 'https://merchant.example.invalid/api',
          '/catalog', 'fake-api-key-for-test', 'fake-webhook-secret-for-test-0000000000', '', 'https://merchant.example.invalid/elan/orders');
  assert (select payment_hosts from public.store_integrations where store_id = v_store) = '{}'::text[], 'a new integration has no payment host';
  assert not private.store_order_ready(v_store), 'enabled + https order address + secret but no payment host: not linked';
  assert (select ready from public.store_order_readiness() where store_id = v_store) = false, 'the readiness list says not ready';
  begin
    perform public.reserve_order_draft(v_u1, v_store);
    raise exception 'FAIL: reserved a number for a store without a payment host';
  exception when raise_exception then assert sqlerrm = 'Store is not connected', 'draft refusal: ' || sqlerrm; end;
  update public.store_integrations set payment_hosts = array['pay.example.invalid'] where store_id = v_store;
  assert private.store_order_ready(v_store), 'with one payment host the store is linked';
  assert (select ready from public.store_order_readiness() where store_id = v_store), 'the readiness list says ready';

  -- 3. What may be written to the list: exact lower-case hosts only.
  v_bad := array['https://pay.example.invalid', 'Pay.Example.invalid', 'pay', 'pay.example.invalid/x', '*.example.invalid', 'pay_x.example.invalid',
                 '-a.example.invalid', 'a.example.invalid.', 'pay.example.invalid:8443', 'pay example.invalid', '', 'a..b.example'];
  for i in 1 .. array_length(v_bad, 1) loop
    begin
      update public.store_integrations set payment_hosts = array[v_bad[i]] where store_id = v_store;
      raise exception 'FAIL: accepted the host [%]', v_bad[i];
    exception when check_violation then null; end;
  end loop;
  begin
    update public.store_integrations set payment_hosts = array['pay.example.invalid', null] where store_id = v_store;
    raise exception 'FAIL: accepted a null host';
  exception when check_violation then null; end;
  begin
    update public.store_integrations set payment_hosts = (select array_agg('h' || g || '.example.invalid') from generate_series(1, 11) g) where store_id = v_store;
    raise exception 'FAIL: accepted eleven hosts';
  exception when check_violation then null; end;
  update public.store_integrations set payment_hosts = (select array_agg('h' || g || '.example.invalid') from generate_series(1, 10) g) where store_id = v_store;
  update public.store_integrations set payment_hosts = array['pay.example.invalid', 'pay2.example.invalid'] where store_id = v_store;
  assert (select cardinality(payment_hosts) from public.store_integrations where store_id = v_store) = 2, 'two exact hosts are accepted';

  -- 4. The merchant's approval must carry a payment window on the list.
  v_res := pg_temp.place(v_u1, v_store, a1.id, 1, 'hosts-key-0001');
  v_id := (v_res->>'id')::uuid;
  select tracking_number into v_trk from public.store_order_requests where id = v_id;
  for i in 1 .. 5 loop
    begin
      perform public.merchant_review_order(v_store, jsonb_build_object('trackingNumber', v_trk, 'decision', 'approve',
        'paymentWindowUrl', v_urls[i]));
      raise exception 'FAIL: approved a payment window on a host outside the list (case %)', i;
    exception when raise_exception then
      assert sqlerrm in ('The payment window address is not on the store''s list of payment hosts', 'An approval needs the https address of the payment window'), 'refusal text: ' || sqlerrm;
    end;
  end loop;
  assert (select status from public.store_order_requests where id = v_id) = 'awaiting_store_confirmation', 'a refused approval changes nothing on the order';
  assert not exists (select 1 from public.payment_windows where request_id = v_id), 'a refused approval leaves no window';

  -- 5. The same refusal through the delivery path: an invalid reply, recorded, the order still with the merchant.
  v_fin := pg_temp.attempt(v_id, 'order', '{"outcome":"responded","httpStatus":200,"reply":{"decision":"approve","paymentWindowUrl":"https://evil.example.invalid/pay"}}'::jsonb);
  assert v_fin->>'failureKind' = 'invalid_response', 'a payment window outside the list is an invalid reply: ' || coalesce(v_fin::text, 'null');
  assert (select status from public.store_order_requests where id = v_id) = 'awaiting_store_confirmation', 'still waiting for a valid reply';

  -- 6. A window on the list is accepted, and its host is what the customer's page is told (never the address).
  v_fin := pg_temp.attempt(v_id, 'order', '{"outcome":"responded","httpStatus":200,"reply":{"decision":"approve","paymentWindowUrl":"https://PAY.example.invalid:8443/s/ok?t=1"}}'::jsonb);
  assert (v_fin->>'ok')::boolean and v_fin->>'decision' = 'approve', 'an approval on a listed host is taken: ' || coalesce(v_fin::text, 'null');
  select * into v_w from public.payment_windows where request_id = v_id;
  assert v_w.host = 'pay.example.invalid', 'the window host is derived: ' || coalesce(v_w.host, 'null');
  v_state := public.customer_order_state(v_id, v_u1);
  assert v_state->'window'->>'host' = 'pay.example.invalid' and v_state->'window'->>'state' = 'issued', 'the customer state names the host';
  assert position('https' in v_state::text) = 0 and position('evil' in v_state::text) = 0 and (v_state->'window'->'url') is null, 'the address itself is not in the customer state';
  begin
    update public.payment_windows set host = 'other.example.invalid' where id = v_w.id;
    raise exception 'FAIL: wrote a generated column';
  exception when generated_always then null; end;

  raise exception 'ALL CHECKS PASSED';
end $$;
rollback;
