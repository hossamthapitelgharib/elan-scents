-- Real-database test for supabase/migrations/20261106211851_customer_account_details.sql («حسابي»: the customer's saved delivery details).
-- Run AFTER the migration, as the project owner, inside one transaction. Everything is rolled back.
-- The users are synthetic (example.invalid addresses); no real customer row is read or written.
begin;

do $$
declare
  u1 constant uuid := 'f0000000-0000-4000-8000-0000000000e1';
  u2 constant uuid := 'f0000000-0000-4000-8000-0000000000e2';
  v_row public.customer_details;
  v_count integer;
  v_created timestamptz;
begin
  insert into auth.users (id, aud, role, email) values
    (u1, 'authenticated', 'authenticated', 'details-one@example.invalid'),
    (u2, 'authenticated', 'authenticated', 'details-two@example.invalid');

  -- 1. The smallest row (no delivery columns at all): text is tidied and the delivery address is a copy of the home address.
  insert into public.customer_details (user_id, full_name, phone, governorate, address, address_lat, address_lng)
  values (u1, '  أحمد   محمد  علي حسن ', '010 1234-5678', ' القاهرة ', '  12 شارع التحرير، الدقي  ', 30.0381, 31.2101);
  select * into v_row from public.customer_details where user_id = u1;
  assert v_row.full_name = 'أحمد محمد علي حسن', 'the name is trimmed and its spaces collapsed';
  assert v_row.phone = '01012345678', 'spaces and dashes leave the phone';
  assert v_row.governorate = 'القاهرة' and v_row.address = '12 شارع التحرير، الدقي', 'text is trimmed';
  assert v_row.ship_same and v_row.ship_address = v_row.address and v_row.ship_governorate = v_row.governorate, 'the delivery address copies the home address';
  assert v_row.ship_lat = v_row.address_lat and v_row.ship_lng = v_row.address_lng, 'the delivery point copies the home point';
  assert v_row.recipient_name is null and v_row.recipient_phone is null and v_row.delivery_notes is null, 'the optional columns stay empty';
  v_created := v_row.created_at;

  -- 2. A different delivery address and another recipient; empty optional text becomes null; the owner and the creation time cannot be set.
  update public.customer_details set
    ship_same = false, ship_governorate = 'الجيزة', ship_address = ' 5 شارع النيل، المعادي ', ship_lat = null, ship_lng = null,
    recipient_name = '  منى   سيد ', recipient_phone = '+20 111 222 3334', delivery_notes = '   ',
    created_at = '2000-01-01', user_id = u2
  where user_id = u1;
  select * into v_row from public.customer_details where user_id = u1;
  assert found, 'the row still belongs to its owner';
  assert not exists (select 1 from public.customer_details where user_id = u2), 'the owner cannot be changed';
  assert v_row.created_at = v_created, 'the creation time cannot be changed';
  assert not v_row.ship_same and v_row.ship_address = '5 شارع النيل، المعادي' and v_row.ship_governorate = 'الجيزة', 'a separate delivery address is kept';
  assert v_row.address = '12 شارع التحرير، الدقي', 'the home address is untouched';
  assert v_row.recipient_name = 'منى سيد' and v_row.recipient_phone = '+201112223334', 'the recipient is tidied';
  assert v_row.delivery_notes is null, 'blank notes become null';

  -- 3. Switching back to "same address" copies it again, whatever delivery text was sent.
  update public.customer_details set ship_same = true, ship_address = 'ignored by the trigger' where user_id = u1;
  select * into v_row from public.customer_details where user_id = u1;
  assert v_row.ship_address = v_row.address and v_row.ship_lat = v_row.address_lat, 'same address again';

  -- 4. Values the page would never send are refused by the table itself.
  begin update public.customer_details set phone = 'abc' where user_id = u1; assert false, 'a phone must be digits'; exception when check_violation then null; end;
  begin update public.customer_details set phone = '' where user_id = u1; assert false, 'a phone is required'; exception when check_violation then null; end;
  begin update public.customer_details set full_name = ' ' where user_id = u1; assert false, 'a name is required'; exception when check_violation then null; end;
  begin update public.customer_details set address = 'abc' where user_id = u1; assert false, 'an address needs real text'; exception when check_violation then null; end;
  begin update public.customer_details set address = repeat('x', 301) where user_id = u1; assert false, 'an address has a limit'; exception when check_violation then null; end;
  begin update public.customer_details set address_lat = 30.1, address_lng = null where user_id = u1; assert false, 'a point needs both numbers'; exception when check_violation then null; end;
  begin update public.customer_details set address_lat = 91, address_lng = 31 where user_id = u1; assert false, 'a latitude is within 90'; exception when check_violation then null; end;
  begin update public.customer_details set address_lat = 30, address_lng = 181 where user_id = u1; assert false, 'a longitude is within 180'; exception when check_violation then null; end;
  begin update public.customer_details set recipient_phone = 'x1' where user_id = u1; assert false, 'a recipient phone must be digits'; exception when check_violation then null; end;
  begin update public.customer_details set recipient_name = 'a' where user_id = u1; assert false, 'a recipient name needs two letters'; exception when check_violation then null; end;
  begin update public.customer_details set delivery_notes = repeat('n', 501) where user_id = u1; assert false, 'notes have a limit'; exception when check_violation then null; end;
  begin update public.customer_details set ship_same = false, ship_address = ' ' where user_id = u1; assert false, 'a separate delivery address needs text'; exception when check_violation then null; end;
  begin insert into public.customer_details (user_id, full_name, phone, address) values (u1, 'a b c d', '01012345678', 'عنوان طويل بما يكفي'); assert false, 'one row per customer'; exception when unique_violation then null; end;
  begin insert into public.customer_details (user_id, full_name, phone, address) values (null, 'a b c d', '01012345678', 'عنوان طويل بما يكفي'); assert false, 'a row needs an owner'; exception when not_null_violation then null; end;

  -- 5. The other customer's row, made as the owner, to test the walls.
  insert into public.customer_details (user_id, full_name, phone, address, delivery_notes)
  values (u2, 'خالد عمر سعيد إبراهيم', '01234567890', 'العنوان السري للعميل الثاني', 'private note');

  -- 6. A signed-in customer reads and writes only his own row, as through the public API.
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_count from public.customer_details;
  assert v_count = 1, 'a customer sees only his own details';
  select count(*) into v_count from public.customer_details where user_id = u2;
  assert v_count = 0, 'the other customer''s row is invisible';
  update public.customer_details set full_name = 'هاني  سمير  فؤاد  مراد' where user_id = u1;
  get diagnostics v_count = row_count;
  assert v_count = 1, 'a customer edits his own row';
  update public.customer_details set full_name = 'تغيير غير مسموح به' where user_id = u2;
  get diagnostics v_count = row_count;
  assert v_count = 0, 'a customer cannot edit another customer''s row';
  reset role;
end $$;

do $$
declare
  u1 constant uuid := 'f0000000-0000-4000-8000-0000000000e1';
  u2 constant uuid := 'f0000000-0000-4000-8000-0000000000e2';
  v_count integer;
  v_name text;
begin
  -- the rows of the first block are still here (same transaction); continue as customer one
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 7. The page saves with one upsert (insert … on conflict do update); it works on his own row.
  insert into public.customer_details (user_id, full_name, phone, address)
  values (u1, 'هاني سمير فؤاد مراد', '01099998888', 'عنوان جديد بالتفصيل الكامل')
  on conflict (user_id) do update set full_name = excluded.full_name, phone = excluded.phone, address = excluded.address;
  select full_name into v_name from public.customer_details where user_id = u1;
  assert v_name = 'هاني سمير فؤاد مراد', 'the upsert updated his own row';

  -- 8. ...but it can never write or take over someone else's row.
  begin
    insert into public.customer_details (user_id, full_name, phone, address)
    values (u2, 'اختراق اسم العميل', '01000000000', 'عنوان مزيف لعميل آخر')
    on conflict (user_id) do update set full_name = excluded.full_name;
    reset role;
    assert false, 'an upsert must not touch another customer''s row';
  exception when insufficient_privilege then
    reset role;
  end;
  select full_name into v_name from public.customer_details where user_id = u2;
  assert v_name = 'خالد عمر سعيد إبراهيم', 'the other customer''s name is unchanged';

  -- 9. Nobody deletes details through the API, and visitors have no access.
  set local role authenticated;
  begin delete from public.customer_details where user_id = u1; reset role; assert false, 'no delete for clients'; exception when insufficient_privilege then reset role; end;
  perform set_config('request.jwt.claims', '{}', true);
  set local role anon;
  begin perform 1 from public.customer_details; reset role; assert false, 'a visitor must not read'; exception when insufficient_privilege then reset role; end;
  set local role anon;
  begin
    insert into public.customer_details (user_id, full_name, phone, address) values (u1, 'a b c d', '01012345678', 'عنوان طويل بما يكفي');
    reset role; assert false, 'a visitor must not write';
  exception when insufficient_privilege then reset role; end;

  -- 10. Removing the account removes the details.
  delete from auth.users where id = u1;
  select count(*) into v_count from public.customer_details where user_id = u1;
  assert v_count = 0, 'the details go with the account';
end $$;

rollback;
