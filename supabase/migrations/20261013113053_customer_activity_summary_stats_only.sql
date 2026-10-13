create or replace function public.customer_activity_summary(p_actor_type text,p_period text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
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
begin
  if p_actor_type not in ('guest','customer') or p_period not in ('today','week','month','year') then raise exception 'invalid activity summary range'; end if;
  v_start := case p_period when 'today' then v_end when 'week' then v_end-6 when 'month' then v_end-29 else v_end-364 end;
  v_start_ts := v_start::timestamp at time zone 'Africa/Cairo';
  v_end_ts := (v_end+1)::timestamp at time zone 'Africa/Cairo';
  if p_actor_type='guest' then
    select count(distinct v.visitor_hash) into v_people from public.guest_analytics_visits v where v.activity_date between v_start and v_end;
    select count(*) filter(where cs.ended_at is null and cs.last_seen_at>=now()-interval '2 minutes'),count(*),coalesce(sum(cs.active_seconds),0)
      into v_active,v_sessions,v_seconds from public.customer_sessions cs where cs.guest_id is not null and cs.started_at>=v_start_ts and cs.started_at<v_end_ts;
    select coalesce(sum(event_count) filter(where event_type='view'),0),coalesce(sum(event_count) filter(where event_type='search'),0),
      coalesce(sum(event_count) filter(where event_type='cart_add'),0),coalesce(sum(event_count) filter(where event_type='cart_remove'),0)
      into v_views,v_searches,v_adds,v_removes from public.guest_product_analytics a where a.activity_date between v_start and v_end;
  else
    select count(distinct e.user_id) into v_people from public.customer_product_events e where e.user_id is not null and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts;
    select count(*) filter(where cs.ended_at is null and cs.last_seen_at>=now()-interval '2 minutes'),count(*),coalesce(sum(cs.active_seconds),0)
      into v_active,v_sessions,v_seconds from public.customer_sessions cs where cs.user_id is not null and cs.started_at>=v_start_ts and cs.started_at<v_end_ts;
    select count(*) filter(where event_type='view'),count(*) filter(where event_type='search'),count(*) filter(where event_type='cart_add'),count(*) filter(where event_type='cart_remove')
      into v_views,v_searches,v_adds,v_removes from public.customer_product_events e where e.user_id is not null and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts;
  end if;
  return jsonb_build_object('actorType',p_actor_type,'period',p_period,'startDate',v_start,'endDate',v_end,
    'people',v_people,'activeSessions',v_active,'visitCount',v_sessions,'activeSeconds',v_seconds,
    'productViews',v_views,'productSearches',v_searches,'cartAdds',v_adds,'cartRemoves',v_removes,
    'topViewed','[]'::jsonb,'topSearched','[]'::jsonb,'topCartAdded','[]'::jsonb,'topCartRemoved','[]'::jsonb);
end;
$$;

revoke all on function public.customer_activity_summary(text,text) from public,anon,authenticated;
grant execute on function public.customer_activity_summary(text,text) to service_role;
