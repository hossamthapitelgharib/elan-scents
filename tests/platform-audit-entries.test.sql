-- Real-database test for supabase/migrations/<version>_platform_audit_entries.sql
-- Run AFTER the migration, as the project owner, inside one transaction. Everything is rolled back.
-- The users are synthetic; one live store is only read.
begin;

do $$
declare
  u_admin constant uuid := 'b0000000-0000-4000-8000-0000000000f1';
  u_member constant uuid := 'b0000000-0000-4000-8000-0000000000f2';
  v_store uuid;
  v_store_name text;
  v_res jsonb;
  v_acc uuid;
  v_n integer;
  r record;
begin
  select id, name into v_store, v_store_name from public.stores order by name limit 1;
  assert v_store is not null, 'a live store exists to test with';

  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data)
  values (u_admin, 'authenticated', 'authenticated', 'audit-admin@example.invalid', now(), '{"full_name":"Audit Admin"}'::jsonb),
         (u_member, 'authenticated', 'authenticated', 'audit-member@example.invalid', now(), '{"full_name":"Audit Member"}'::jsonb);

  -- 1. Only the server may read it.
  assert not has_function_privilege('anon', 'public.platform_audit_entries(integer, integer)', 'execute'), 'anon cannot read the audit entries';
  assert not has_function_privilege('authenticated', 'public.platform_audit_entries(integer, integer)', 'execute'), 'signed-in users cannot read the audit entries';
  assert has_function_privilege('service_role', 'public.platform_audit_entries(integer, integer)', 'execute'), 'the server can';
  assert (select prosecdef and proconfig @> array['search_path=public, private, auth, pg_temp'] from pg_proc where oid = 'public.platform_audit_entries(integer, integer)'::regprocedure), 'security definer with a fixed search_path';

  -- 2. A link and an unlink show with the actor, the store and the account email.
  v_res := public.platform_link_store_account(v_store, 'audit-member@example.invalid', u_admin);
  v_acc := (v_res->>'account_id')::uuid;
  update public.platform_audit_log set created_at = now() - interval '2 minutes' where action = 'store_account_linked' and actor_id = u_admin;
  perform public.platform_unlink_store_account(v_acc, u_admin);

  select * into r from public.platform_audit_entries(1, 0);
  assert r.action = 'store_account_unlinked', 'the newest entry comes first';
  assert r.actor_email = 'audit-admin@example.invalid', 'the actor email is joined';
  assert r.store_id = v_store and r.store_name = v_store_name, 'the store is joined';
  assert r.subject_email = 'audit-member@example.invalid', 'the email of the account the action was about is joined';
  assert r.target_type = 'store_account' and r.target_id = v_acc, 'the target is the account';
  assert (r.details->>'role_back_to_customer')::boolean, 'the unlink details are kept';

  select * into r from public.platform_audit_entries(1, 1);
  assert r.action = 'store_account_linked', 'the offset moves to the older entry';
  assert r.details->>'previous_role' = 'customer', 'the link details are kept';

  -- 3. Page size and offset are clamped.
  select count(*) into v_n from public.platform_audit_entries(0, 0);
  assert v_n = 1, 'a page size of 0 is read as 1';
  select count(*) into v_n from public.platform_audit_entries(100000, 0);
  assert v_n <= 101, 'a huge page size is cut to 101';
  select count(*) into v_n from public.platform_audit_entries(null, null);
  assert v_n >= 2 and v_n <= 50, 'null means the first 50';
  select count(*) into v_n from public.platform_audit_entries(10, -5);
  assert v_n >= 2, 'a negative offset is read as 0';

  -- 4. A user that no longer exists, a store that no longer exists and a malformed id in the details never break it.
  delete from auth.users where id = u_member;
  select * into r from public.platform_audit_entries(1, 0);
  assert r.action = 'store_account_unlinked' and r.subject_email is null, 'a removed user shows no email';
  insert into public.platform_audit_log (actor_id, action, target_type, target_id, details, created_at)
  values (null, 'test_malformed', 'test', null, '{"store_id":"not-a-uuid","user_id":12}'::jsonb, now() + interval '1 minute'),
         (null, 'test_unknown_store', 'test', null, jsonb_build_object('store_id', gen_random_uuid(), 'user_id', gen_random_uuid()), now() + interval '2 minutes');
  select * into r from public.platform_audit_entries(1, 0);
  assert r.action = 'test_unknown_store' and r.store_name is null and r.subject_email is null and r.actor_email is null, 'unknown store and user give nulls';
  select * into r from public.platform_audit_entries(1, 1);
  assert r.action = 'test_malformed' and r.store_id is null, 'a malformed id gives nulls, not an error';

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
