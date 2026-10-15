-- Run against a scratch database that has supabase/pending/20261015100000_claim_removes_guest_analytics.sql applied.
-- Everything happens inside a transaction that is rolled back. Test data is fake.
begin;
do $$
declare
  fp text := repeat('a', 64);
  an text := repeat('b', 64);
  guest uuid;
  result jsonb;
begin
  insert into public.guest_visitors (fingerprint_hash, identity_version) values (fp, 2) returning id into guest;
  insert into public.guest_analytics_visits (visitor_hash, activity_date) values (an, current_date);
  select public.claim_guest_browser_cart(fp, gen_random_uuid(), an) into result;
  assert (result->>'claimed')::boolean, 'claim should succeed';
  assert not exists (select 1 from public.guest_analytics_visits where visitor_hash = an), 'guest visit row must be removed once the person is a customer';
  assert not exists (select 1 from public.guest_product_analytics where visitor_hash = an), 'guest product rows must be removed';
  assert not exists (select 1 from public.guest_visitors where id = guest), 'guest row must be removed';
end $$;
rollback;
