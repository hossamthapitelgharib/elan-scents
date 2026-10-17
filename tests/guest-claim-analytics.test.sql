-- Run against a database that has supabase/migrations/20261017062830_customer_activity_totals_and_guest_cleanup_on_claim.sql applied.
-- Everything happens inside a transaction that is rolled back. Test data is fake (a throw-away auth user).
begin;
do $$
declare
  fp text := repeat('a', 64);
  an text := repeat('b', 64);
  uid uuid := gen_random_uuid();
  result jsonb;
  funnel jsonb;
begin
  insert into auth.users (id, email, aud, role) values (uid, 'test-' || uid || '@example.invalid', 'authenticated', 'authenticated');
  insert into public.profiles (id, role) values (uid, 'customer') on conflict (id) do update set role = 'customer';
  perform public.resolve_guest_browser(fp, an);
  perform public.guest_signal_store(an, repeat('1', 32), '{"gpu":"g","screen":"s"}'::jsonb, null, null, null, null, null, 1, 1, 1);
  assert exists (select 1 from public.guest_analytics_visits where visitor_hash = an), 'the guest visit exists before the claim';

  select public.claim_guest_browser_cart(fp, an, uid) into result;
  assert (result->>'claimed')::boolean, 'claim should succeed';
  assert not exists (select 1 from public.guest_analytics_visits where visitor_hash = an), 'guest visit row must be removed once the person is a customer';
  assert not exists (select 1 from public.guest_product_analytics where visitor_hash = an), 'guest product rows must be removed';
  assert not exists (select 1 from public.guest_fingerprints where analytics_hash = an), 'stored fingerprints must be removed';
  assert not exists (select 1 from public.guest_visitors where fingerprint_hash = fp), 'guest row must be removed';
  assert not exists (select 1 from public.guest_conversions where visitor_hash = an), 'the conversion must not keep the browser hash';
  assert exists (select 1 from public.guest_conversions where user_id = uid), 'the conversion must be recorded for the account';
  funnel := public.guest_funnel_summary('today');
  assert (funnel->>'convertedBrowsers')::int >= 1 and (funnel->>'newBrowsers')::int >= 1, 'funnel must count the converted browser';
end $$;
rollback;
