begin;

-- Owner decision of 2026-10-29: the storefront records a visitor's device fingerprint and activity by default, with no
-- consent banner, and offers one choice in the privacy policy: refuse. A visitor who refuses has the fingerprint and every
-- activity record of that browser erased, and keeps browsing the shop as before.
--
-- forget_guest_browser erases what the two keyed hashes of one browser point to, nothing else:
--   guest_visitors (status 'guest' only) with its sessions, product events, searches and cart snapshot,
--   guest_fingerprints, guest_identity_links, guest_analytics_visits, guest_product_analytics.
-- Anything that belongs to a registered customer is never touched (owner rule of 2026-10-28): a visitor row that already
-- converted, the conversion record and the customer's own sessions, events and searches stay.
-- The keys are the keyed hashes the API derives from the browser key; the function is callable by service_role only.

create or replace function public.forget_guest_browser(p_fingerprint_hash text, p_analytics_hash text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $$
declare
  v_id uuid;
  v_n bigint := 0;
  v_b bigint;
  v_events bigint := 0;
  v_sessions bigint := 0;
  v_searches bigint := 0;
  v_visitors bigint := 0;
begin
  if coalesce(p_fingerprint_hash, '') !~ '^[a-f0-9]{64}$' or coalesce(p_analytics_hash, '') !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('forgotten', false);
  end if;

  select id into v_id from public.guest_visitors
  where fingerprint_hash = p_fingerprint_hash and status = 'guest'
  for update;
  if found then
    -- events and sessions first: their guest foreign key is ON DELETE SET NULL, which the exactly-one-actor check would refuse
    delete from public.customer_product_events where guest_id = v_id;
    get diagnostics v_events = row_count;
    delete from public.customer_sessions where guest_id = v_id;
    get diagnostics v_sessions = row_count;
    delete from public.customer_searches where guest_id = v_id;
    get diagnostics v_searches = row_count;
    delete from public.guest_visitors where id = v_id;
    get diagnostics v_visitors = row_count;
  end if;

  delete from public.guest_product_analytics where visitor_hash = p_analytics_hash;
  get diagnostics v_b = row_count; v_n := v_n + v_b;
  delete from public.guest_analytics_visits where visitor_hash = p_analytics_hash;
  get diagnostics v_b = row_count; v_n := v_n + v_b;
  delete from public.guest_fingerprints where analytics_hash = p_analytics_hash;
  get diagnostics v_b = row_count; v_n := v_n + v_b;
  delete from public.guest_identity_links where hash_a = p_analytics_hash or hash_b = p_analytics_hash;
  get diagnostics v_b = row_count; v_n := v_n + v_b;

  return jsonb_build_object('forgotten', true, 'visitors', v_visitors, 'events', v_events, 'sessions', v_sessions,
                            'searches', v_searches, 'signal_rows', v_n);
end;
$$;

revoke all on function public.forget_guest_browser(text, text) from public, anon, authenticated;
grant execute on function public.forget_guest_browser(text, text) to service_role;

comment on function public.forget_guest_browser(text, text) is 'Erases everything held about one unregistered visitor''s browser (guest-status visitor with its sessions, events, searches and cart snapshot, fingerprints, identity links and anonymous counters) when the visitor refuses tracking in the privacy policy. Never touches registered customers'' data. service_role only.';

commit;
