-- Real-database test for supabase/migrations/<version>_store_phase_hardening.sql
-- Run AFTER the migration, as the project owner, inside one transaction. Everything is rolled back.
-- The users are synthetic (no real customer or store). The two live stores and their catalog rows are only read or
-- changed inside the transaction (stock, price, links), and the transaction is rolled back.
begin;

create function pg_temp.fails(p_sql text, p_state text) returns boolean
language plpgsql as $f$
begin
  execute p_sql;
  return false;
exception when others then
  return sqlstate = p_state;
end $f$;

create function pg_temp.fails_with(p_sql text, p_message text) returns boolean
language plpgsql as $f$
begin
  execute p_sql;
  return false;
exception when others then
  return sqlerrm = p_message;
end $f$;

do $$
declare
  u_clean constant uuid := 'b0000000-0000-4000-8000-0000000000e1';
  u_order constant uuid := 'b0000000-0000-4000-8000-0000000000e2';
  u_unconf constant uuid := 'b0000000-0000-4000-8000-0000000000e3';
  u_admin constant uuid := 'b0000000-0000-4000-8000-0000000000e4';
  u_other constant uuid := 'b0000000-0000-4000-8000-0000000000e5';
  v_a uuid;
  v_b uuid;
  pa1 public.store_products;
  pa2 public.store_products;
  pb1 public.store_products;
  v_payload jsonb;
  v_res jsonb;
  v_acc_a uuid;
  v_acc_b uuid;
  v_n integer;
  v_price numeric;
  v_ok boolean;
