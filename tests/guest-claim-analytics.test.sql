-- Run against a scratch database that has supabase/pending/20261015100000_claim_removes_guest_analytics.sql applied.
-- Everything happens inside a transaction that is rolled back. Test data is fake.
begin;
do $$
declare
  fp text := repeat('a', 64);
  an text := repeat('b', 64);
  guest uuid;
  result jsonb;
  uid uuid;
  funnel jsonb;
begin
  insert into public.guest_visitors (fingerprint_hash, identity_version) values (fp, 2) returning id into guest;
  insert into public.guest_analytics_visits (visitor_hash, activity_date) values (an, current_date);
  select id into uid from public.profiles limit 1;
  if uid is null then raise notice 'no profile available in this scratch database, skipping'; return; end if;
  select public.claim_guest_browser_cart(fp, uid, an) into result;
  assert (result->>'claimed')::boolean, 'claim should succeed';
  assert not exists (select 1 from public.guest_analytics_visits where visitor_hash = an), 'guest visit row must be removed once the person is a customer';
  assert not exists (select 1 from public.guest_product_analytics where visitor_hash = an), 'guest product rows must be removed';
  assert not exists (select 1 from public.guest_visitors where id = guest), 'guest row must be removed';
  assert exists (select 1 from public.guest_conversions where visitor_hash = an and user_id = uid), 'the conversion must be recorded before the guest rows go';
  funnel := public.guest_funnel_summary('today');
  assert (funnel->>'convertedBrowsers')::int >= 1 and (funnel->>'newBrowsers')::int >= 1, 'funnel must count the converted browser';
end $$;
rollback;
