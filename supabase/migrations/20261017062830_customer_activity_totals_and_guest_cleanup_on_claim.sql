begin;

-- 1) Claim: once a guest becomes a registered customer, nothing that identifies the old browser stays.
--    Its basket, sessions, product events and searches move to the account (unchanged). The anonymous
--    analytics, the stored fingerprints and the identity links are deleted, and the conversion record
--    keeps only a random token (never the browser hash), so the funnel can still be counted.
create or replace function public.claim_guest_browser_cart(
  p_fingerprint_hash text,
  p_analytics_hash text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $$
declare
  v_guest public.guest_visitors%rowtype;
  v_item jsonb;
  v_moved integer := 0;
  v_cart jsonb := '[]'::jsonb;
  v_size_id uuid;
  v_store_product_id uuid;
  v_quantity integer;
  v_first_seen date;
begin
  if coalesce(p_fingerprint_hash, '') !~ '^[a-f0-9]{64}$'
     or coalesce(p_analytics_hash, '') !~ '^[a-f0-9]{64}$'
     or p_user_id is null then
    return jsonb_build_object('claimed', false, 'cart', 0);
  end if;
  if not exists (select 1 from public.profiles pr where pr.id = p_user_id and pr.role = 'customer') then
    return jsonb_build_object('claimed', false, 'cart', 0);
  end if;

  select * into v_guest from public.guest_visitors
  where fingerprint_hash = p_fingerprint_hash and status = 'guest' and identity_version = 2
  for update;
  if not found then
    return jsonb_build_object('claimed', false, 'cart', 0);
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(v_guest.cart_snapshot, '[]'::jsonb))
  loop
    begin v_size_id := nullif(v_item->>'sid', '')::uuid; exception when others then v_size_id := null; end;
    begin v_store_product_id := nullif(v_item->>'storeProductId', '')::uuid; exception when others then v_store_product_id := null; end;
    begin v_quantity := greatest(1, least(99, coalesce((v_item->>'q')::integer, 1))); exception when others then v_quantity := 1; end;
    if v_size_id is not null and v_store_product_id is not null and exists (
      select 1 from public.store_products sp where sp.id = v_store_product_id and sp.product_size_id = v_size_id
    ) then
      insert into public.cart_items(user_id, store_product_id, quantity)
      values (p_user_id, v_store_product_id, v_quantity)
      on conflict (user_id, store_product_id) do update
        set quantity = least(99, public.cart_items.quantity + excluded.quantity), updated_at = now();
      v_moved := v_moved + 1;
    end if;
  end loop;

  -- Preserve every detailed session, product operation, and search under the account ID.
  update public.customer_sessions set guest_id = null, user_id = p_user_id where guest_id = v_guest.id;
  update public.customer_product_events set guest_id = null, user_id = p_user_id where guest_id = v_guest.id;
  update public.customer_searches set guest_id = null, user_id = p_user_id where guest_id = v_guest.id;

  v_first_seen := coalesce((select min(activity_date) from public.guest_analytics_visits where visitor_hash = p_analytics_hash),
                           (v_guest.first_seen_at at time zone 'Africa/Cairo')::date);
  insert into public.guest_conversions (visitor_hash, user_id, first_seen_date, converted_on)
  values (
    encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex'),
    p_user_id, v_first_seen, (now() at time zone 'Africa/Cairo')::date);

  -- the browser's identity and every anonymous trace of it go away
  delete from public.guest_product_analytics where visitor_hash = p_analytics_hash;
  delete from public.guest_analytics_visits where visitor_hash = p_analytics_hash;
  delete from public.guest_fingerprints where analytics_hash = p_analytics_hash;
  delete from public.guest_identity_links where hash_a = p_analytics_hash or hash_b = p_analytics_hash;
  delete from public.guest_visitors where id = v_guest.id;

  select coalesce(jsonb_agg(jsonb_build_object('sid', sp.product_size_id, 'storeProductId', sp.id, 'q', ci.quantity)), '[]'::jsonb)
    into v_cart from public.cart_items ci join public.store_products sp on sp.id = ci.store_product_id
    where ci.user_id = p_user_id;
  return jsonb_build_object('claimed', true, 'cart', v_moved, 'items', jsonb_array_length(v_cart), 'snapshot', v_cart);
end;
$$;

-- 2) Merge of one browser seen under two keys: the duplicate's stored fingerprints and links go too.
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

  perform 1 from public.guest_visitors where fingerprint_hash in (p_from_fingerprint, p_to_fingerprint)
    order by fingerprint_hash for update;
  select * into v_from from public.guest_visitors where fingerprint_hash = p_from_fingerprint and status = 'guest' and identity_version = 2;
  select * into v_to from public.guest_visitors where fingerprint_hash = p_to_fingerprint and status = 'guest' and identity_version = 2;

  if v_from.id is null then
    return jsonb_build_object('merged', true, 'reason', 'nothing_to_merge');
  end if;

  if v_to.id is null then
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

  delete from public.guest_fingerprints where analytics_hash = p_from_analytics;
  delete from public.guest_identity_links where hash_a = p_from_analytics or hash_b = p_from_analytics;

  return jsonb_build_object('merged', true, 'reason', 'merged');
