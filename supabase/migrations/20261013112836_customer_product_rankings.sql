create or replace function public.customer_product_ranking(
  p_actor_type text,
  p_period text,
  p_event_type text,
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_end date := (now() at time zone 'Africa/Cairo')::date;
  v_start date;
  v_start_ts timestamptz;
  v_end_ts timestamptz;
  v_total bigint := 0;
  v_records jsonb := '[]'::jsonb;
begin
  if p_actor_type is null or p_actor_type not in ('guest','customer')
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
  else
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
  end if;

  return jsonb_build_object(
    'actorType',p_actor_type,'period',p_period,'eventType',p_event_type,
    'limit',p_limit,'offset',p_offset,'total',v_total,
    'hasMore',p_offset+jsonb_array_length(v_records)<v_total,'records',v_records
  );
end;
$$;

revoke all on function public.customer_product_ranking(text,text,text,integer,integer) from public,anon,authenticated;
grant execute on function public.customer_product_ranking(text,text,text,integer,integer) to service_role;
comment on function public.customer_product_ranking(text,text,text,integer,integer) is 'Admin API ranking pages for guest and registered-customer product activity; all product details come from server snapshots.';
