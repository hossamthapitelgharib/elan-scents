-- Real-database test for supabase/migrations/20261105073319_customer_mail_welcome_kind.sql.
-- Run AFTER the migration, as the project owner, inside one transaction. Everything is rolled back. The users are synthetic (example.invalid).
begin;

do $$
declare
  u1 constant uuid := 'c0000000-0000-4000-8000-0000000000c1';
  u2 constant uuid := 'c0000000-0000-4000-8000-0000000000c2';
  v_count integer;
begin
  insert into auth.users (id, aud, role, email) values
    (u1, 'authenticated', 'authenticated', 'welcome-one@example.invalid'),
    (u2, 'authenticated', 'authenticated', 'welcome-two@example.invalid');

  -- 1. The welcome is claimed once per account, for good, and independently of the other kinds and of other customers.
  assert public.claim_customer_mail(u1, 'welcome', interval '100 years') = true, 'the first welcome claim is granted';
  update public.customer_mail_log set sent_at = now() - interval '5 years' where user_id = u1 and kind = 'welcome';
  assert public.claim_customer_mail(u1, 'welcome', interval '100 years') = false, 'and never again, even years later';
  assert public.claim_customer_mail(u1, 'registered', interval '100 years') = true, 'the platform notice has its own slot';
  assert public.claim_customer_mail(u2, 'welcome', interval '100 years') = true, 'another customer is welcomed too';
  select count(*) into v_count from public.customer_mail_log where user_id = u1 and kind = 'welcome';
  assert v_count = 1, 'one welcome row per customer';

  -- 2. A failed send gives the slot back.
  perform public.release_customer_mail(u2, 'welcome');
  assert public.claim_customer_mail(u2, 'welcome', interval '100 years') = true, 'a released welcome can be claimed again';

  -- 3. The old kinds still work (their rows exist) and an unknown kind is still refused, by the function and by the table.
  assert public.claim_customer_mail(u1, 'login', interval '30 minutes') = true, 'login kind is still accepted';
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

  -- 4. Still server-only: replacing the function must not have opened it to the browser roles.
  assert not has_function_privilege('anon', 'public.claim_customer_mail(uuid, text, interval)', 'execute'), 'anon cannot claim';
  assert not has_function_privilege('authenticated', 'public.claim_customer_mail(uuid, text, interval)', 'execute'), 'authenticated cannot claim';
  assert has_function_privilege('service_role', 'public.claim_customer_mail(uuid, text, interval)', 'execute'), 'the server role can claim';
  assert not has_table_privilege('authenticated', 'public.customer_mail_log', 'select, insert, update, delete'), 'authenticated has no table access';

  -- 5. The rows go with the account.
  delete from auth.users where id in (u1, u2);
  select count(*) into v_count from public.customer_mail_log where user_id in (u1, u2);
  assert v_count = 0, 'deleting the account deletes its mail log rows';
end $$;

rollback;
