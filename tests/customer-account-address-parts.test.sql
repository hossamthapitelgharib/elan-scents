-- Real-database test for supabase/migrations/20261108072233_customer_details_address_parts.sql («حسابي»: city, building, floor and flat).
-- Run AFTER the migration, as the project owner, inside one transaction. Everything is rolled back.
-- The users are synthetic (example.invalid addresses); no real customer row is read or written.
begin;

do $$
declare
  u1 constant uuid := 'f0000000-0000-4000-8000-0000000000e1';
  u2 constant uuid := 'f0000000-0000-4000-8000-0000000000e2';
  v_row public.customer_details;
  v_count integer;
begin
  insert into auth.users (id, aud, role, email) values
    (u1, 'authenticated', 'authenticated', 'parts-one@example.invalid'),
    (u2, 'authenticated', 'authenticated', 'parts-two@example.invalid');

  -- 1. A row saved the old way (no parts at all) is still valid, and its parts are empty.
  insert into public.customer_details (user_id, full_name, phone, governorate, address)
  values (u2, 'خالد عمر سعيد إبراهيم', '01234567890', 'الجيزة', '5 شارع النيل، المعادي');
  select * into v_row from public.customer_details where user_id = u2;
  assert v_row.city is null and v_row.building_no is null and v_row.floor_no is null and v_row.apartment_no is null, 'an old row has no parts';
  assert v_row.ship_city is null and v_row.ship_building_no is null, 'its delivery parts are empty too';

  -- 2. The parts are tidied, and the delivery address copies them while it is "the same".
  insert into public.customer_details (user_id, full_name, phone, governorate, city, address, building_no, floor_no, apartment_no)
  values (u1, 'أحمد محمد علي حسن', '01012345678', 'القاهرة', '  مدينة   نصر ', 'شارع عباس العقاد', ' 12 أ ', ' 3 ', '  ');
  select * into v_row from public.customer_details where user_id = u1;
  assert v_row.city = 'مدينة نصر', 'the city is trimmed and its spaces collapsed';
  assert v_row.building_no = '12 أ' and v_row.floor_no = '3', 'building and floor are trimmed';
  assert v_row.apartment_no is null, 'a blank flat becomes null';
  assert v_row.ship_same and v_row.ship_city = v_row.city and v_row.ship_building_no = v_row.building_no
    and v_row.ship_floor_no = v_row.floor_no and v_row.ship_apartment_no is null, 'the delivery parts copy the home parts';

  -- 3. A separate delivery address keeps its own parts; the home ones are untouched.
  update public.customer_details set
    ship_same = false, ship_governorate = 'الجيزة', ship_city = ' الدقي ', ship_address = 'شارع التحرير',
    ship_building_no = ' 7 ', ship_floor_no = '', ship_apartment_no = ' 14 '
  where user_id = u1;
  select * into v_row from public.customer_details where user_id = u1;
  assert not v_row.ship_same and v_row.ship_city = 'الدقي' and v_row.ship_building_no = '7' and v_row.ship_apartment_no = '14', 'own delivery parts are kept, tidied';
  assert v_row.ship_floor_no is null, 'a blank delivery floor becomes null';
  assert v_row.city = 'مدينة نصر' and v_row.building_no = '12 أ' and v_row.floor_no = '3', 'the home parts are untouched';

  -- 4. "Same address" again overwrites the delivery parts with the home ones, whatever was sent.
  update public.customer_details set ship_same = true, ship_city = 'ignored', ship_building_no = '999' where user_id = u1;
  select * into v_row from public.customer_details where user_id = u1;
  assert v_row.ship_city = 'مدينة نصر' and v_row.ship_building_no = '12 أ' and v_row.ship_floor_no = '3' and v_row.ship_apartment_no is null, 'copied again';

  -- 5. Values the page would never send are refused by the table itself.
  begin update public.customer_details set city = repeat('c', 81) where user_id = u1; assert false, 'a city has a limit'; exception when check_violation then null; end;
  begin update public.customer_details set building_no = repeat('9', 21) where user_id = u1; assert false, 'a building number has a limit'; exception when check_violation then null; end;
  begin update public.customer_details set floor_no = repeat('9', 21) where user_id = u1; assert false, 'a floor has a limit'; exception when check_violation then null; end;
  begin update public.customer_details set apartment_no = repeat('9', 21) where user_id = u1; assert false, 'a flat has a limit'; exception when check_violation then null; end;
  begin update public.customer_details set ship_same = false, ship_city = repeat('c', 81) where user_id = u1; assert false, 'a delivery city has a limit'; exception when check_violation then null; end;
  begin update public.customer_details set ship_same = false, ship_floor_no = repeat('9', 21) where user_id = u1; assert false, 'a delivery floor has a limit'; exception when check_violation then null; end;

  -- 6. A signed-in customer writes the parts of his own row only, with the same grants as before.
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.customer_details set city = 'الشروق', building_no = '4', floor_no = '2', apartment_no = '8' where user_id = u1;
  get diagnostics v_count = row_count;
  assert v_count = 1, 'a customer edits the parts of his own row';
  update public.customer_details set city = 'مخترق' where user_id = u2;
  get diagnostics v_count = row_count;
  assert v_count = 0, 'a customer cannot edit another customer''s parts';
  insert into public.customer_details (user_id, full_name, phone, address, city, building_no)
  values (u1, 'هاني سمير فؤاد مراد', '01099998888', 'عنوان جديد بالتفصيل الكامل', 'القاهرة الجديدة', '10')
  on conflict (user_id) do update set city = excluded.city, building_no = excluded.building_no;
  select * into v_row from public.customer_details where user_id = u1;
  assert v_row.city = 'القاهرة الجديدة' and v_row.building_no = '10' and v_row.ship_city = 'القاهرة الجديدة', 'the page''s upsert carries the parts (the delivery copy follows)';
  reset role;
end $$;

rollback;
