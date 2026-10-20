begin;

-- Owner decision (2026-10-20): a guest's counters end with the guest. A guest who stays unregistered for 400 days is
-- deleted completely with every event, and that includes the guest's rows in the two guest counter tables, so the
-- guest numbers fall and the combined (guests + registered) numbers fall with them. (A guest who registers is already
-- handled by claim_guest_browser_cart: the events move to the account, the guest's counter rows are deleted, so the
-- combined numbers stay the same.) Registered customers' data and the best-sellers numbers are not touched.
--
-- Replaces purge_expired_guest_fingerprints (last defined by 20261019105404) with the same behaviour plus one step:
--   guest_analytics_visits, guest_product_analytics  all rows of a browser (visitor_hash) with nothing seen for 400 days
-- Nothing else changes. The daily pg_cron job 'guest-fingerprint-retention-400d' keeps calling the function by name.

create index if not exists guest_analytics_visits_last_seen_idx on public.guest_analytics_visits (last_seen_at);
create index if not exists guest_product_analytics_last_seen_idx on public.guest_product_analytics (last_seen_at);

create or replace function public.purge_expired_guest_fingerprints(p_retention interval default interval '400 days')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cutoff timestamptz;
  v_batch integer;
  v_ids uuid[];
  v_fingerprints bigint := 0;
  v_links bigint := 0;
  v_visitors bigint := 0;
  v_events bigint := 0;
  v_sessions bigint := 0;
  v_hashes text[];
  v_counter_visits bigint := 0;
  v_counter_products bigint := 0;
begin
  -- A guard against a typo turning this into "delete everything": nothing shorter than 30 days is accepted.
  if p_retention is null or p_retention < interval '30 days' then
    raise exception 'guest retention must be at least 30 days' using errcode = '22023';
  end if;
  v_cutoff := now() - p_retention;

  -- The anonymous counters of a browser that has shown no sign of life for the whole period go with the guest.
  -- A browser is alive while any of its counter rows or stored fingerprints was seen inside the period; once it
  -- is not, every one of its days is deleted together, never only the old days of a guest who is still active.
  loop
    select coalesce(array_agg(h), array[]::text[]) into v_hashes from (
      select c.h from (
        select visitor_hash as h from public.guest_analytics_visits where last_seen_at < v_cutoff
        union
        select visitor_hash from public.guest_product_analytics where last_seen_at < v_cutoff
      ) c
      where not exists (select 1 from public.guest_analytics_visits x where x.visitor_hash = c.h and x.last_seen_at >= v_cutoff)
        and not exists (select 1 from public.guest_product_analytics x where x.visitor_hash = c.h and x.last_seen_at >= v_cutoff)
        and not exists (select 1 from public.guest_fingerprints x where x.analytics_hash = c.h and x.last_seen_at >= v_cutoff)
      limit 1000
    ) s;
    exit when cardinality(v_hashes) = 0;
    delete from public.guest_product_analytics where visitor_hash = any(v_hashes);
    get diagnostics v_batch = row_count;
    v_counter_products := v_counter_products + v_batch;
    delete from public.guest_analytics_visits where visitor_hash = any(v_hashes);
    get diagnostics v_batch = row_count;
    v_counter_visits := v_counter_visits + v_batch;
  end loop;

  loop
    with expired as (
      select ctid from public.guest_fingerprints where last_seen_at < v_cutoff order by last_seen_at limit 1000
    )
    delete from public.guest_fingerprints g using expired where g.ctid = expired.ctid;
    get diagnostics v_batch = row_count;
    v_fingerprints := v_fingerprints + v_batch;
    exit when v_batch < 1000;
  end loop;

  loop
    with expired as (
      select ctid from public.guest_identity_links where last_confirmed_at < v_cutoff order by last_confirmed_at limit 1000
    )
    delete from public.guest_identity_links l using expired where l.ctid = expired.ctid;
    get diagnostics v_batch = row_count;
    v_links := v_links + v_batch;
    exit when v_batch < 1000;
  end loop;

  loop
    select coalesce(array_agg(id), array[]::uuid[]) into v_ids from (
      select id from public.guest_visitors where status = 'guest' and last_seen_at < v_cutoff order by last_seen_at limit 1000
    ) s;
    exit when cardinality(v_ids) = 0;
    delete from public.customer_product_events where guest_id = any(v_ids);
    get diagnostics v_batch = row_count;
    v_events := v_events + v_batch;
    delete from public.customer_sessions where guest_id = any(v_ids);
    get diagnostics v_batch = row_count;
    v_sessions := v_sessions + v_batch;
    delete from public.guest_visitors where id = any(v_ids);
    get diagnostics v_batch = row_count;
    v_visitors := v_visitors + v_batch;
  end loop;

  return jsonb_build_object('guest_fingerprints', v_fingerprints, 'guest_identity_links', v_links, 'guest_visitors', v_visitors,
                            'guest_product_events', v_events, 'guest_sessions', v_sessions,
                            'guest_counter_visit_rows', v_counter_visits, 'guest_counter_product_rows', v_counter_products);
end;
$$;

revoke all on function public.purge_expired_guest_fingerprints(interval) from public, anon, authenticated;
grant execute on function public.purge_expired_guest_fingerprints(interval) to service_role;

comment on function public.purge_expired_guest_fingerprints(interval) is 'Deletes guests not seen for 400 days (default) with everything of theirs: fingerprint signals, identity links, guest-only visitor rows with their sessions, product events and searches, and the anonymous counter rows of browsers with no sign of life in the period; in batches of 1000; scheduled daily at 03:41 UTC by pg_cron. Refuses a retention under 30 days.';

commit;
