-- Real-database test for supabase/pending/20261010031000_guest_analytics_explicit_deny.sql
-- Run AFTER the migration inside one transaction. Everything is rolled back; no data is created.
begin;

do $$
begin
  assert (select count(*) from pg_policies where schemaname = 'public'
            and tablename in ('guest_analytics_visits', 'guest_product_analytics')
            and policyname like '%no_client_access') = 2, 'both guest analytics tables have an explicit deny policy';
  assert not has_table_privilege('anon', 'public.guest_analytics_visits', 'SELECT'), 'anon cannot read guest_analytics_visits';
  assert not has_table_privilege('authenticated', 'public.guest_analytics_visits', 'SELECT'), 'signed-in users cannot read guest_analytics_visits';
  assert not has_table_privilege('anon', 'public.guest_product_analytics', 'SELECT'), 'anon cannot read guest_product_analytics';
  assert not has_table_privilege('authenticated', 'public.guest_product_analytics', 'SELECT'), 'signed-in users cannot read guest_product_analytics';
  assert has_table_privilege('service_role', 'public.guest_analytics_visits', 'SELECT'), 'the server keeps access';
  assert (select relrowsecurity from pg_class where oid = 'public.guest_analytics_visits'::regclass), 'RLS stays enabled';
  assert (select relrowsecurity from pg_class where oid = 'public.guest_product_analytics'::regclass), 'RLS stays enabled';
  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
