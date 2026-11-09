-- Real-database test for supabase/migrations/<version>_customer_cancellation_requests.sql
-- Run AFTER the migration, as the project owner, inside one transaction. Everything is rolled back.
-- The users are synthetic (no real customer). The orders are made through place_store_order_server, so this also proves the two
-- features work together; the catalog rows used are only read (stock is set inside the transaction and rolled back).
begin;

do $$
declare
  v_uid constant uuid := 'b0000000-0000-4000-8000-0000000000d1';
  v_uid2 constant uuid := 'b0000000-0000-4000-8000-0000000000d2';
  v_store uuid;
  a1 public.store_products;
  v_o1 uuid;
  v_o2 uuid;
  v_o3 uuid;
  v_res jsonb;
  v_n integer;
  v_updated timestamptz;
  v_reason text;
  v_status text;

begin
  select sp.store_id into v_store
  from public.store_products sp join public.stores s on s.id = sp.store_id
  where s.status = 'active' group by sp.store_id order by sp.store_id limit 1;
  assert v_store is not null, 'an active store exists to test with';
  select * into a1 from public.store_products where store_id = v_store order by id limit 1;
  update public.store_products set is_available = true, stock_quantity = 50 where id = a1.id;
  select * into a1 from public.store_products where id = a1.id;

  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (v_uid, 'authenticated', 'authenticated', 'cancel-1@example.invalid', '{"full_name":"Cancel One"}'::jsonb),
         (v_uid2, 'authenticated', 'authenticated', 'cancel-2@example.invalid', '{"full_name":"Cancel Two"}'::jsonb);

  -- Orders are made by the server for the signed-in customer from his account and his saved cart (phase 1). The same lines already waiting
  -- for the store are one order, so each of the three orders has a different quantity.
  insert into public.customer_details (user_id, full_name, phone, governorate, address, ship_same)
  values (v_uid, 'احمد محمد علي حسن', '01012345678', 'القاهرة', 'شارع التحرير', true);
  insert into public.cart_items (user_id, store_product_id, quantity) values (v_uid, a1.id, 1);
  v_o1 := (public.place_store_order_server(jsonb_build_object('storeId', v_store, 'idempotencyKey', 'cancel-key-0001'), v_uid))->>'id';
  update public.cart_items set quantity = 2 where user_id = v_uid and store_product_id = a1.id;
  v_o2 := (public.place_store_order_server(jsonb_build_object('storeId', v_store, 'idempotencyKey', 'cancel-key-0002'), v_uid))->>'id';
  update public.cart_items set quantity = 3 where user_id = v_uid and store_product_id = a1.id;
  v_o3 := (public.place_store_order_server(jsonb_build_object('storeId', v_store, 'idempotencyKey', 'cancel-key-0003'), v_uid))->>'id';
  assert v_o1 is not null and v_o2 is not null and v_o3 is not null and v_o1 <> v_o2, 'three orders exist for the first customer';

  -- 1. Who may call what.
  assert not has_function_privilege('anon', 'public.request_store_order_cancellation(uuid, text)', 'execute'), 'anon cannot ask';
  assert not has_function_privilege('authenticated', 'public.request_store_order_cancellation(uuid, text)', 'execute'), 'a browser token cannot ask directly: the server asks for a verified user';
  assert has_function_privilege('service_role', 'public.request_store_order_cancellation_server(uuid, text, uuid)', 'execute'), 'the server can ask for a verified customer';
  assert not has_table_privilege('authenticated', 'public.store_order_cancellation_requests', 'select'), 'clients cannot read the table directly';
  assert not has_table_privilege('authenticated', 'public.store_order_cancellation_requests', 'insert'), 'clients cannot write the table directly';
  assert not has_table_privilege('anon', 'public.store_order_cancellation_requests', 'select'), 'anon cannot read the table';
  assert (select relrowsecurity from pg_class where oid = 'public.store_order_cancellation_requests'::regclass), 'RLS is on';
  begin
    perform public.request_store_order_cancellation_server(v_o1, 'x', null);
    raise exception 'an anonymous call must be refused';
  exception when raise_exception then
    if sqlerrm = 'an anonymous call must be refused' then raise; end if;
    assert sqlerrm = 'Authentication required', 'the anonymous refusal says so: ' || sqlerrm;
  end;

  -- 2. The owner asks while the order awaits the store: a request is recorded, the order itself is not touched,
  --    and the customer, the platform admins and the store are told once.
  select updated_at, status into v_updated, v_status from public.store_order_requests where id = v_o1;
  v_res := public.request_store_order_cancellation_server(v_o1, '  changed my mind  ', v_uid);
  assert (v_res->>'duplicate')::boolean = false, 'the first call creates the request';
  assert v_res->>'trackingNumber' ~ '^ELN-[0-9]{8}-[0-9]{6}$', 'the tracking number comes back';
  select reason into v_reason from public.store_order_cancellation_requests where request_id = v_o1 and user_id = v_uid;
  assert v_reason = 'changed my mind', 'the reason is stored trimmed';
  assert (select status from public.store_order_requests where id = v_o1) = v_status, 'the order keeps its status: nothing is cancelled automatically';
  assert (select updated_at from public.store_order_requests where id = v_o1) = v_updated, 'the order row was not updated';
  select count(*) into v_n from public.notifications where request_id = v_o1 and type = 'customer_cancel_requested' and user_id = v_uid;
  assert v_n = 1, 'the customer has a notification';
  select count(*) into v_n from public.notifications where request_id = v_o1 and type = 'customer_cancel_requested' and recipient_role = 'platform_admin';
  assert v_n = 1, 'the platform admins have one notification';

  -- 3. Asking again changes nothing.
  v_res := public.request_store_order_cancellation_server(v_o1, 'another reason', v_uid);
  assert (v_res->>'duplicate')::boolean, 'the repeated call is a duplicate';
  select count(*) into v_n from public.store_order_cancellation_requests where request_id = v_o1;
  assert v_n = 1, 'still one request';
  select reason into v_reason from public.store_order_cancellation_requests where request_id = v_o1;
  assert v_reason = 'changed my mind', 'the first reason is kept';
  select count(*) into v_n from public.notifications where request_id = v_o1 and type = 'customer_cancel_requested' and user_id = v_uid;
  assert v_n = 1, 'the customer was not notified twice';

  -- 4. Refusals leave nothing behind.
  begin
    perform public.request_store_order_cancellation_server(v_o2, 'not mine', v_uid2);
    raise exception 'another customer must not cancel this order';
  exception when raise_exception then
    if sqlerrm = 'another customer must not cancel this order' then raise; end if;
    assert sqlerrm = 'Order not found', 'a foreign order looks like a missing order: ' || sqlerrm;
  end;
  begin
    perform public.request_store_order_cancellation_server(gen_random_uuid(), 'nothing', v_uid2);
    raise exception 'an unknown order must be refused';
  exception when raise_exception then
    if sqlerrm = 'an unknown order must be refused' then raise; end if;
    assert sqlerrm = 'Order not found', 'an unknown order is not found: ' || sqlerrm;
  end;
  begin
    perform public.request_store_order_cancellation_server(v_o2, repeat('r', 501), v_uid);
    raise exception 'a 501-character reason must be refused';
  exception when raise_exception then
    if sqlerrm = 'a 501-character reason must be refused' then raise; end if;
    assert sqlerrm = 'Reason is too long', 'the long reason is refused: ' || sqlerrm;
  end;
  select count(*) into v_n from public.store_order_cancellation_requests where request_id in (v_o2, v_o3);
  assert v_n = 0, 'no refused call stored a request';

  -- 5. A blank reason is stored as nothing.
  perform public.request_store_order_cancellation_server(v_o3, '   ', v_uid);
  assert (select reason from public.store_order_cancellation_requests where request_id = v_o3) is null, 'a blank reason is null';

  -- 6. Once the store has moved on, a new request is refused; an old request still answers (the page derives
  --    "declined" from the order status).
  update public.store_order_requests set status = 'store_confirmed' where id in (v_o1, v_o2);
  begin
    perform public.request_store_order_cancellation_server(v_o2, 'too late', v_uid);
    raise exception 'a confirmed order must refuse a new request';
  exception when raise_exception then
    if sqlerrm = 'a confirmed order must refuse a new request' then raise; end if;
    assert sqlerrm = 'Order is no longer waiting for the store', 'the late refusal says so: ' || sqlerrm;
  end;
  v_res := public.request_store_order_cancellation_server(v_o1, 'again', v_uid);
  assert (v_res->>'duplicate')::boolean, 'the existing request still answers after the store confirmed';
  select count(*) into v_n from public.store_order_cancellation_requests where request_id = v_o2;
  assert v_n = 0, 'the refused late request stored nothing';
  assert (select status from public.store_order_requests where id = v_o1) = 'store_confirmed', 'the request never changed the order';

  -- 7. Clients cannot touch the table directly.
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform count(*) from public.store_order_cancellation_requests;
    raise exception 'clients must not read the table';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.store_order_cancellation_requests (request_id, user_id) values (v_o2, v_uid);
    raise exception 'clients must not write the table';
  exception when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