begin
  select id into v_a from public.stores where slug = 'afnan-egypt';
  select id into v_b from public.stores where slug = 'emarati-scents';
  assert v_a is not null and v_b is not null, 'the two live stores exist to test with';
  select * into pa1 from public.store_products where store_id = v_a order by id limit 1;
  select * into pa2 from public.store_products where store_id = v_a and id <> pa1.id order by id limit 1;
  select * into pb1 from public.store_products where store_id = v_b order by id limit 1;
  assert pa1.id is not null and pa2.id is not null and pb1.id is not null, 'each store has catalog rows';
  update public.store_products set is_available = true, stock_quantity = 50, sync_status = 'synced' where id = pa1.id;
  select * into pa1 from public.store_products where id = pa1.id;

  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data)
  values (u_clean, 'authenticated', 'authenticated', 'clean-1@example.invalid', now(), '{"full_name":"Clean One"}'::jsonb),
         (u_order, 'authenticated', 'authenticated', 'ordered-1@example.invalid', now(), '{"full_name":"Ordered One"}'::jsonb),
         (u_unconf, 'authenticated', 'authenticated', 'unconfirmed-1@example.invalid', null, '{"full_name":"Unconfirmed One"}'::jsonb),
         (u_admin, 'authenticated', 'authenticated', 'admin-1@example.invalid', now(), '{"full_name":"Admin One"}'::jsonb),
         (u_other, 'authenticated', 'authenticated', 'other-1@example.invalid', now(), '{"full_name":"Other One"}'::jsonb);
  update public.profiles set role = 'platform_admin' where id = u_admin;
  assert (select role from public.profiles where id = u_clean) = 'customer', 'new users start as customers';

  -- 1. Orders only through place_store_order.
  assert not has_function_privilege('authenticated', 'public.create_checkout_session(jsonb)', 'execute'), 'clients cannot call create_checkout_session';
  assert not has_function_privilege('authenticated', 'public.create_store_order_request(jsonb)', 'execute'), 'clients cannot call create_store_order_request';
  assert not has_function_privilege('authenticated', 'public.create_store_order_request_from_cart(jsonb)', 'execute'), 'clients cannot call create_store_order_request_from_cart';
  assert not has_function_privilege('anon', 'public.create_store_order_request(jsonb)', 'execute'), 'anon cannot either';
  assert has_function_privilege('service_role', 'public.create_store_order_request(jsonb)', 'execute'), 'the server keeps the older functions';
  assert has_function_privilege('authenticated', 'public.place_store_order(jsonb)', 'execute'), 'a signed-in customer still places orders';
  assert not has_function_privilege('anon', 'public.place_store_order(jsonb)', 'execute'), 'anon cannot place orders';
  assert (select count(*) from pg_policies where schemaname = 'public' and tablename in ('orders', 'order_items') and cmd = 'INSERT') = 0,
    'no insert policy is left on the legacy order tables';
  perform set_config('request.jwt.claims', json_build_object('sub', u_other, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.orders (user_id, status) values (u_other, 'pending');
    raise exception 'a client must not insert into orders';
  exception when insufficient_privilege then null;
  end;
  reset role;

  v_payload := jsonb_build_object('storeId', v_a, 'customer', '{"name":"Test Customer","phone":"+201000000000","address":"Test street 1"}'::jsonb,
    'items', jsonb_build_array(jsonb_build_object('storeProductId', pa1.id, 'productSizeId', pa1.product_size_id, 'quantity', 1, 'unitPrice', pa1.price)));
  perform set_config('request.jwt.claims', json_build_object('sub', u_order, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.place_store_order(v_payload);
  reset role;
  assert v_res->>'trackingNumber' is not null, 'place_store_order still works and makes the tracking number';

  -- 2. Offer rules.
  assert pg_temp.fails(format('insert into public.offers (store_id, title) values (%L, %L)', v_a, ''), '23514'), 'an empty offer title is refused';
  assert pg_temp.fails(format('insert into public.offers (store_id, title) values (%L, %L)', v_a, '   '), '23514'), 'a blank offer title is refused';
  assert pg_temp.fails(format('insert into public.offers (store_id, title) values (%L, %L)', v_a, repeat('x', 201)), '23514'), 'a 201-character title is refused';
  assert pg_temp.fails(format('insert into public.offers (store_id, title, description) values (%L, %L, %L)', v_a, 't', repeat('x', 2001)), '23514'), 'a 2001-character description is refused';
  assert pg_temp.fails(format('insert into public.offers (store_id, title, discount_type, discount_value) values (%L, %L, %L, %s)', v_a, 't', 'percentage', 101), '23514'), 'a percentage over 100 is refused';
  assert pg_temp.fails(format('insert into public.offers (store_id, title, discount_type, discount_value) values (%L, %L, %L, %s)', v_a, 't', 'percentage', 0), '23514'), 'a zero discount is refused';
  assert pg_temp.fails(format('insert into public.offers (store_id, title, discount_type, discount_value) values (%L, %L, %L, %s)', v_a, 't', 'fixed', -5), '23514'), 'a negative discount is refused';
  assert pg_temp.fails(format('insert into public.offers (store_id, title, start_date, end_date) values (%L, %L, %L, %L)', v_a, 't', '2026-12-02', '2026-12-01'), '23514'), 'an end date before the start is refused';
  insert into public.offers (store_id, title, discount_type, discount_value) values (v_a, 'Test percentage', 'percentage', 100);
  insert into public.offers (store_id, title, discount_type, discount_value) values (v_a, 'Test fixed', 'fixed', 250);
  insert into public.offers (store_id, title, discount_type, discount_value, start_date, end_date) values (v_a, 'Test dated', 'package', 10, '2026-12-01', '2026-12-01');
  insert into public.offers (store_id, title) values (v_a, 'Test plain');

  -- 3. Links are http(s) only.
  assert pg_temp.fails(format('update public.stores set website_url = %L where id = %L', 'javascript:alert(1)', v_a), '23514'), 'a javascript: store link is refused';
  assert pg_temp.fails(format('update public.stores set logo_url = %L where id = %L', 'data:text/html,x', v_a), '23514'), 'a data: logo link is refused';
  assert pg_temp.fails(format('update public.stores set image_url = %L where id = %L', '//evil.example/x.png', v_a), '23514'), 'a protocol-relative image link is refused';
  assert pg_temp.fails(format('update public.store_products set product_url = %L where id = %L', 'javascript:alert(1)', pa1.id), '23514'), 'a javascript: product link is refused';
  assert pg_temp.fails(format('update public.store_products set product_url = %L where id = %L', 'https://a.example/x y', pa1.id), '23514'), 'a link with a space is refused';
  update public.stores set website_url = 'https://shop.example/path?x=1', logo_url = '', image_url = null where id = v_a;
  update public.store_products set product_url = 'http://shop.example/p/1' where id = pa1.id;
  update public.store_products set product_url = '' where id = pa1.id;

  -- 4. Audit table is server-only.
  assert (select relrowsecurity from pg_class where oid = 'public.platform_audit_log'::regclass), 'RLS is on for the audit log';
  assert not has_table_privilege('authenticated', 'public.platform_audit_log', 'select'), 'clients cannot read the audit log';
  assert not has_table_privilege('authenticated', 'public.platform_audit_log', 'insert'), 'clients cannot write the audit log';
  assert not has_table_privilege('anon', 'public.platform_audit_log', 'select'), 'anon cannot read the audit log';
  assert has_table_privilege('service_role', 'public.platform_audit_log', 'select'), 'the server can read the audit log';

  -- 5. Who may call the account functions: the server only.
  assert not has_function_privilege('authenticated', 'public.platform_link_store_account(uuid, text, uuid)', 'execute'), 'clients cannot link accounts';
  assert not has_function_privilege('authenticated', 'public.platform_unlink_store_account(uuid, uuid)', 'execute'), 'clients cannot unlink accounts';
  assert not has_function_privilege('authenticated', 'public.platform_store_accounts(uuid)', 'execute'), 'clients cannot list accounts';
  assert not has_function_privilege('anon', 'public.platform_link_store_account(uuid, text, uuid)', 'execute'), 'anon cannot link accounts';
  assert has_function_privilege('service_role', 'public.platform_link_store_account(uuid, text, uuid)', 'execute'), 'the server can link accounts';
  assert has_function_privilege('service_role', 'public.platform_unlink_store_account(uuid, uuid)', 'execute'), 'the server can unlink accounts';
  assert has_function_privilege('service_role', 'public.platform_store_accounts(uuid)', 'execute'), 'the server can list accounts';
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.platform_link_store_account(v_a, 'clean-1@example.invalid', u_admin);
    raise exception 'even a platform admin token must not call the function from a browser';
  exception when insufficient_privilege then null;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- 6. Linking: every refusal, then the happy path.
  assert pg_temp.fails_with(format('select public.platform_link_store_account(%L, %L, %L)', v_a, 'not-an-email', u_admin), 'Invalid email'), 'a malformed email is refused';
  assert pg_temp.fails_with(format('select public.platform_link_store_account(%L, %L, %L)', gen_random_uuid(), 'clean-1@example.invalid', u_admin), 'Store not found'), 'an unknown store is refused';
  assert pg_temp.fails_with(format('select public.platform_link_store_account(%L, %L, %L)', v_a, 'nobody-1@example.invalid', u_admin), 'User not found'), 'an unknown email is refused';
  assert pg_temp.fails_with(format('select public.platform_link_store_account(%L, %L, %L)', v_a, 'unconfirmed-1@example.invalid', u_admin), 'Email not confirmed'), 'an unconfirmed email is refused';
  assert pg_temp.fails_with(format('select public.platform_link_store_account(%L, %L, %L)', v_a, 'admin-1@example.invalid', u_admin), 'Platform admin cannot be a store account'), 'a platform admin is refused';
  assert pg_temp.fails_with(format('select public.platform_link_store_account(%L, %L, %L)', v_a, 'ordered-1@example.invalid', u_admin), 'Customer has order history'), 'a customer with orders is refused';
  assert (select role from public.profiles where id = u_order) = 'customer', 'the refused customer keeps his role';
  select count(*) into v_n from public.store_accounts where user_id in (u_order, u_unconf, u_admin);
  assert v_n = 0, 'the refusals linked nothing';
  assert (select count(*) from public.platform_audit_log) = 0, 'the refusals wrote no audit row';

  v_res := public.platform_link_store_account(v_a, '  CLEAN-1@Example.Invalid ', u_admin);
  assert not (v_res->>'already_linked')::boolean, 'the first link is new';
  v_acc_a := (v_res->>'account_id')::uuid;
  assert (select role from public.profiles where id = u_clean) = 'store_admin', 'the customer became a store admin';
  assert exists (select 1 from public.store_accounts where id = v_acc_a and store_id = v_a and user_id = u_clean and role = 'store_admin'), 'the account row exists';
  assert (select count(*) from public.platform_audit_log where action = 'store_account_linked' and target_id = v_acc_a and actor_id = u_admin) = 1, 'the link is in the audit log with the admin';
  assert not exists (select 1 from public.platform_audit_log where details::text ilike '%example.invalid%'), 'the audit log holds ids only, no email';

  v_res := public.platform_link_store_account(v_a, 'clean-1@example.invalid', u_admin);
  assert (v_res->>'already_linked')::boolean and (v_res->>'account_id')::uuid = v_acc_a, 'linking twice returns the same account';
  assert (select count(*) from public.store_accounts where user_id = u_clean) = 1, 'no duplicate account';
  assert (select count(*) from public.platform_audit_log where action = 'store_account_linked') = 1, 'the repeat wrote no second audit row';

  -- The server role can call it too (this is how the API does).
  set local role service_role;
  v_res := public.platform_link_store_account(v_b, 'clean-1@example.invalid', u_admin);
  reset role;
  v_acc_b := (v_res->>'account_id')::uuid;
  assert v_acc_b is not null and v_acc_b <> v_acc_a, 'the same person can serve a second store';

  select count(*) into v_n from public.platform_store_accounts();
  assert v_n = 2, 'the list shows both accounts';
  select count(*) into v_n from public.platform_store_accounts(v_a);
  assert v_n = 1, 'the list filters by store';
  assert (select email from public.platform_store_accounts(v_a)) = 'clean-1@example.invalid', 'the list carries the email';
  assert (select profile_role from public.platform_store_accounts(v_a)) = 'store_admin', 'the list carries the profile role';
  assert (select store_name from public.platform_store_accounts(v_a)) = (select name from public.stores where id = v_a), 'the list carries the store name';

  -- 7. A store member: own catalog yes, the platform flag no, the other store no.
  perform set_config('request.jwt.claims', json_build_object('sub', u_clean, 'role', 'authenticated')::text, true);
  assert private.is_store_member(v_a) and private.is_store_member(v_b), 'the member belongs to both of his stores';
  assert not private.is_store_member(gen_random_uuid()), 'and to no other';
  -- (a member of only the first store, to test isolation)
  delete from public.store_accounts where id = v_acc_b;
  assert private.is_store_member(v_a) and not private.is_store_member(v_b), 'no longer a member of the second store';
  set local role authenticated;
  begin
    update public.store_products set is_catalog_bestseller = not is_catalog_bestseller where id = pa1.id;
    raise exception 'a store member must not change the bestseller flag';
  exception when insufficient_privilege then
    assert sqlerrm = 'Only the platform can set the bestseller flag', 'refused by the guard, not by something else: ' || sqlerrm;
  end;
  v_price := pa1.price + 1;
  update public.store_products set price = v_price, stock_quantity = 7 where id = pa1.id;
  get diagnostics v_n = row_count;
  assert v_n = 1, 'a member changes price and stock of his own store';
  update public.store_products set price = 1 where id = pb1.id;
  get diagnostics v_n = row_count;
  assert v_n = 0, 'a member cannot touch the other store''s rows';
  update public.store_products set is_new_arrival = not is_new_arrival where id = pa2.id;
  get diagnostics v_n = row_count;
  assert v_n = 1, 'the other store-owned flags stay his';
  reset role;
  assert (select price from public.store_products where id = pa1.id) = v_price, 'the price change was stored';
  assert (select is_catalog_bestseller from public.store_products where id = pa1.id) = pa1.is_catalog_bestseller, 'the flag is unchanged';

  -- Insert path: remove a row (as the owner), then let the member add it back.
  delete from public.store_products where id = pa2.id;
  perform set_config('request.jwt.claims', json_build_object('sub', u_clean, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.store_products (store_id, product_size_id, price, stock_quantity, is_available, sync_status, is_catalog_bestseller)
    values (v_a, pa2.product_size_id, 10, 1, true, 'synced', true);
    raise exception 'a member must not insert a row with the bestseller flag';
  exception when insufficient_privilege then
    assert sqlerrm = 'Only the platform can set the bestseller flag', 'refused by the guard, not by something else: ' || sqlerrm;
  end;
  insert into public.store_products (store_id, product_size_id, price, stock_quantity, is_available, sync_status)
  values (v_a, pa2.product_size_id, 10, 1, true, 'synced');
  reset role;
  assert exists (select 1 from public.store_products where store_id = v_a and product_size_id = pa2.product_size_id and not is_catalog_bestseller), 'the member added a row without the flag';

  -- The platform admin and the server (no user) may set the flag.
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.store_products set is_catalog_bestseller = true where id = pa1.id;
  get diagnostics v_n = row_count;
  reset role;
  assert v_n = 1 and (select is_catalog_bestseller from public.store_products where id = pa1.id), 'a platform admin sets the flag';
  perform set_config('request.jwt.claims', '', true);
  update public.store_products set is_catalog_bestseller = false where id = pa1.id;
  assert not (select is_catalog_bestseller from public.store_products where id = pa1.id), 'the server (no user) sets the flag too';

  -- 8. Unlinking restores the role only when the last account goes, and never touches a platform admin.
  v_res := public.platform_link_store_account(v_b, 'clean-1@example.invalid', u_admin);
  v_acc_b := (v_res->>'account_id')::uuid;
  v_res := public.platform_unlink_store_account(v_acc_a, u_admin);
  assert not (v_res->>'role_back_to_customer')::boolean, 'one account is left, so the role stays';
  assert (select role from public.profiles where id = u_clean) = 'store_admin', 'still a store admin';
  v_res := public.platform_unlink_store_account(v_acc_b, u_admin);
  assert (v_res->>'role_back_to_customer')::boolean, 'the last unlink returns him to customer';
  assert (select role from public.profiles where id = u_clean) = 'customer', 'back to customer';
  assert pg_temp.fails_with(format('select public.platform_unlink_store_account(%L, %L)', v_acc_b, u_admin), 'Account not found'), 'an account is unlinked once';
  assert (select count(*) from public.platform_audit_log where action = 'store_account_unlinked' and actor_id = u_admin) = 2, 'both unlinks are in the audit log';
  assert (select count(*) from public.platform_audit_log where action = 'store_account_linked') = 3, 'every link is in the audit log';

  insert into public.store_accounts (store_id, user_id, role) values (v_a, u_admin, 'store_admin');
  perform public.platform_unlink_store_account((select id from public.store_accounts where user_id = u_admin), u_admin);
  assert (select role from public.profiles where id = u_admin) = 'platform_admin', 'a platform admin keeps his role after an unlink';

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