end;
$$;

-- 3) Product rankings: guests, registered customers, or both together ('all').
--    A guest who registers moves from the guest numbers to the customer numbers with the original dates,
--    so the total never counts anyone twice.
create or replace function public.customer_product_ranking(
  p_actor_type text, p_period text, p_event_type text, p_limit integer default 20, p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_end date := (now() at time zone 'Africa/Cairo')::date;
  v_start date;
  v_start_ts timestamptz;
  v_end_ts timestamptz;
  v_total bigint := 0;
  v_records jsonb := '[]'::jsonb;
begin
  if p_actor_type is null or p_actor_type not in ('guest','customer','all')
     or p_period is null or p_period not in ('today','week','month','year')
     or p_event_type is null or p_event_type not in ('view','search','cart_add','cart_remove') then
    raise exception 'invalid product ranking scope';
  end if;
  if p_limit is null or p_offset is null or p_limit < 1 or p_limit > 100 or p_offset < 0 or p_offset > 100000 then
    raise exception 'invalid product ranking page';
  end if;

  v_start := case p_period when 'today' then v_end when 'week' then v_end-6 when 'month' then v_end-29 else v_end-364 end;
  v_start_ts := v_start::timestamp at time zone 'Africa/Cairo';
  v_end_ts := (v_end+1)::timestamp at time zone 'Africa/Cairo';

  if p_actor_type='guest' then
    select count(*) into v_total
    from (
      select a.product_id
      from public.guest_product_analytics a
      where a.event_type=p_event_type and a.activity_date between v_start and v_end
      group by a.product_id
    ) products;

    select coalesce(jsonb_agg(jsonb_build_object('product',ranked.product,'operations',ranked.operations,'people',ranked.people)
      order by ranked.operations desc,ranked.people desc,ranked.product_id asc),'[]'::jsonb)
      into v_records
    from (
      select a.product_id,
        coalesce((jsonb_agg(a.product_snapshot order by a.last_seen_at desc) filter (where a.product_snapshot is not null))->0,jsonb_build_object('id',a.product_id)) as product,
        sum(a.event_count)::bigint as operations,
        count(distinct a.visitor_hash)::bigint as people
      from public.guest_product_analytics a
      where a.event_type=p_event_type and a.activity_date between v_start and v_end
      group by a.product_id
      order by sum(a.event_count) desc,count(distinct a.visitor_hash) desc,a.product_id asc
      limit p_limit offset p_offset
    ) ranked;
  elsif p_actor_type='customer' then
    select count(*) into v_total
    from (
      select e.product_id
      from public.customer_product_events e
      where e.user_id is not null and e.event_type=p_event_type and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts
      group by e.product_id
    ) products;

    select coalesce(jsonb_agg(jsonb_build_object('product',ranked.product,'operations',ranked.operations,'people',ranked.people)
      order by ranked.operations desc,ranked.people desc,ranked.product_id asc),'[]'::jsonb)
      into v_records
    from (
      select e.product_id,
        coalesce((jsonb_agg(e.product_snapshot order by e.occurred_at desc) filter (where e.product_snapshot is not null))->0,jsonb_build_object('id',e.product_id)) as product,
        count(*)::bigint as operations,
        count(distinct e.user_id)::bigint as people
      from public.customer_product_events e
      where e.user_id is not null and e.event_type=p_event_type and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts
      group by e.product_id
      order by count(*) desc,count(distinct e.user_id) desc,e.product_id asc
      limit p_limit offset p_offset
    ) ranked;
  else
    select count(*) into v_total
    from (
      select a.product_id from public.guest_product_analytics a
       where a.event_type=p_event_type and a.activity_date between v_start and v_end
      union
      select e.product_id from public.customer_product_events e
       where e.user_id is not null and e.event_type=p_event_type and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts
    ) products;

    select coalesce(jsonb_agg(jsonb_build_object('product',ranked.product,'operations',ranked.operations,'people',ranked.people)
      order by ranked.operations desc,ranked.people desc,ranked.product_id asc),'[]'::jsonb)
      into v_records
    from (
      select u.product_id,
        coalesce((jsonb_agg(u.snap order by u.seen desc) filter (where u.snap is not null))->0,jsonb_build_object('id',u.product_id)) as product,
        sum(u.ops)::bigint as operations,
        count(distinct u.who)::bigint as people
      from (
        select a.product_id, a.product_snapshot as snap, a.last_seen_at as seen, a.event_count::bigint as ops, a.visitor_hash as who
          from public.guest_product_analytics a
         where a.event_type=p_event_type and a.activity_date between v_start and v_end
        union all
        select e.product_id, e.product_snapshot, e.occurred_at, 1::bigint, e.user_id::text
          from public.customer_product_events e
         where e.user_id is not null and e.event_type=p_event_type and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts
      ) u
      group by u.product_id
      order by sum(u.ops) desc,count(distinct u.who) desc,u.product_id asc
      limit p_limit offset p_offset
    ) ranked;
  end if;

  return jsonb_build_object(
    'actorType',p_actor_type,'period',p_period,'eventType',p_event_type,
    'limit',p_limit,'offset',p_offset,'total',v_total,
    'hasMore',p_offset+jsonb_array_length(v_records)<v_total,'records',v_records
  );
end;
$$;

-- 4) Activity summary for guests, registered customers, or both ('all').
create or replace function public.customer_activity_summary(p_actor_type text, p_period text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_start date;
  v_end date := (now() at time zone 'Africa/Cairo')::date;
  v_start_ts timestamptz;
  v_end_ts timestamptz;
  v_people bigint := 0;
  v_active bigint := 0;
  v_sessions bigint := 0;
  v_seconds bigint := 0;
  v_views bigint := 0;
  v_searches bigint := 0;
  v_adds bigint := 0;
  v_removes bigint := 0;
  s1 bigint; s2 bigint; s3 bigint; s4 bigint; s5 bigint; s6 bigint; s7 bigint; s8 bigint;
begin
  if p_actor_type not in ('guest','customer','all') or p_period not in ('today','week','month','year') then raise exception 'invalid activity summary range'; end if;
  v_start := case p_period when 'today' then v_end when 'week' then v_end-6 when 'month' then v_end-29 else v_end-364 end;
  v_start_ts := v_start::timestamp at time zone 'Africa/Cairo';
  v_end_ts := (v_end+1)::timestamp at time zone 'Africa/Cairo';

  if p_actor_type in ('guest','all') then
    select count(distinct v.visitor_hash) into s1 from public.guest_analytics_visits v where v.activity_date between v_start and v_end;
    select count(*) filter(where cs.ended_at is null and cs.last_seen_at>=now()-interval '2 minutes'),count(*),coalesce(sum(cs.active_seconds),0)
      into s2,s3,s4 from public.customer_sessions cs where cs.guest_id is not null and cs.started_at>=v_start_ts and cs.started_at<v_end_ts;
    select coalesce(sum(event_count) filter(where event_type='view'),0),coalesce(sum(event_count) filter(where event_type='search'),0),
      coalesce(sum(event_count) filter(where event_type='cart_add'),0),coalesce(sum(event_count) filter(where event_type='cart_remove'),0)
      into s5,s6,s7,s8 from public.guest_product_analytics a where a.activity_date between v_start and v_end;
    v_people := v_people + s1; v_active := v_active + s2; v_sessions := v_sessions + s3; v_seconds := v_seconds + s4;
    v_views := v_views + s5; v_searches := v_searches + s6; v_adds := v_adds + s7; v_removes := v_removes + s8;
  end if;
  if p_actor_type in ('customer','all') then
    select count(distinct e.user_id) into s1 from public.customer_product_events e where e.user_id is not null and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts;
    select count(*) filter(where cs.ended_at is null and cs.last_seen_at>=now()-interval '2 minutes'),count(*),coalesce(sum(cs.active_seconds),0)
      into s2,s3,s4 from public.customer_sessions cs where cs.user_id is not null and cs.started_at>=v_start_ts and cs.started_at<v_end_ts;
    select count(*) filter(where event_type='view'),count(*) filter(where event_type='search'),count(*) filter(where event_type='cart_add'),count(*) filter(where event_type='cart_remove')
      into s5,s6,s7,s8 from public.customer_product_events e where e.user_id is not null and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts;
    v_people := v_people + s1; v_active := v_active + s2; v_sessions := v_sessions + s3; v_seconds := v_seconds + s4;
    v_views := v_views + s5; v_searches := v_searches + s6; v_adds := v_adds + s7; v_removes := v_removes + s8;
  end if;

  return jsonb_build_object('actorType',p_actor_type,'period',p_period,'startDate',v_start,'endDate',v_end,
    'people',v_people,'activeSessions',v_active,'visitCount',v_sessions,'activeSeconds',v_seconds,
    'productViews',v_views,'productSearches',v_searches,'cartAdds',v_adds,'cartRemoves',v_removes,
    'topViewed','[]'::jsonb,'topSearched','[]'::jsonb,'topCartAdded','[]'::jsonb,'topCartRemoved','[]'::jsonb);
end;
$$;

revoke all on function public.claim_guest_browser_cart(text,text,uuid) from public, anon, authenticated;
revoke all on function public.merge_guest_browser(text,text,text,text) from public, anon, authenticated;
revoke all on function public.customer_product_ranking(text,text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.customer_activity_summary(text,text) from public, anon, authenticated;
grant execute on function public.claim_guest_browser_cart(text,text,uuid) to service_role;
grant execute on function public.merge_guest_browser(text,text,text,text) to service_role;
grant execute on function public.customer_product_ranking(text,text,text,integer,integer) to service_role;
grant execute on function public.customer_activity_summary(text,text) to service_role;

commit;
