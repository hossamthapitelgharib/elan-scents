begin;

alter table public.guest_product_analytics
  drop constraint if exists guest_product_analytics_event_type_check;
alter table public.guest_product_analytics
  add constraint guest_product_analytics_event_type_check
  check (event_type = any (array['view','search','cart_add','cart_remove']::text[]));

create table if not exists public.customer_sessions (
  session_id uuid primary key,
  guest_id uuid references public.guest_visitors(id) on delete set null,
  user_id uuid references public.profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz,
  active_seconds integer not null default 0 check (active_seconds >= 0),
  constraint customer_sessions_exactly_one_actor check ((guest_id is not null) <> (user_id is not null))
);

create index if not exists customer_sessions_guest_started_idx
  on public.customer_sessions (guest_id, started_at desc) where guest_id is not null;
create index if not exists customer_sessions_user_started_idx
  on public.customer_sessions (user_id, started_at desc) where user_id is not null;

create table if not exists public.customer_product_events (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid references public.guest_visitors(id) on delete set null,
  user_id uuid references public.profiles(id) on delete cascade,
  session_id uuid references public.customer_sessions(session_id) on delete set null,
  event_type text not null check (event_type = any (array['view','search','cart_add','cart_remove']::text[])),
  product_id uuid not null references public.products(id) on delete cascade,
  product_size_id uuid references public.product_sizes(id) on delete set null,
  store_product_id uuid references public.store_products(id) on delete set null,
  quantity integer check (quantity is null or quantity between 1 and 99),
  occurred_at timestamptz not null default now(),
  constraint customer_product_events_exactly_one_actor check ((guest_id is not null) <> (user_id is not null))
);

create index if not exists customer_product_events_guest_time_idx
  on public.customer_product_events (guest_id, occurred_at desc) where guest_id is not null;
create index if not exists customer_product_events_user_time_idx
  on public.customer_product_events (user_id, occurred_at desc) where user_id is not null;
create index if not exists customer_product_events_product_type_time_idx
  on public.customer_product_events (product_id, event_type, occurred_at desc);

alter table public.customer_sessions enable row level security;
alter table public.customer_product_events enable row level security;
revoke all on public.customer_sessions, public.customer_product_events from anon, authenticated;
grant all on public.customer_sessions, public.customer_product_events to service_role;

