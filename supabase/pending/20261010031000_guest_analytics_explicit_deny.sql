-- PENDING: not applied to the live database yet. After it is applied, move it to supabase/migrations/
-- and rename it with the version the database recorded.
--
-- guest_analytics_visits and guest_product_analytics are written and read only by the server
-- (service_role bypasses RLS). They have RLS enabled but no policy, which the Supabase linter reports (0008).
-- State the intent explicitly: browser roles can never read or write these tables.
begin;
set local lock_timeout = '5s';

drop policy if exists guest_analytics_visits_no_client_access on public.guest_analytics_visits;
create policy guest_analytics_visits_no_client_access on public.guest_analytics_visits
  for all to anon, authenticated using (false) with check (false);

drop policy if exists guest_product_analytics_no_client_access on public.guest_product_analytics;
create policy guest_product_analytics_no_client_access on public.guest_product_analytics
  for all to anon, authenticated using (false) with check (false);

commit;
