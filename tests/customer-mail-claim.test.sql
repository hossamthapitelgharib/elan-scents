-- Real-database test for supabase/migrations/20261113141111_customer_mail_claims.sql.
-- Run after applying that migration, as the project owner. The entire test rolls back.
-- All fixture accounts and addresses are synthetic; no live mail is sent.
begin;

do $customer_mail_claim_fixture$
declare
  u1 constant uuid := 'c0000000-0000-4000-8000-0000000000d1';
  u2 constant uuid := 'c0000000-0000-4000-8000-0000000000d2';
  token1 constant uuid := 'd0000000-0000-4000-8000-000000000001';
  token2 constant uuid := 'd0000000-0000-4000-8000-000000000002';
  token3 constant uuid := 'd0000000-0000-4000-8000-000000000003';
  v_count integer;
begin
  insert into auth.users (id, aud, role, email) values
    (u1, 'authenticated', 'authenticated', 'mail-claim-one@example.invalid'),
    (u2, 'authenticated', 'authenticated', 'mail-claim-two@example.invalid');

  -- Server-only storage and RPC surface.
  assert (select relrowsecurity from pg_class where oid = 'public.customer_mail_claims'::regclass), 'RLS is enabled';
  assert not has_table_privilege('anon', 'public.customer_mail_claims', 'select, insert, update, delete'), 'anon cannot access claims';
  assert not has_table_privilege('authenticated', 'public.customer_mail_claims', 'select, insert, update, delete'), 'customers cannot access claims';
  assert has_table_privilege('service_role', 'public.customer_mail_claims', 'select, insert, update, delete'), 'service_role can manage claims';
  assert not has_function_privilege('anon', 'public.claim_customer_mail(uuid, text, uuid, interval)', 'execute'), 'anon cannot claim';
  assert not has_function_privilege('authenticated', 'public.claim_customer_mail(uuid, text, uuid, interval)', 'execute'), 'customers cannot claim';
  assert has_function_privilege('service_role', 'public.claim_customer_mail(uuid, text, uuid, interval)', 'execute'), 'service_role can claim';

  -- Two competing requests for the same account/kind: exactly one live lease wins.
  assert public.claim_customer_mail(u1, 'welcome', token1, interval '5 minutes'), 'first claim succeeds';
  assert not public.claim_customer_mail(u1, 'welcome', token2, interval '5 minutes'), 'a competing live claim is refused';
  select count(*) into v_count from public.customer_mail_log where user_id = u1 and kind = 'welcome';
  assert v_count = 0, 'claiming alone does not record a sent mail';

  -- A stale token can neither complete nor release the current lease.
  assert not public.complete_customer_mail(u1, 'welcome', token2), 'wrong-token completion fails';
  assert not public.release_customer_mail(u1, 'welcome', token2), 'wrong-token release fails';
  assert (select claim_token = token1 from public.customer_mail_claims where user_id = u1 and kind = 'welcome'), 'the original lease remains intact';

  -- The lease expiry permits takeover; an old sender cannot alter the newer claim.
  update public.customer_mail_claims
    set lease_expires_at = clock_timestamp() - interval '1 second'
    where user_id = u1 and kind = 'welcome' and claim_token = token1;
  assert public.claim_customer_mail(u1, 'welcome', token2, interval '5 minutes'), 'expired lease is taken over';
  assert not public.complete_customer_mail(u1, 'welcome', token1), 'stale sender cannot complete takeover';
  assert not public.release_customer_mail(u1, 'welcome', token1), 'stale sender cannot release takeover';
  assert (select claim_token = token2 from public.customer_mail_claims where user_id = u1 and kind = 'welcome'), 'takeover token is unchanged';

  -- The current lease completes successfully and produces the durable sent record.
  assert public.complete_customer_mail(u1, 'welcome', token2), 'current sender completes';
  assert not public.claim_customer_mail(u1, 'welcome', token3, interval '5 minutes'), 'a completed welcome can never be claimed again';
  assert (select count(*) = 1 from public.customer_mail_log where user_id = u1 and kind = 'welcome'), 'one successful send is recorded';
  assert (select completed_at is not null from public.customer_mail_claims where user_id = u1 and kind = 'welcome'), 'completed claim remains marked complete';
  assert not public.release_customer_mail(u1, 'welcome', token2), 'a completed claim cannot be released';

  -- A failed SMTP send is represented by release, which allows another attempt.
  assert public.claim_customer_mail(u2, 'registered', token1, interval '5 minutes'), 'failed-send fixture claim succeeds';
  assert not public.complete_customer_mail(u2, 'registered', token2), 'a completion using the wrong token fails';
  assert public.release_customer_mail(u2, 'registered', token1), 'the sender releases its own failed attempt';
  assert public.claim_customer_mail(u2, 'registered', token3, interval '5 minutes'), 'released attempt can be retried';
  assert not exists (select 1 from public.customer_mail_log where user_id = u2 and kind = 'registered'), 'an unsent/released attempt is not recorded as sent';

  -- Unknown event kinds and excessive/zero leases are rejected.
  begin
    perform public.claim_customer_mail(u2, 'promo', token1, interval '5 minutes');
    assert false, 'unknown mail kind must fail';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.claim_customer_mail(u2, 'welcome', token1, interval '0 seconds');
    assert false, 'non-positive lease must fail';
  exception when sqlstate '22023' then null;
  end;

  delete from auth.users where id in (u1, u2);
  assert not exists (select 1 from public.customer_mail_claims where user_id in (u1, u2)), 'claim rows cascade with synthetic accounts';
  assert not exists (select 1 from public.customer_mail_log where user_id in (u1, u2)), 'sent rows cascade with synthetic accounts';
end
$customer_mail_claim_fixture$;

rollback;
