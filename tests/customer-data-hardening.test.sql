-- Real-database test for supabase/migrations/<version>_customer_data_hardening.sql
-- Run AFTER the migration, as the project owner, inside one transaction. Everything is rolled back.
-- The user below is synthetic (no real customer), and the catalog rows are only read.
begin;

do $$
declare
  v_uid constant uuid := 'b0000000-0000-4000-8000-0000000000a1';
  v_uid2 constant uuid := 'b0000000-0000-4000-8000-0000000000a2';
  v_sp1 uuid;
  v_sp2 uuid;
  v_qty integer;
  v_rows integer;
  v_name text;
  v_big jsonb;
begin
  select id into v_sp1 from public.store_products order by id limit 1;
  select id into v_sp2 from public.store_products where id <> v_sp1 order by id limit 1;
  assert v_sp1 is not null and v_sp2 is not null, 'the catalog has at least two store products to test with';

  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (v_uid, 'authenticated', 'authenticated', 'hardening-test-1@example.invalid', '{"full_name":"Test One"}'::jsonb);
  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (v_uid2, 'authenticated', 'authenticated', 'hardening-test-2@example.invalid', jsonb_build_object('full_name', repeat('x', 500)));

  -- 1. The sign-up trigger cuts an over-long name to the column ceiling instead of failing the sign-up.
  select full_name into v_name from public.profiles where id = v_uid2;
  assert char_length(v_name) = 120, 'handle_new_user truncates the name to 120 characters';
  select full_name into v_name from public.profiles where id = v_uid;
  assert v_name = 'Test One', 'a normal name is stored as typed';

  -- 2. Cart quantity ceiling (the table constraint applies whoever writes).
  begin
    insert into public.cart_items (user_id, store_product_id, quantity) values (v_uid, v_sp1, 100);
    raise exception 'quantity 100 must be refused';
  exception when check_violation then null;
  end;
  insert into public.cart_items (user_id, store_product_id, quantity) values (v_uid, v_sp1, 99);
  delete from public.cart_items where user_id = v_uid;

  -- 3. Who can call the atomic cart function.
  assert not has_function_privilege('anon', 'public.replace_customer_cart(jsonb)', 'execute'), 'anon cannot call replace_customer_cart';
  assert has_function_privilege('authenticated', 'public.replace_customer_cart(jsonb)', 'execute'), 'signed-in users can call replace_customer_cart';

  -- 4. replace_customer_cart as the synthetic signed-in user.
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into v_rows from public.replace_customer_cart(jsonb_build_array(
    jsonb_build_object('storeProductId', v_sp1, 'quantity', 500),
    jsonb_build_object('storeProductId', v_sp2, 'quantity', 2),
    jsonb_build_object('storeProductId', 'not-a-uuid', 'quantity', 1),
    jsonb_build_object('storeProductId', v_sp2, 'quantity', 0),
    jsonb_build_object('quantity', 3),
    to_jsonb('a string'::text)));
  assert v_rows = 2, 'only the two valid lines are stored';
  reset role;
  select quantity into v_qty from public.cart_items where user_id = v_uid and store_product_id = v_sp1;
  assert v_qty = 99, 'a quantity of 500 is clamped to 99';
  select quantity into v_qty from public.cart_items where user_id = v_uid and store_product_id = v_sp2;
  assert v_qty = 2, 'the second line keeps its quantity (the later quantity-0 duplicate is skipped)';

  -- A refused call leaves the existing cart untouched.
  select jsonb_agg(jsonb_build_object('storeProductId', v_sp1, 'quantity', 1)) into v_big from generate_series(1, 101);
  set local role authenticated;
  begin
    perform * from public.replace_customer_cart(v_big);
    raise exception 'a 101-line cart must be refused';
  exception when raise_exception then
    if sqlerrm = 'a 101-line cart must be refused' then raise; end if;
  end;
  begin
    perform * from public.replace_customer_cart('{"a":1}'::jsonb);
    raise exception 'a non-array cart must be refused';
  exception when raise_exception then
    if sqlerrm = 'a non-array cart must be refused' then raise; end if;
  end;
  reset role;
  select count(*) into v_rows from public.cart_items where user_id = v_uid;
  assert v_rows = 2, 'the previous two-line cart survives the refused calls';

  -- An empty list clears the cart; null does the same.
  set local role authenticated;
  perform * from public.replace_customer_cart('[]'::jsonb);
  reset role;
  select count(*) into v_rows from public.cart_items where user_id = v_uid;
  assert v_rows = 0, 'an empty list empties the cart';

  -- Without a login the function refuses.
  perform set_config('request.jwt.claims', '', true);
  begin
    perform * from public.replace_customer_cart('[]'::jsonb);
    raise exception 'an anonymous call must be refused';
  exception when raise_exception then
    if sqlerrm = 'an anonymous call must be refused' then raise; end if;
  end;

  -- 5. Checkout session ceilings.
  begin
    insert into public.checkout_sessions (tracking_number, user_id, customer_name, customer_phone, customer_address, currency, subtotal)
    values (repeat('T', 65), v_uid, 'N', '1', 'A', 'EGP', 1);
    raise exception 'a 65-character tracking number must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.checkout_sessions (tracking_number, user_id, customer_name, customer_phone, customer_address, currency, subtotal)
    values ('ELN-T-1', v_uid, 'N', '1', 'A', 'egp', 1);
    raise exception 'a lower-case currency must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.checkout_sessions (tracking_number, user_id, customer_name, customer_phone, customer_address, currency, subtotal)
    values ('ELN-T-1', v_uid, repeat('n', 121), '1', 'A', 'EGP', 1);
    raise exception 'a 121-character name must be refused';
  exception when check_violation then null;
  end;
  insert into public.checkout_sessions (tracking_number, user_id, customer_name, customer_phone, customer_address, currency, subtotal)
  values ('ELN-20261024-000001', v_uid, repeat('n', 120), '+201000000000', repeat('a', 500), 'EGP', 10);

  -- 6. Profile ceilings.
  begin
    update public.profiles set avatar_url = 'javascript:alert(1)' where id = v_uid;
    raise exception 'a javascript: avatar must be refused';
  exception when check_violation then null;
  end;
  begin
    update public.profiles set full_name = repeat('x', 121) where id = v_uid;
    raise exception 'a 121-character profile name must be refused';
  exception when check_violation then null;
  end;
  update public.profiles set avatar_url = 'https://example.invalid/a.png', phone = '+201000000000' where id = v_uid;

  -- 7. Contact messages and reviews.
  begin
    insert into public.contact_messages (message) values ('');
    raise exception 'an empty message must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.contact_messages (message) values (repeat('m', 4001));
    raise exception 'a 4001-character message must be refused';
  exception when check_violation then null;
  end;
  insert into public.contact_messages (name, message) values ('T', repeat('m', 4000));

  -- 8. analytics_events: no anonymous insert; a signed-in user can insert a small row only for themselves.
  assert not has_table_privilege('anon', 'public.analytics_events', 'INSERT'), 'anon cannot insert analytics_events';
  assert not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'analytics_events' and 'anon' = any (roles)),
    'no analytics_events policy applies to anon';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.analytics_events (event_type, user_id, metadata) values ('view', v_uid, '{"k":"v"}'::jsonb);
  begin
    insert into public.analytics_events (event_type, user_id, metadata) values ('view', v_uid, jsonb_build_object('k', repeat('z', 3000)));
    raise exception 'a 3000-character metadata object must be refused';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.analytics_events (event_type, user_id, metadata) values ('view', v_uid2, '{}'::jsonb);
    raise exception 'inserting for another user must be refused';
  exception when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
