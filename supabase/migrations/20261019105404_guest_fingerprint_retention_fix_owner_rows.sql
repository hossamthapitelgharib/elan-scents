begin;

-- Owner-approved retention (2026-10-18): a guest's browser fingerprint data is kept for 400 days after the guest
-- was last seen, the same lifetime as the elan_gid cookie (api/guest-cart.js, Max-Age=34560000).
-- Until now nothing deleted these rows by age; they only went away when the guest signed up or was merged.
--
-- Deleted by age (daily, in batches):
--   guest_fingerprints      device parts and the hashed IP / user-agent / language signals   (last_seen_at)
--   guest_identity_links    "these two browsers are probably one person"                      (last_confirmed_at)
--   guest_visitors          guest rows only (status = 'guest'): browser hash and basket snapshot (last_seen_at).
--                           The guest's visit sessions and product events are deleted with it, first: both tables
--                           require exactly one owner (guest or customer) and reference the guest with ON DELETE SET NULL,
--                           so deleting the guest row alone would violate that rule and fail the whole job.
--                           customer_searches rows of that guest go with it (on delete cascade).
-- Not touched:
--   guest_analytics_visits, guest_product_analytics  pseudonymous aggregate counters used by reports
--   guest_conversions, registered customers' own data (including events and sessions that moved to an account),
--   converted guest_visitors rows
-- Keeping the aggregate counters longer than 400 days is a separate owner decision.

-- pg_cron is available in this Supabase project (already enabled by 20261015033601).
create extension if not exists pg_cron;

create index if not exists guest_fingerprints_last_seen_idx on public.guest_fingerprints (last_seen_at);
create index if not exists guest_identity_links_last_confirmed_idx on public.guest_identity_links (last_confirmed_at);

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
begin
  -- A guard against a typo turning this into "delete everything": nothing shorter than 30 days is accepted.
  if p_retention is null or p_retention < interval '30 days' then
    raise exception 'guest retention must be at least 30 days' using errcode = '22023';
  end if;
  v_cutoff := now() - p_retention;

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
                            'guest_product_events', v_events, 'guest_sessions', v_sessions);
end;
$$;

revoke all on function public.purge_expired_guest_fingerprints(interval) from public, anon, authenticated;
grant execute on function public.purge_expired_guest_fingerprints(interval) to service_role;

select cron.schedule(
  'guest-fingerprint-retention-400d',
  '41 3 * * *',
  'select public.purge_expired_guest_fingerprints();'
);

comment on function public.purge_expired_guest_fingerprints(interval) is 'Deletes guest fingerprint signals, identity links and guest-only visitor rows (with their sessions and product events) not seen for 400 days (default), in batches of 1000; scheduled daily at 03:41 UTC by pg_cron. Refuses a retention under 30 days.';

commit;
