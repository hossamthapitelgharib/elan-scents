-- Real-database test for supabase/migrations/<version>_customer_registered_notification.sql
-- Run AFTER the migration, as the project owner, inside one transaction. Everything is rolled back.
-- The users are synthetic (example.invalid addresses).
begin;

do $$
declare
  u_named constant uuid := 'b0000000-0000-4000-8000-0000000000a1';
  u_bare constant uuid := 'b0000000-0000-4000-8000-0000000000a2';
  u_long constant uuid := 'b0000000-0000-4000-8000-0000000000a3';
  u_fail constant uuid := 'b0000000-0000-4000-8000-0000000000a4';
  n record;
  v_count integer;
begin
  -- 1. A sign-up with a name: one notification for the platform admins, with the name and the e-mail.
  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (u_named, 'authenticated', 'authenticated', 'reg-named@example.invalid', '{"full_name":"Test Buyer <b>x</b>"}'::jsonb);
  select count(*) into v_count from public.notifications where payload->>'customer_id' = u_named::text;
  assert v_count = 1, 'one sign-up writes exactly one notification';
  select * into n from public.notifications where payload->>'customer_id' = u_named::text;
  assert n.recipient_role = 'platform_admin' and n.user_id is null, 'it is addressed to the platform admins, not to a user';
  assert n.type = 'customer_registered', 'it has its own type';
  assert n.title = 'تم تسجيل عميل جديد بنجاح', 'the title says a customer registered';
  assert n.body = 'Test Buyer <b>x</b> — reg-named@example.invalid', 'the body carries the name and the e-mail (the dashboard escapes it)';
  assert n.is_read = false, 'it starts unread';
  assert exists (select 1 from public.profiles where id = u_named and role = 'customer'), 'the profile is still created as a customer';

  -- 2. A sign-up without a name: the body is the e-mail alone.
  insert into auth.users (id, aud, role, email) values (u_bare, 'authenticated', 'authenticated', 'reg-bare@example.invalid');
  select * into n from public.notifications where payload->>'customer_id' = u_bare::text;
  assert n.body = 'reg-bare@example.invalid', 'no name: just the e-mail, no stray separator';

  -- 3. A very long name is cut to 120, as in the profile.
  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (u_long, 'authenticated', 'authenticated', 'reg-long@example.invalid', jsonb_build_object('full_name', repeat('م', 500)));
  select * into n from public.notifications where payload->>'customer_id' = u_long::text;
  assert char_length(n.body) = 120 + 3 + char_length('reg-long@example.invalid'), 'the name in the notification is cut to 120 characters';

  -- 4. The notice can never make a sign-up fail: with the notifications table refusing every row, the account and profile still appear.
  alter table public.notifications add constraint tmp_refuse_all check (false) not valid;
  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (u_fail, 'authenticated', 'authenticated', 'reg-fail@example.invalid', '{"full_name":"Still Works"}'::jsonb);
  assert exists (select 1 from auth.users where id = u_fail), 'the account is created even when the notice cannot be written';
  assert exists (select 1 from public.profiles where id = u_fail and full_name = 'Still Works'), 'and so is its profile';
  select count(*) into v_count from public.notifications where payload->>'customer_id' = u_fail::text;
  assert v_count = 0, 'no notification was written (the table refused it)';
  alter table public.notifications drop constraint tmp_refuse_all;

  -- 5. A signed-in customer cannot read the platform notifications (browsers have no grant on the table at all; the server reads it).
  perform set_config('request.jwt.claims', json_build_object('sub', u_named, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform 1 from public.notifications where recipient_role = 'platform_admin';
    reset role;
    assert false, 'a customer must not be able to read the notifications table';
  exception when insufficient_privilege then
    reset role;
  end;
end $$;

rollback;
