begin;

-- One browser must be one guest. If the same browser shows up with two keys (storage was cleared,
-- the key was lost, two tabs raced on a first visit), the server picks one canonical key and merges
-- the other into it: basket, visit sessions, product events and the anonymous analytics all move,
-- and the duplicate guest disappears. After this the person is counted once.
create or replace function public.merge_guest_browser(
  p_from_fingerprint text,
  p_to_fingerprint text,
  p_from_analytics text,
  p_to_analytics text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from public.guest_visitors%rowtype;
  v_to public.guest_visitors%rowtype;
  v_cart jsonb;
begin
  if coalesce(p_from_fingerprint,'') !~ '^[a-f0-9]{64}$' or coalesce(p_to_fingerprint,'') !~ '^[a-f0-9]{64}$'
     or coalesce(p_from_analytics,'') !~ '^[a-f0-9]{64}$' or coalesce(p_to_analytics,'') !~ '^[a-f0-9]{64}$'
     or p_from_fingerprint = p_to_fingerprint then
    return jsonb_build_object('merged', false, 'reason', 'invalid');
  end if;

  -- lock in a fixed order so two merges can never deadlock
  perform 1 from public.guest_visitors where fingerprint_hash in (p_from_fingerprint, p_to_fingerprint)
    order by fingerprint_hash for update;
  select * into v_from from public.guest_visitors where fingerprint_hash = p_from_fingerprint and status = 'guest' and identity_version = 2;
  select * into v_to from public.guest_visitors where fingerprint_hash = p_to_fingerprint and status = 'guest' and identity_version = 2;

  if v_from.id is null then
    return jsonb_build_object('merged', true, 'reason', 'nothing_to_merge');
  end if;

  if v_to.id is null then
    -- the canonical key has no record yet: the existing record simply takes that identity
    update public.guest_visitors set fingerprint_hash = p_to_fingerprint where id = v_from.id;
    v_to := v_from; v_to.fingerprint_hash := p_to_fingerprint;
  else
    select coalesce(jsonb_agg(jsonb_build_object('sid', sid, 'storeProductId', sp, 'q', q)), '[]'::jsonb) into v_cart
    from (
      select item->>'sid' as sid, max(item->>'storeProductId') as sp,
             max(case when coalesce(item->>'q','') ~ '^[0-9]{1,3}$' then least(99, greatest(1, (item->>'q')::integer)) else 1 end) as q
      from (
        select value as item from jsonb_array_elements(coalesce(v_to.cart_snapshot, '[]'::jsonb))
        union all
        select value from jsonb_array_elements(coalesce(v_from.cart_snapshot, '[]'::jsonb))
      ) u
      where coalesce(item->>'sid','') <> ''
      group by item->>'sid'
    ) m;

    update public.customer_sessions set guest_id = v_to.id where guest_id = v_from.id;
    update public.customer_product_events set guest_id = v_to.id where guest_id = v_from.id;
    -- customer_searches cascades on delete, so its rows must move before the duplicate guest is removed
    update public.customer_searches set guest_id = v_to.id where guest_id = v_from.id;
    update public.guest_visitors
      set cart_snapshot = v_cart,
          first_seen_at = least(v_to.first_seen_at, v_from.first_seen_at),
          last_seen_at = greatest(v_to.last_seen_at, v_from.last_seen_at)
      where id = v_to.id;
    delete from public.guest_visitors where id = v_from.id;
  end if;

  insert into public.guest_analytics_visits (visitor_hash, activity_date, first_seen_at, last_seen_at)
    select p_to_analytics, activity_date, first_seen_at, last_seen_at
    from public.guest_analytics_visits where visitor_hash = p_from_analytics
    on conflict (visitor_hash, activity_date) do update
      set first_seen_at = least(public.guest_analytics_visits.first_seen_at, excluded.first_seen_at),
          last_seen_at = greatest(public.guest_analytics_visits.last_seen_at, excluded.last_seen_at);
  delete from public.guest_analytics_visits where visitor_hash = p_from_analytics;

  insert into public.guest_product_analytics (visitor_hash, product_id, activity_date, event_type, event_count, product_snapshot, first_seen_at, last_seen_at)
    select p_to_analytics, product_id, activity_date, event_type, event_count, product_snapshot, first_seen_at, last_seen_at
    from public.guest_product_analytics where visitor_hash = p_from_analytics
    on conflict (visitor_hash, product_id, activity_date, event_type) do update
      set event_count = least(public.guest_product_analytics.event_count + excluded.event_count, 1000000),
          first_seen_at = least(public.guest_product_analytics.first_seen_at, excluded.first_seen_at),
          last_seen_at = greatest(public.guest_product_analytics.last_seen_at, excluded.last_seen_at);
  delete from public.guest_product_analytics where visitor_hash = p_from_analytics;

  return jsonb_build_object('merged', true, 'reason', 'merged');
end;
$$;

revoke all on function public.merge_guest_browser(text,text,text,text) from public, anon, authenticated;
grant execute on function public.merge_guest_browser(text,text,text,text) to service_role;

commit;
