-- Real-database test for supabase/migrations/<version>_customer_mail_log.sql
-- Run AFTER the migration, as the project owner, inside one transaction. Everything is rolled back.
-- The users are synthetic (example.invalid addresses).
begin;

do $$
declare
  u1 constant uuid := 'c0000000-0000-4000-8000-0000000000b1';
  u2 constant uuid := 'c0000000-0000-4000-8000-0000000000b2';
  v boolean;
  v_count integer;
begin
  insert into auth.users (id, aud, role, email) values
    (u1, 'authenticated', 'authenticated', 'mail-one@example.invalid'),
    (u2, 'authenticated', 'authenticated', 'mail-two@example.invalid');

  -- 1. Locked down: RLS on, no table or function access for the browser roles, access for the server role.
  assert (select relrowsecurity from pg_class where oid = 'public.customer_mail_log'::regclass), 'row level security is on';
  assert not has_table_privilege('anon', 'public.customer_mail_log', 'select, insert, update, delete'), 'anon has no table access';
  assert not has_table_privilege('authenticated', 'public.customer_mail_log', 'select, insert, update, delete'), 'authenticated has no table access';
  assert has_table_privilege('service_role', 'public.customer_mail_log', 'select, insert, update, delete'), 'the server role can use the table';
  assert not has_function_privilege('anon', 'public.claim_customer_mail(uuid, text, interval)', 'execute'), 'anon cannot claim';
  assert not has_function_privilege('authenticated', 'public.claim_customer_mail(uuid, text, interval)', 'execute'), 'authenticated cannot claim';
  assert not has_function_privilege('anon', 'public.release_customer_mail(uuid, text)', 'execute'), 'anon cannot release';
  assert not has_function_privilege('authenticated', 'public.release_customer_mail(uuid, text)', 'execute'), 'authenticated cannot release';
  assert has_function_privilege('service_role', 'public.claim_customer_mail(uuid, text, interval)', 'execute'), 'the server role can claim';
  assert has_function_privilege('service_role', 'public.release_customer_mail(uuid, text)', 'execute'), 'the server role can release';

  -- 2. The first claim wins, the second inside the interval does not.
  v := public.claim_customer_mail(u1, 'login', interval '12 hours');
  assert v = true, 'the first claim is granted';
  v := public.claim_customer_mail(u1, 'login', interval '12 hours');
  assert v = false, 'a second claim inside the interval is refused';

  -- 3. Kinds and customers are independent.
  assert public.claim_customer_mail(u1, 'logout', interval '12 hours') = true, 'logout has its own slot';
  assert public.claim_customer_mail(u2, 'login', interval '12 hours') = true, 'another customer has their own slot';

  -- 4. After the interval has passed the slot opens again (the stored time is moved back instead of sleeping).
  update public.customer_mail_log set sent_at = now() - interval '13 hours' where user_id = u1 and kind = 'login';
  assert public.claim_customer_mail(u1, 'login', interval '12 hours') = true, 'a claim after the interval is granted';
  assert public.claim_customer_mail(u1, 'login', interval '12 hours') = false, 'and it closes the slot again';
  select count(*) into v_count from public.customer_mail_log where user_id = u1 and kind = 'login';
  assert v_count = 1, 'still one row per customer and kind';

  -- 5. A failed send gives the slot back.
  perform public.release_customer_mail(u1, 'login');
  assert public.claim_customer_mail(u1, 'login', interval '12 hours') = true, 'a released slot can be claimed again';

  -- 6. «registered» is once per account for good.
  assert public.claim_customer_mail(u1, 'registered', interval '100 years') = true, 'the registered notice is claimed once';
  update public.customer_mail_log set sent_at = now() - interval '5 years' where user_id = u1 and kind = 'registered';
  assert public.claim_customer_mail(u1, 'registered', interval '100 years') = false, 'and not again, even years later';

  -- 7. An unknown kind is refused and leaves no row.
  begin
    perform public.claim_customer_mail(u1, 'promo', interval '1 hour');
    assert false, 'an unknown kind must be refused';
  exception when sqlstate '22023' then null;
  end;
  begin
    insert into public.customer_mail_log (user_id, kind) values (u2, 'promo');
    assert false, 'the table must refuse an unknown kind';
  exception when check_violation then null;
  end;

  -- 8. A signed-in customer cannot read or call anything here.
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform 1 from public.customer_mail_log;
    reset role;
    assert false, 'a customer must not read the mail log';
  exception when insufficient_privilege then
    reset role;
  end;
  set local role authenticated;
  begin
    perform public.claim_customer_mail(u1, 'login', interval '0 seconds');
    reset role;
    assert false, 'a customer must not call the claim function';
  exception when insufficient_privilege then
    reset role;
  end;
  set local role anon;
  begin
    perform public.release_customer_mail(u1, 'login');
    reset role;
    assert false, 'a visitor must not call the release function';
  exception when insufficient_privilege then
    reset role;
  end;

  -- 9. The rows go with the account.
  delete from auth.users where id = u1;
  select count(*) into v_count from public.customer_mail_log where user_id = u1;
  assert v_count = 0, 'deleting the account deletes its mail log rows';
end $$;

rollback;