create or replace function public.record_customer_session(
  p_fingerprint_hash text,
  p_user_id uuid,
  p_session_id uuid,
  p_action text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_guest_id uuid;
  v_rows integer;
begin
  if p_session_id is null or p_action not in ('start','heartbeat','end') then return false; end if;
  if (p_user_id is null) = (p_fingerprint_hash is null) then return false; end if;

  if p_user_id is not null then
    if not exists (select 1 from public.profiles pr where pr.id = p_user_id and pr.role = 'customer') then return false; end if;
  else
    if p_fingerprint_hash !~ '^[a-f0-9]{64}$' then return false; end if;
    select gv.id into v_guest_id from public.guest_visitors gv
      where gv.fingerprint_hash = p_fingerprint_hash and gv.status = 'guest' and gv.identity_version = 2;
    if v_guest_id is null then return false; end if;
  end if;

  if p_action = 'start' then
    insert into public.customer_sessions(session_id, guest_id, user_id, started_at, last_seen_at, ended_at, active_seconds)
    values (p_session_id, v_guest_id, p_user_id, now(), now(), null, 0)
    on conflict (session_id) do update
      set last_seen_at = now(), ended_at = null
      where public.customer_sessions.guest_id is not distinct from v_guest_id
        and public.customer_sessions.user_id is not distinct from p_user_id;
    get diagnostics v_rows = row_count;
    return v_rows > 0;
  end if;

  update public.customer_sessions cs
    set active_seconds = cs.active_seconds + least(45, greatest(0, floor(extract(epoch from (now() - cs.last_seen_at)))::integer)),
        last_seen_at = now(),
        ended_at = case when p_action = 'end' then now() else cs.ended_at end
    where cs.session_id = p_session_id
      and cs.guest_id is not distinct from v_guest_id
      and cs.user_id is not distinct from p_user_id;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

create or replace function public.record_customer_product_event(
  p_fingerprint_hash text,
  p_analytics_hash text,
  p_user_id uuid,
  p_session_id uuid,
  p_event_type text,
  p_product_id uuid,
  p_product_size_id uuid,
  p_store_product_id uuid,
  p_quantity integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_guest_id uuid;
  v_event_type text := p_event_type;
  v_product_size_id uuid := p_product_size_id;
  v_rows integer;
begin
  if (p_user_id is null) = (p_fingerprint_hash is null) then return false; end if;
  if p_event_type not in ('view','search','cart_add','cart_remove') or p_product_id is null then return false; end if;
  if p_event_type in ('cart_add','cart_remove') and (p_quantity is null or p_quantity < 1 or p_quantity > 99) then return false; end if;
  if p_event_type in ('view','search') and p_quantity is not null and (p_quantity < 1 or p_quantity > 99) then return false; end if;

  if p_user_id is not null then
    if not exists (select 1 from public.profiles pr where pr.id = p_user_id and pr.role = 'customer') then return false; end if;
  else
    if p_fingerprint_hash !~ '^[a-f0-9]{64}$' or p_analytics_hash !~ '^[a-f0-9]{64}$' then return false; end if;
    select gv.id into v_guest_id from public.guest_visitors gv
      where gv.fingerprint_hash = p_fingerprint_hash and gv.status = 'guest' and gv.identity_version = 2;
    if v_guest_id is null then return false; end if;
  end if;

  if v_product_size_id is null and p_store_product_id is not null then
    select sp.product_size_id into v_product_size_id
      from public.store_products sp where sp.id = p_store_product_id;
  end if;
  if v_product_size_id is not null and not exists (
    select 1 from public.product_sizes ps where ps.id = v_product_size_id and ps.product_id = p_product_id
  ) then return false; end if;
  if p_store_product_id is not null and not exists (
    select 1 from public.store_products sp where sp.id = p_store_product_id and sp.product_size_id = v_product_size_id
  ) then return false; end if;

  if p_session_id is not null then
    perform public.record_customer_session(p_fingerprint_hash, p_user_id, p_session_id, 'start');
    if not exists (
      select 1 from public.customer_sessions cs where cs.session_id = p_session_id
        and cs.guest_id is not distinct from v_guest_id and cs.user_id is not distinct from p_user_id
    ) then return false; end if;
  end if;

  insert into public.customer_product_events(
    guest_id,user_id,session_id,event_type,product_id,product_size_id,store_product_id,quantity
  ) values (
    v_guest_id,p_user_id,p_session_id,v_event_type,p_product_id,v_product_size_id,p_store_product_id,
    case when v_event_type in ('cart_add','cart_remove') then p_quantity else null end
  );

  if v_guest_id is not null then
    insert into public.guest_product_analytics(visitor_hash,product_id,activity_date,event_type,event_count,last_seen_at)
    values (p_analytics_hash,p_product_id,(now() at time zone 'Africa/Cairo')::date,v_event_type,1,now())
    on conflict (visitor_hash,product_id,activity_date,event_type)
    do update set event_count = least(public.guest_product_analytics.event_count + 1,1000000),
                  last_seen_at = excluded.last_seen_at;
    update public.guest_visitors set last_seen_at = now() where id = v_guest_id;
  end if;
  return true;
end;
$$;

create or replace function public.claim_guest_browser_cart(p_fingerprint_hash text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_guest public.guest_visitors%rowtype;
  v_item jsonb;
  v_moved integer := 0;
  v_cart jsonb := '[]'::jsonb;
  v_size_id uuid;
  v_store_product_id uuid;
  v_quantity integer;
begin
  if p_fingerprint_hash !~ '^[a-f0-9]{64}$' or p_user_id is null then
    return jsonb_build_object('claimed', false, 'cart', 0);
  end if;
  select * into v_guest from public.guest_visitors
    where fingerprint_hash = p_fingerprint_hash and status = 'guest' and identity_version = 2
    for update;
  if not found then return jsonb_build_object('claimed', false, 'cart', 0); end if;

  for v_item in select value from jsonb_array_elements(coalesce(v_guest.cart_snapshot,'[]'::jsonb)) loop
    begin v_size_id := nullif(v_item->>'sid','')::uuid; exception when others then v_size_id := null; end;
    begin v_store_product_id := nullif(v_item->>'storeProductId','')::uuid; exception when others then v_store_product_id := null; end;
    begin v_quantity := greatest(1,least(99,coalesce((v_item->>'q')::integer,1))); exception when others then v_quantity := 1; end;
    if v_size_id is not null and v_store_product_id is not null and exists (
      select 1 from public.store_products sp where sp.id=v_store_product_id and sp.product_size_id=v_size_id
    ) then
      insert into public.cart_items(user_id,store_product_id,quantity)
      values (p_user_id,v_store_product_id,v_quantity)
      on conflict (user_id,store_product_id) do update
        set quantity = least(99, public.cart_items.quantity + excluded.quantity), updated_at = now();
      v_moved := v_moved + 1;
    end if;
  end loop;

  update public.customer_sessions set guest_id=null,user_id=p_user_id where guest_id=v_guest.id;
  update public.customer_product_events set guest_id=null,user_id=p_user_id where guest_id=v_guest.id;
  delete from public.guest_visitors where id=v_guest.id;
  select coalesce(jsonb_agg(jsonb_build_object('sid',sp.product_size_id,'storeProductId',sp.id,'q',ci.quantity)),'[]'::jsonb)
    into v_cart from public.cart_items ci join public.store_products sp on sp.id=ci.store_product_id
    where ci.user_id=p_user_id;
  return jsonb_build_object('claimed',true,'cart',v_moved,'items',jsonb_array_length(v_cart),'snapshot',v_cart);
end;
$$;

create or replace function public.customer_activity_summary(p_actor_type text, p_period text)
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
  v_top_viewed jsonb := '[]'::jsonb;
  v_top_searched jsonb := '[]'::jsonb;
  v_top_added jsonb := '[]'::jsonb;
  v_top_removed jsonb := '[]'::jsonb;
begin
  if p_actor_type not in ('guest','customer') or p_period not in ('today','week','month','year') then
    raise exception 'invalid activity summary range';
  end if;
  v_start := case p_period when 'today' then v_end when 'week' then v_end-6 when 'month' then v_end-29 else v_end-364 end;
  v_start_ts := v_start::timestamp at time zone 'Africa/Cairo';
  v_end_ts := (v_end+1)::timestamp at time zone 'Africa/Cairo';

  if p_actor_type = 'guest' then
    select count(distinct v.visitor_hash) into v_people from public.guest_analytics_visits v
      where v.activity_date between v_start and v_end;
    select count(*) filter (where cs.ended_at is null and cs.last_seen_at >= now()-interval '2 minutes'),
           count(*),coalesce(sum(cs.active_seconds),0)
      into v_active,v_sessions,v_seconds from public.customer_sessions cs
      where cs.guest_id is not null and cs.started_at >= v_start_ts and cs.started_at < v_end_ts;
    select coalesce(sum(event_count) filter (where event_type='view'),0),
           coalesce(sum(event_count) filter (where event_type='search'),0),
           coalesce(sum(event_count) filter (where event_type='cart_add'),0),
           coalesce(sum(event_count) filter (where event_type='cart_remove'),0)
      into v_views,v_searches,v_adds,v_removes from public.guest_product_analytics a
      where a.activity_date between v_start and v_end;

    select coalesce(jsonb_agg(jsonb_build_object('product',to_jsonb(p),'operations',q.operations,'people',q.people) order by q.operations desc),'[]'::jsonb) into v_top_viewed
      from (select a.product_id,sum(a.event_count)::bigint operations,count(distinct a.visitor_hash)::bigint people from public.guest_product_analytics a where a.event_type='view' and a.activity_date between v_start and v_end group by a.product_id order by operations desc limit 20) q join public.public_products p on p.id=q.product_id;
    select coalesce(jsonb_agg(jsonb_build_object('product',to_jsonb(p),'operations',q.operations,'people',q.people) order by q.operations desc),'[]'::jsonb) into v_top_searched
      from (select a.product_id,sum(a.event_count)::bigint operations,count(distinct a.visitor_hash)::bigint people from public.guest_product_analytics a where a.event_type='search' and a.activity_date between v_start and v_end group by a.product_id order by operations desc limit 20) q join public.public_products p on p.id=q.product_id;
    select coalesce(jsonb_agg(jsonb_build_object('product',to_jsonb(p),'operations',q.operations,'people',q.people) order by q.operations desc),'[]'::jsonb) into v_top_added
      from (select a.product_id,sum(a.event_count)::bigint operations,count(distinct a.visitor_hash)::bigint people from public.guest_product_analytics a where a.event_type='cart_add' and a.activity_date between v_start and v_end group by a.product_id order by operations desc limit 20) q join public.public_products p on p.id=q.product_id;
    select coalesce(jsonb_agg(jsonb_build_object('product',to_jsonb(p),'operations',q.operations,'people',q.people) order by q.operations desc),'[]'::jsonb) into v_top_removed
      from (select a.product_id,sum(a.event_count)::bigint operations,count(distinct a.visitor_hash)::bigint people from public.guest_product_analytics a where a.event_type='cart_remove' and a.activity_date between v_start and v_end group by a.product_id order by operations desc limit 20) q join public.public_products p on p.id=q.product_id;
  else
    select count(distinct e.user_id) into v_people from public.customer_product_events e
      where e.user_id is not null and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts;
    select count(*) filter (where cs.ended_at is null and cs.last_seen_at >= now()-interval '2 minutes'),
           count(*),coalesce(sum(cs.active_seconds),0)
      into v_active,v_sessions,v_seconds from public.customer_sessions cs
      where cs.user_id is not null and cs.started_at >= v_start_ts and cs.started_at < v_end_ts;
    select count(*) filter (where event_type='view'),count(*) filter (where event_type='search'),
           count(*) filter (where event_type='cart_add'),count(*) filter (where event_type='cart_remove')
      into v_views,v_searches,v_adds,v_removes from public.customer_product_events e
      where e.user_id is not null and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts;

    select coalesce(jsonb_agg(jsonb_build_object('product',to_jsonb(p),'operations',q.operations,'people',q.people) order by q.operations desc),'[]'::jsonb) into v_top_viewed
      from (select e.product_id,count(*)::bigint operations,count(distinct e.user_id)::bigint people from public.customer_product_events e where e.user_id is not null and e.event_type='view' and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts group by e.product_id order by operations desc limit 20) q join public.public_products p on p.id=q.product_id;
    select coalesce(jsonb_agg(jsonb_build_object('product',to_jsonb(p),'operations',q.operations,'people',q.people) order by q.operations desc),'[]'::jsonb) into v_top_searched
      from (select e.product_id,count(*)::bigint operations,count(distinct e.user_id)::bigint people from public.customer_product_events e where e.user_id is not null and e.event_type='search' and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts group by e.product_id order by operations desc limit 20) q join public.public_products p on p.id=q.product_id;
    select coalesce(jsonb_agg(jsonb_build_object('product',to_jsonb(p),'operations',q.operations,'people',q.people) order by q.operations desc),'[]'::jsonb) into v_top_added
      from (select e.product_id,count(*)::bigint operations,count(distinct e.user_id)::bigint people from public.customer_product_events e where e.user_id is not null and e.event_type='cart_add' and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts group by e.product_id order by operations desc limit 20) q join public.public_products p on p.id=q.product_id;
    select coalesce(jsonb_agg(jsonb_build_object('product',to_jsonb(p),'operations',q.operations,'people',q.people) order by q.operations desc),'[]'::jsonb) into v_top_removed
      from (select e.product_id,count(*)::bigint operations,count(distinct e.user_id)::bigint people from public.customer_product_events e where e.user_id is not null and e.event_type='cart_remove' and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts group by e.product_id order by operations desc limit 20) q join public.public_products p on p.id=q.product_id;
  end if;

  return jsonb_build_object(
    'actorType',p_actor_type,'period',p_period,'startDate',v_start,'endDate',v_end,
    'people',v_people,'activeSessions',v_active,'visitCount',v_sessions,'activeSeconds',v_seconds,
    'productViews',v_views,'productSearches',v_searches,'cartAdds',v_adds,'cartRemoves',v_removes,
    'topViewed',v_top_viewed,'topSearched',v_top_searched,'topCartAdded',v_top_added,'topCartRemoved',v_top_removed
  );
end;
$$;

create or replace function public.platform_customer_activity_detail(
  p_guest_id uuid,
  p_user_id uuid,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_guest public.guest_visitors%rowtype;
  v_profile public.profiles%rowtype;
  v_cart jsonb := '[]'::jsonb;
  v_events jsonb := '[]'::jsonb;
  v_sessions jsonb := '[]'::jsonb;
  v_event_total bigint := 0;
  v_session_total bigint := 0;
  v_active_seconds bigint := 0;
  v_actor_guest uuid := p_guest_id;
  v_actor_user uuid := p_user_id;
begin
  if (p_guest_id is null) = (p_user_id is null) then raise exception 'exactly one customer id is required'; end if;
  if p_limit < 1 or p_limit > 100 or p_offset < 0 then raise exception 'invalid page'; end if;

  if p_guest_id is not null then
    select * into v_guest from public.guest_visitors gv where gv.id=p_guest_id and gv.status='guest' and gv.identity_version=2;
    if not found then return jsonb_build_object('found',false); end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'quantity',case when (item->>'q') ~ '^[0-9]+$' then greatest(1,least(99,(item->>'q')::integer)) else 1 end,
      'product',to_jsonb(p),'size',case when ps.id is null then null else to_jsonb(ps) end,
      'offer',case when sp.id is null then null else jsonb_build_object('id',sp.id,'price',sp.price,'originalPrice',sp.original_price,'currency',sp.currency,'stockQuantity',sp.stock_quantity,'available',sp.is_available,'productUrl',sp.product_url,'storeName',st.name) end
    ) order by p.name),'[]'::jsonb) into v_cart
    from jsonb_array_elements(coalesce(v_guest.cart_snapshot,'[]'::jsonb)) item
    left join public.product_sizes ps on ps.id=case when (item->>'sid') ~* '^[0-9a-f-]{36}$' then (item->>'sid')::uuid else null end
    left join public.public_products p on p.id=ps.product_id
    left join public.store_products sp on sp.id=case when (item->>'storeProductId') ~* '^[0-9a-f-]{36}$' then (item->>'storeProductId')::uuid else null end and sp.product_size_id=ps.id
    left join public.stores st on st.id=sp.store_id;
    select count(*) into v_event_total from public.customer_product_events e where e.guest_id=p_guest_id;
    select count(*),coalesce(sum(cs.active_seconds),0) into v_session_total,v_active_seconds from public.customer_sessions cs where cs.guest_id=p_guest_id;
    select coalesce(jsonb_agg(row_to_json(x)::jsonb),'[]'::jsonb) into v_events from (
      select e.id,e.event_type as "eventType",e.occurred_at as "occurredAt",e.quantity,e.session_id as "sessionId",
        to_jsonb(p) as product,case when ps.id is null then null else to_jsonb(ps) end as size,
        case when sp.id is null then null else jsonb_build_object('id',sp.id,'price',sp.price,'originalPrice',sp.original_price,'currency',sp.currency,'stockQuantity',sp.stock_quantity,'available',sp.is_available,'productUrl',sp.product_url,'storeName',st.name) end as offer
      from public.customer_product_events e join public.public_products p on p.id=e.product_id
      left join public.product_sizes ps on ps.id=e.product_size_id
      left join public.store_products sp on sp.id=e.store_product_id
      left join public.stores st on st.id=sp.store_id
      where e.guest_id=p_guest_id order by e.occurred_at desc limit p_limit offset p_offset
    ) x;
    select coalesce(jsonb_agg(jsonb_build_object('sessionId',x.session_id,'startedAt',x.started_at,'lastSeenAt',x.last_seen_at,'endedAt',x.ended_at,'activeSeconds',x.active_seconds) order by x.started_at desc),'[]'::jsonb) into v_sessions from (
      select cs.session_id,cs.started_at,cs.last_seen_at,cs.ended_at,cs.active_seconds from public.customer_sessions cs where cs.guest_id=p_guest_id order by cs.started_at desc limit p_limit offset p_offset
    ) x;
    return jsonb_build_object('found',true,'actorType','guest','customer',jsonb_build_object('id',v_guest.id,'fingerprintHash',v_guest.fingerprint_hash,'firstSeenAt',v_guest.first_seen_at,'lastSeenAt',v_guest.last_seen_at),'currentCart',v_cart,'events',v_events,'sessions',v_sessions,'eventTotal',v_event_total,'visitCount',v_session_total,'activeSeconds',v_active_seconds,'hasMore',p_offset+p_limit<greatest(v_event_total,v_session_total));
  end if;

  select * into v_profile from public.profiles pr where pr.id=p_user_id and pr.role='customer';
  if not found then return jsonb_build_object('found',false); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'quantity',ci.quantity,'product',to_jsonb(p),'size',to_jsonb(ps),
    'offer',jsonb_build_object('id',sp.id,'price',sp.price,'originalPrice',sp.original_price,'currency',sp.currency,'stockQuantity',sp.stock_quantity,'available',sp.is_available,'productUrl',sp.product_url,'storeName',st.name)
  ) order by p.name),'[]'::jsonb) into v_cart
  from public.cart_items ci join public.store_products sp on sp.id=ci.store_product_id
  join public.product_sizes ps on ps.id=sp.product_size_id join public.public_products p on p.id=ps.product_id
  join public.stores st on st.id=sp.store_id where ci.user_id=p_user_id;
  select count(*) into v_event_total from public.customer_product_events e where e.user_id=p_user_id;
  select count(*),coalesce(sum(cs.active_seconds),0) into v_session_total,v_active_seconds from public.customer_sessions cs where cs.user_id=p_user_id;
  select coalesce(jsonb_agg(row_to_json(x)::jsonb),'[]'::jsonb) into v_events from (
    select e.id,e.event_type as "eventType",e.occurred_at as "occurredAt",e.quantity,e.session_id as "sessionId",
      to_jsonb(p) as product,case when ps.id is null then null else to_jsonb(ps) end as size,
      case when sp.id is null then null else jsonb_build_object('id',sp.id,'price',sp.price,'originalPrice',sp.original_price,'currency',sp.currency,'stockQuantity',sp.stock_quantity,'available',sp.is_available,'productUrl',sp.product_url,'storeName',st.name) end as offer
    from public.customer_product_events e join public.public_products p on p.id=e.product_id
    left join public.product_sizes ps on ps.id=e.product_size_id
    left join public.store_products sp on sp.id=e.store_product_id
    left join public.stores st on st.id=sp.store_id
    where e.user_id=p_user_id order by e.occurred_at desc limit p_limit offset p_offset
  ) x;
  select coalesce(jsonb_agg(jsonb_build_object('sessionId',x.session_id,'startedAt',x.started_at,'lastSeenAt',x.last_seen_at,'endedAt',x.ended_at,'activeSeconds',x.active_seconds) order by x.started_at desc),'[]'::jsonb) into v_sessions from (
    select cs.session_id,cs.started_at,cs.last_seen_at,cs.ended_at,cs.active_seconds from public.customer_sessions cs where cs.user_id=p_user_id order by cs.started_at desc limit p_limit offset p_offset
  ) x;
  return jsonb_build_object('found',true,'actorType','customer','customer',to_jsonb(v_profile),'currentCart',v_cart,'events',v_events,'sessions',v_sessions,'eventTotal',v_event_total,'visitCount',v_session_total,'activeSeconds',v_active_seconds,'hasMore',p_offset+p_limit<greatest(v_event_total,v_session_total));
end;
$$;

revoke all on function public.record_customer_session(text,uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.record_customer_product_event(text,text,uuid,uuid,text,uuid,uuid,uuid,integer) from public, anon, authenticated;
revoke all on function public.customer_activity_summary(text,text) from public, anon, authenticated;
revoke all on function public.platform_customer_activity_detail(uuid,uuid,integer,integer) from public, anon, authenticated;
grant execute on function public.record_customer_session(text,uuid,uuid,text) to service_role;
grant execute on function public.record_customer_product_event(text,text,uuid,uuid,text,uuid,uuid,uuid,integer) to service_role;
grant execute on function public.customer_activity_summary(text,text) to service_role;
grant execute on function public.platform_customer_activity_detail(uuid,uuid,integer,integer) to service_role;

commit;
