-- Rolls back pending/migrations 20261020000100_guest_retention_delete_expired_guest_counters.sql:
-- restores purge_expired_guest_fingerprints exactly as 20261019105404 defined it (it stops deleting the guests' counter
-- rows) and drops the two indexes. Counter rows the new version already deleted are not restored.
begin;

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

drop index if exists public.guest_analytics_visits_last_seen_idx;
drop index if exists public.guest_product_analytics_last_seen_idx;

commit;
