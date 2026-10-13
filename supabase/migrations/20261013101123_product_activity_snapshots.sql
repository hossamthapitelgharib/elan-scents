
alter table public.customer_product_events
  add column if not exists product_snapshot jsonb not null default '{}'::jsonb;
alter table public.guest_product_analytics
  add column if not exists product_snapshot jsonb not null default '{}'::jsonb;
alter table public.cart_items
  add column if not exists product_snapshot jsonb not null default '{}'::jsonb;

-- One private, server-built snapshot contains the complete catalog row, its brand,
-- every size/image/note/category/occasion, and store listings as they existed at capture time.
create or replace function public.capture_product_snapshot(
  p_product_id uuid,
  p_product_size_id uuid default null,
  p_store_product_id uuid default null,
  p_snapshot_source text default 'activity'
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
with source as (
  select p.id as product_id, p as base_product, pp as public_product, b as brand
  from public.products p
  left join public.public_products pp on pp.id = p.id
  left join public.brands b on b.id = p.brand_id
  where p.id = p_product_id
)
select coalesce(to_jsonb(s.public_product), to_jsonb(s.base_product) || jsonb_build_object(
         'brand_name', to_jsonb(s.brand)->>'name', 'brand_slug', to_jsonb(s.brand)->>'slug'))
  || jsonb_build_object(
    'baseProduct', to_jsonb(s.base_product),
    'brand', to_jsonb(s.brand),
    'sizes', coalesce((select jsonb_agg(to_jsonb(ps) order by ps.size_ml, ps.id)
      from public.product_sizes ps where ps.product_id = s.product_id), '[]'::jsonb),
    'images', coalesce((select jsonb_agg(to_jsonb(pi) order by pi.sort_order, pi.id)
      from public.product_images pi where pi.product_id = s.product_id), '[]'::jsonb),
    'aromaticNotes', coalesce((select jsonb_agg(to_jsonb(an) order by an.name, an.id)
      from public.product_notes pn join public.aromatic_notes an on an.id = pn.note_id
      where pn.product_id = s.product_id), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(to_jsonb(c) order by c.id)
      from public.product_categories pc join public.categories c on c.id = pc.category_id
      where pc.product_id = s.product_id), '[]'::jsonb),
    'occasions', coalesce((select jsonb_agg(to_jsonb(o) order by o.id)
      from public.product_occasions po join public.occasions o on o.id = po.occasion_id
      where po.product_id = s.product_id), '[]'::jsonb),
    'selectedSize', (select to_jsonb(ps) from public.product_sizes ps
      where ps.product_id = s.product_id and (p_product_size_id is null or ps.id = p_product_size_id)
      order by (ps.id = p_product_size_id) desc nulls last, ps.size_ml, ps.id limit 1),
    'selectedOffer', (select jsonb_build_object(
        'id', sp.id, 'price', sp.price, 'originalPrice', sp.original_price,
        'discountPercentage', sp.discount_percentage, 'currency', sp.currency,
        'stockQuantity', sp.stock_quantity, 'available', sp.is_available,
        'productUrl', sp.product_url, 'storeName', st.name,
        'listing', to_jsonb(sp),
        'store', jsonb_build_object('id',st.id,'name',st.name,'slug',st.slug,
          'logo_url',st.logo_url,'image_url',st.image_url,'short_description',st.short_description,
          'website_url',st.website_url,'status',st.status))
      from public.store_products sp
      join public.product_sizes ps on ps.id = sp.product_size_id
      join public.stores st on st.id = sp.store_id
      where ps.product_id = s.product_id
        and (p_product_size_id is null or ps.id = p_product_size_id)
        and (p_store_product_id is null or sp.id = p_store_product_id)
      order by (sp.id = p_store_product_id) desc nulls last,
        (ps.id = p_product_size_id) desc nulls last, sp.is_available desc, sp.price, sp.id limit 1),
    'storeOffers', coalesce((select jsonb_agg(jsonb_build_object(
        'listing',to_jsonb(sp),'size',to_jsonb(ps),
        'store',jsonb_build_object('id',st.id,'name',st.name,'slug',st.slug,
          'logo_url',st.logo_url,'image_url',st.image_url,'short_description',st.short_description,
          'website_url',st.website_url,'status',st.status))
      order by sp.is_available desc, sp.price, st.name, sp.id)
      from public.store_products sp
      join public.product_sizes ps on ps.id = sp.product_size_id
      join public.stores st on st.id = sp.store_id
      where ps.product_id = s.product_id), '[]'::jsonb),
    'snapshotCapturedAt', now(),
    'snapshotSource', coalesce(nullif(p_snapshot_source,''),'activity')
  )
from source s;
$$;

-- Backfill existing history before removing cascading product foreign keys.
update public.customer_product_events e
set product_snapshot = public.capture_product_snapshot(e.product_id,e.product_size_id,e.store_product_id,'migration_backfill')
where e.product_snapshot = '{}'::jsonb;
update public.guest_product_analytics a
set product_snapshot = public.capture_product_snapshot(a.product_id,null,null,'migration_backfill')
where a.product_snapshot = '{}'::jsonb;

alter table public.customer_product_events
  drop constraint if exists customer_product_events_product_id_fkey;
alter table public.guest_product_analytics
  drop constraint if exists guest_product_analytics_product_id_fkey;

-- Registered carts retain a complete snapshot at each basket mutation.
create or replace function public.populate_cart_item_product_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product_id uuid;
  v_product_size_id uuid;
  v_snapshot jsonb;
begin
  select ps.product_id, ps.id into v_product_id, v_product_size_id
  from public.store_products sp
  join public.product_sizes ps on ps.id = sp.product_size_id
  where sp.id = new.store_product_id;
  if v_product_id is null then raise exception 'Cart product is unavailable'; end if;
  v_snapshot := public.capture_product_snapshot(v_product_id,v_product_size_id,new.store_product_id,'registered_cart');
  if v_snapshot is null then raise exception 'Cart product snapshot is unavailable'; end if;
  new.product_snapshot := v_snapshot;
  return new;
end;
$$;

drop trigger if exists cart_items_product_snapshot on public.cart_items;
create trigger cart_items_product_snapshot
before insert or update of store_product_id, quantity on public.cart_items
for each row execute function public.populate_cart_item_product_snapshot();

update public.cart_items ci
set product_snapshot = public.capture_product_snapshot(ps.product_id,ps.id,sp.id,'registered_cart_backfill')
from public.store_products sp
join public.product_sizes ps on ps.id = sp.product_size_id
where ci.store_product_id = sp.id and ci.product_snapshot = '{}'::jsonb;

-- Enrich every existing guest basket from authoritative catalog rows, not browser-provided fields.
update public.guest_visitors g
set cart_snapshot = coalesce((
  select jsonb_agg(item.value || jsonb_build_object('productSnapshot',
    coalesce(public.capture_product_snapshot(ps.product_id,ps.id,sp.id,'guest_cart_backfill'), item.value->'productSnapshot'))
    order by item.ordinality)
  from jsonb_array_elements(g.cart_snapshot) with ordinality as item(value,ordinality)
  left join public.store_products sp on sp.id = case
    when coalesce(item.value->>'storeProductId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (item.value->>'storeProductId')::uuid else null end
  left join public.product_sizes ps on ps.id = coalesce(sp.product_size_id, case
    when coalesce(item.value->>'sid','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (item.value->>'sid')::uuid else null end)
), '[]'::jsonb)
where jsonb_typeof(g.cart_snapshot) = 'array';

-- Guest basket writes are normalized and enriched server-side on every save.
create or replace function public.save_guest_browser_cart(
  p_fingerprint_hash text,
  p_analytics_hash text,
  p_cart_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_guest public.guest_visitors;
  v_item jsonb;
  v_size_id uuid;
  v_store_product_id uuid;
  v_product_id uuid;
  v_quantity integer;
  v_snapshot jsonb;
  v_cart jsonb := '[]'::jsonb;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
begin
  if coalesce(p_fingerprint_hash,'') !~ '^[a-f0-9]{64}$' or coalesce(p_analytics_hash,'') !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid visitor identifier';
  end if;
  if jsonb_typeof(coalesce(p_cart_snapshot,'[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_cart_snapshot,'[]'::jsonb)) > 100 then
    raise exception 'Invalid guest cart';
  end if;
  for v_item in select value from jsonb_array_elements(coalesce(p_cart_snapshot,'[]'::jsonb)) loop
    if coalesce(v_item->>'sid','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then continue; end if;
    v_size_id := (v_item->>'sid')::uuid;
    v_store_product_id := case
      when coalesce(v_item->>'storeProductId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (v_item->>'storeProductId')::uuid else null end;
    v_quantity := case when coalesce(v_item->>'q',v_item->>'quantity','') ~ '^[0-9]{1,3}$'
      then greatest(1,least(99,coalesce(v_item->>'q',v_item->>'quantity')::integer)) else 1 end;
    select ps.product_id into v_product_id from public.product_sizes ps where ps.id = v_size_id;
    if v_product_id is null then continue; end if;
    if v_store_product_id is not null and not exists (
      select 1 from public.store_products sp where sp.id = v_store_product_id and sp.product_size_id = v_size_id
    ) then v_store_product_id := null; end if;
    v_snapshot := public.capture_product_snapshot(v_product_id,v_size_id,v_store_product_id,'guest_cart');
    if v_snapshot is null then continue; end if;
    v_cart := v_cart || jsonb_build_array(jsonb_build_object(
      'sid',v_size_id,'storeProductId',v_store_product_id,'q',v_quantity,'productSnapshot',v_snapshot));
  end loop;

  insert into public.guest_visitors(fingerprint_hash,identity_version,cart_snapshot,last_seen_at)
  values(p_fingerprint_hash,2,v_cart,now())
  on conflict(fingerprint_hash) do update set identity_version=2,cart_snapshot=excluded.cart_snapshot,last_seen_at=now()
  returning * into v_guest;
  if v_guest.status = 'guest' then
    insert into public.guest_analytics_visits(visitor_hash,activity_date)
    values(p_analytics_hash,v_today)
    on conflict(visitor_hash,activity_date) do update set last_seen_at=now();
  end if;
  return jsonb_build_object('visitorId',v_guest.id,'status',v_guest.status,'cart',coalesce(v_guest.cart_snapshot,'[]'::jsonb));
end;
$$;

-- Product activity snapshots are authoritative, and the pseudonymous guest aggregate remains separate.
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
  v_product_size_id uuid := p_product_size_id;
  v_rows integer;
  v_snapshot jsonb;
begin
  if (p_user_id is null) = (p_fingerprint_hash is null) then return false; end if;
  if coalesce(p_event_type,'') not in ('view','search','cart_add','cart_remove') or p_product_id is null then return false; end if;
  if p_event_type in ('cart_add','cart_remove') and (p_quantity is null or p_quantity < 1 or p_quantity > 99) then return false; end if;
  if p_event_type in ('view','search') and p_quantity is not null and (p_quantity < 1 or p_quantity > 99) then return false; end if;
  if p_user_id is not null then
    if not exists(select 1 from public.profiles pr where pr.id=p_user_id and pr.role='customer') then return false; end if;
  else
    if p_fingerprint_hash !~ '^[a-f0-9]{64}$' or p_analytics_hash !~ '^[a-f0-9]{64}$' then return false; end if;
    select gv.id into v_guest_id from public.guest_visitors gv
      where gv.fingerprint_hash=p_fingerprint_hash and gv.status='guest' and gv.identity_version=2;
    if v_guest_id is null then return false; end if;
  end if;
  if not exists(select 1 from public.products p where p.id=p_product_id) then return false; end if;
  if v_product_size_id is null and p_store_product_id is not null then
    select sp.product_size_id into v_product_size_id from public.store_products sp where sp.id=p_store_product_id;
  end if;
  if v_product_size_id is not null and not exists(
    select 1 from public.product_sizes ps where ps.id=v_product_size_id and ps.product_id=p_product_id
  ) then return false; end if;
  if p_store_product_id is not null and not exists(
    select 1 from public.store_products sp where sp.id=p_store_product_id and sp.product_size_id=v_product_size_id
  ) then return false; end if;
  v_snapshot := public.capture_product_snapshot(p_product_id,v_product_size_id,p_store_product_id,'activity_event');
  if v_snapshot is null then return false; end if;
  if p_session_id is not null then
    perform public.record_customer_session(p_fingerprint_hash,p_user_id,p_session_id,'start');
    if not exists(select 1 from public.customer_sessions cs where cs.session_id=p_session_id
      and cs.guest_id is not distinct from v_guest_id and cs.user_id is not distinct from p_user_id) then return false; end if;
  end if;
  insert into public.customer_product_events(
    guest_id,user_id,session_id,event_type,product_id,product_size_id,store_product_id,quantity,product_snapshot
  ) values(
    v_guest_id,p_user_id,p_session_id,p_event_type,p_product_id,v_product_size_id,p_store_product_id,
    case when p_event_type in ('cart_add','cart_remove') then p_quantity else null end,v_snapshot
  );
  if v_guest_id is not null then
    insert into public.guest_product_analytics(visitor_hash,product_id,activity_date,event_type,event_count,product_snapshot,last_seen_at)
    values(p_analytics_hash,p_product_id,(now() at time zone 'Africa/Cairo')::date,p_event_type,1,v_snapshot,now())
    on conflict(visitor_hash,product_id,activity_date,event_type) do update
      set event_count=least(public.guest_product_analytics.event_count+1,1000000),
          product_snapshot=excluded.product_snapshot,last_seen_at=excluded.last_seen_at;
    update public.guest_visitors set last_seen_at=now() where id=v_guest_id;
  end if;
  return true;
end;
$$;

-- Keep older guest-cart clients on the same detailed event ledger and support removals.
create or replace function public.record_guest_product_activity(
  p_fingerprint_hash text,
  p_analytics_hash text,
  p_product_id uuid,
  p_event_type text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_guest_id uuid;
  v_snapshot jsonb;
begin
  if coalesce(p_fingerprint_hash,'') !~ '^[a-f0-9]{64}$' or coalesce(p_analytics_hash,'') !~ '^[a-f0-9]{64}$'
     or p_product_id is null or coalesce(p_event_type,'') not in ('view','search','cart_add','cart_remove') then return false; end if;
  select gv.id into v_guest_id from public.guest_visitors gv
    where gv.fingerprint_hash=p_fingerprint_hash and gv.status='guest' and gv.identity_version=2;
  if v_guest_id is null then return false; end if;
  v_snapshot := public.capture_product_snapshot(p_product_id,null,null,'legacy_guest_activity');
  if v_snapshot is null then return false; end if;
  insert into public.customer_product_events(guest_id,event_type,product_id,quantity,product_snapshot)
  values(v_guest_id,p_event_type,p_product_id,case when p_event_type in ('cart_add','cart_remove') then 1 else null end,v_snapshot);
  insert into public.guest_product_analytics(visitor_hash,product_id,activity_date,event_type,event_count,product_snapshot,last_seen_at)
  values(p_analytics_hash,p_product_id,(now() at time zone 'Africa/Cairo')::date,p_event_type,1,v_snapshot,now())
  on conflict(visitor_hash,product_id,activity_date,event_type) do update
    set event_count=least(public.guest_product_analytics.event_count+1,1000000),
        product_snapshot=excluded.product_snapshot,last_seen_at=excluded.last_seen_at;
  update public.guest_visitors set last_seen_at=now() where id=v_guest_id;
  return true;
end;
$$;

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
  v_top_viewed jsonb := '[]'::jsonb;
  v_top_searched jsonb := '[]'::jsonb;
  v_top_added jsonb := '[]'::jsonb;
  v_top_removed jsonb := '[]'::jsonb;
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
    select coalesce(jsonb_agg(jsonb_build_object('product',q.product,'operations',q.operations,'people',q.people) order by q.operations desc),'[]'::jsonb) into v_top_viewed
      from (select (jsonb_agg(a.product_snapshot order by a.last_seen_at desc)->0) product,sum(a.event_count)::bigint operations,count(distinct a.visitor_hash)::bigint people
        from public.guest_product_analytics a where a.event_type='view' and a.activity_date between v_start and v_end group by a.product_id order by sum(a.event_count) desc limit 20) q;
    select coalesce(jsonb_agg(jsonb_build_object('product',q.product,'operations',q.operations,'people',q.people) order by q.operations desc),'[]'::jsonb) into v_top_searched
      from (select (jsonb_agg(a.product_snapshot order by a.last_seen_at desc)->0) product,sum(a.event_count)::bigint operations,count(distinct a.visitor_hash)::bigint people
        from public.guest_product_analytics a where a.event_type='search' and a.activity_date between v_start and v_end group by a.product_id order by sum(a.event_count) desc limit 20) q;
    select coalesce(jsonb_agg(jsonb_build_object('product',q.product,'operations',q.operations,'people',q.people) order by q.operations desc),'[]'::jsonb) into v_top_added
      from (select (jsonb_agg(a.product_snapshot order by a.last_seen_at desc)->0) product,sum(a.event_count)::bigint operations,count(distinct a.visitor_hash)::bigint people
        from public.guest_product_analytics a where a.event_type='cart_add' and a.activity_date between v_start and v_end group by a.product_id order by sum(a.event_count) desc limit 20) q;
    select coalesce(jsonb_agg(jsonb_build_object('product',q.product,'operations',q.operations,'people',q.people) order by q.operations desc),'[]'::jsonb) into v_top_removed
      from (select (jsonb_agg(a.product_snapshot order by a.last_seen_at desc)->0) product,sum(a.event_count)::bigint operations,count(distinct a.visitor_hash)::bigint people
        from public.guest_product_analytics a where a.event_type='cart_remove' and a.activity_date between v_start and v_end group by a.product_id order by sum(a.event_count) desc limit 20) q;
  else
    select count(distinct e.user_id) into v_people from public.customer_product_events e where e.user_id is not null and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts;
    select count(*) filter(where cs.ended_at is null and cs.last_seen_at>=now()-interval '2 minutes'),count(*),coalesce(sum(cs.active_seconds),0)
      into v_active,v_sessions,v_seconds from public.customer_sessions cs where cs.user_id is not null and cs.started_at>=v_start_ts and cs.started_at<v_end_ts;
    select count(*) filter(where event_type='view'),count(*) filter(where event_type='search'),count(*) filter(where event_type='cart_add'),count(*) filter(where event_type='cart_remove')
      into v_views,v_searches,v_adds,v_removes from public.customer_product_events e where e.user_id is not null and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts;
    select coalesce(jsonb_agg(jsonb_build_object('product',q.product,'operations',q.operations,'people',q.people) order by q.operations desc),'[]'::jsonb) into v_top_viewed
      from (select (jsonb_agg(e.product_snapshot order by e.occurred_at desc)->0) product,count(*)::bigint operations,count(distinct e.user_id)::bigint people
        from public.customer_product_events e where e.user_id is not null and e.event_type='view' and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts group by e.product_id order by count(*) desc limit 20) q;
    select coalesce(jsonb_agg(jsonb_build_object('product',q.product,'operations',q.operations,'people',q.people) order by q.operations desc),'[]'::jsonb) into v_top_searched
      from (select (jsonb_agg(e.product_snapshot order by e.occurred_at desc)->0) product,count(*)::bigint operations,count(distinct e.user_id)::bigint people
        from public.customer_product_events e where e.user_id is not null and e.event_type='search' and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts group by e.product_id order by count(*) desc limit 20) q;
    select coalesce(jsonb_agg(jsonb_build_object('product',q.product,'operations',q.operations,'people',q.people) order by q.operations desc),'[]'::jsonb) into v_top_added
      from (select (jsonb_agg(e.product_snapshot order by e.occurred_at desc)->0) product,count(*)::bigint operations,count(distinct e.user_id)::bigint people
        from public.customer_product_events e where e.user_id is not null and e.event_type='cart_add' and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts group by e.product_id order by count(*) desc limit 20) q;
    select coalesce(jsonb_agg(jsonb_build_object('product',q.product,'operations',q.operations,'people',q.people) order by q.operations desc),'[]'::jsonb) into v_top_removed
      from (select (jsonb_agg(e.product_snapshot order by e.occurred_at desc)->0) product,count(*)::bigint operations,count(distinct e.user_id)::bigint people
        from public.customer_product_events e where e.user_id is not null and e.event_type='cart_remove' and e.occurred_at>=v_start_ts and e.occurred_at<v_end_ts group by e.product_id order by count(*) desc limit 20) q;
  end if;
  return jsonb_build_object('actorType',p_actor_type,'period',p_period,'startDate',v_start,'endDate',v_end,
    'people',v_people,'activeSessions',v_active,'visitCount',v_sessions,'activeSeconds',v_seconds,
    'productViews',v_views,'productSearches',v_searches,'cartAdds',v_adds,'cartRemoves',v_removes,
    'topViewed',v_top_viewed,'topSearched',v_top_searched,'topCartAdded',v_top_added,'topCartRemoved',v_top_removed);
end;
$$;

-- Detail API reads snapshots first and live relations only as a compatibility fallback.
create or replace function public.platform_customer_activity_detail(p_guest_id uuid,p_user_id uuid,p_limit integer default 100,p_offset integer default 0)
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
begin
  if (p_guest_id is null)=(p_user_id is null) then raise exception 'exactly one customer id is required'; end if;
  if p_limit<1 or p_limit>100 or p_offset<0 then raise exception 'invalid page'; end if;
  if p_guest_id is not null then
    select * into v_guest from public.guest_visitors gv where gv.id=p_guest_id and gv.status='guest' and gv.identity_version=2;
    if not found then return jsonb_build_object('found',false); end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'quantity',case when (item.value->>'q') ~ '^[0-9]+$' then greatest(1,least(99,(item.value->>'q')::integer)) else 1 end,
      'product',coalesce(item.value->'productSnapshot',public.capture_product_snapshot(ps.product_id,ps.id,sp.id,'detail_fallback')),
      'size',coalesce(item.value->'productSnapshot'->'selectedSize',to_jsonb(ps)),
      'offer',coalesce(item.value->'productSnapshot'->'selectedOffer',case when sp.id is null then null else jsonb_build_object(
        'id',sp.id,'price',sp.price,'originalPrice',sp.original_price,'currency',sp.currency,'stockQuantity',sp.stock_quantity,
        'available',sp.is_available,'productUrl',sp.product_url,'storeName',st.name,'listing',to_jsonb(sp)) end)
    ) order by coalesce(item.value->'productSnapshot'->>'name',p.name)),'[]'::jsonb) into v_cart
    from jsonb_array_elements(coalesce(v_guest.cart_snapshot,'[]'::jsonb)) item(value)
    left join public.store_products sp on sp.id=case when (item.value->>'storeProductId') ~* '^[0-9a-f-]{36}$' then (item.value->>'storeProductId')::uuid else null end
    left join public.product_sizes ps on ps.id=coalesce(sp.product_size_id,case when (item.value->>'sid') ~* '^[0-9a-f-]{36}$' then (item.value->>'sid')::uuid else null end)
    left join public.public_products p on p.id=ps.product_id
    left join public.stores st on st.id=sp.store_id;
    select count(*) into v_event_total from public.customer_product_events e where e.guest_id=p_guest_id;
    select count(*),coalesce(sum(cs.active_seconds),0) into v_session_total,v_active_seconds from public.customer_sessions cs where cs.guest_id=p_guest_id;
    select coalesce(jsonb_agg(row_to_json(x)::jsonb),'[]'::jsonb) into v_events from (
      select e.id,e.event_type as "eventType",e.occurred_at as "occurredAt",e.quantity,e.session_id as "sessionId",
        coalesce(e.product_snapshot,to_jsonb(p)) as product,e.product_snapshot as "productSnapshot",
        coalesce(e.product_snapshot->'selectedSize',to_jsonb(ps)) as size,
        coalesce(e.product_snapshot->'selectedOffer',case when sp.id is null then null else jsonb_build_object(
          'id',sp.id,'price',sp.price,'originalPrice',sp.original_price,'currency',sp.currency,'stockQuantity',sp.stock_quantity,
          'available',sp.is_available,'productUrl',sp.product_url,'storeName',st.name,'listing',to_jsonb(sp)) end) as offer
      from public.customer_product_events e left join public.public_products p on p.id=e.product_id
      left join public.product_sizes ps on ps.id=e.product_size_id left join public.store_products sp on sp.id=e.store_product_id
      left join public.stores st on st.id=sp.store_id where e.guest_id=p_guest_id
      order by e.occurred_at desc limit p_limit offset p_offset
    ) x;
    select coalesce(jsonb_agg(jsonb_build_object('sessionId',x.session_id,'startedAt',x.started_at,'lastSeenAt',x.last_seen_at,'endedAt',x.ended_at,'activeSeconds',x.active_seconds) order by x.started_at desc),'[]'::jsonb)
      into v_sessions from (select cs.session_id,cs.started_at,cs.last_seen_at,cs.ended_at,cs.active_seconds from public.customer_sessions cs
        where cs.guest_id=p_guest_id order by cs.started_at desc limit p_limit offset p_offset) x;
    return jsonb_build_object('found',true,'actorType','guest','customer',jsonb_build_object('id',v_guest.id,'fingerprintHash',v_guest.fingerprint_hash,
      'firstSeenAt',v_guest.first_seen_at,'lastSeenAt',v_guest.last_seen_at),'currentCart',v_cart,'events',v_events,'sessions',v_sessions,
      'eventTotal',v_event_total,'visitCount',v_session_total,'activeSeconds',v_active_seconds,'hasMore',p_offset+p_limit<greatest(v_event_total,v_session_total));
  end if;

  select * into v_profile from public.profiles pr where pr.id=p_user_id and pr.role='customer';
  if not found then return jsonb_build_object('found',false); end if;
  select coalesce(jsonb_agg(jsonb_build_object('quantity',ci.quantity,'product',ci.product_snapshot,
    'size',ci.product_snapshot->'selectedSize','offer',ci.product_snapshot->'selectedOffer') order by ci.product_snapshot->>'name'),'[]'::jsonb)
    into v_cart from public.cart_items ci where ci.user_id=p_user_id;
  select count(*) into v_event_total from public.customer_product_events e where e.user_id=p_user_id;
  select count(*),coalesce(sum(cs.active_seconds),0) into v_session_total,v_active_seconds from public.customer_sessions cs where cs.user_id=p_user_id;
  select coalesce(jsonb_agg(row_to_json(x)::jsonb),'[]'::jsonb) into v_events from (
    select e.id,e.event_type as "eventType",e.occurred_at as "occurredAt",e.quantity,e.session_id as "sessionId",
      coalesce(e.product_snapshot,to_jsonb(p)) as product,e.product_snapshot as "productSnapshot",
      coalesce(e.product_snapshot->'selectedSize',to_jsonb(ps)) as size,
      coalesce(e.product_snapshot->'selectedOffer',case when sp.id is null then null else jsonb_build_object(
        'id',sp.id,'price',sp.price,'originalPrice',sp.original_price,'currency',sp.currency,'stockQuantity',sp.stock_quantity,
        'available',sp.is_available,'productUrl',sp.product_url,'storeName',st.name,'listing',to_jsonb(sp)) end) as offer
    from public.customer_product_events e left join public.public_products p on p.id=e.product_id
    left join public.product_sizes ps on ps.id=e.product_size_id left join public.store_products sp on sp.id=e.store_product_id
    left join public.stores st on st.id=sp.store_id where e.user_id=p_user_id order by e.occurred_at desc limit p_limit offset p_offset
  ) x;
  select coalesce(jsonb_agg(jsonb_build_object('sessionId',x.session_id,'startedAt',x.started_at,'lastSeenAt',x.last_seen_at,'endedAt',x.ended_at,'activeSeconds',x.active_seconds) order by x.started_at desc),'[]'::jsonb)
    into v_sessions from (select cs.session_id,cs.started_at,cs.last_seen_at,cs.ended_at,cs.active_seconds from public.customer_sessions cs
      where cs.user_id=p_user_id order by cs.started_at desc limit p_limit offset p_offset) x;
  return jsonb_build_object('found',true,'actorType','customer','customer',to_jsonb(v_profile),'currentCart',v_cart,'events',v_events,'sessions',v_sessions,
    'eventTotal',v_event_total,'visitCount',v_session_total,'activeSeconds',v_active_seconds,'hasMore',p_offset+p_limit<greatest(v_event_total,v_session_total));
end;
$$;

-- Old client route writes into the same detailed history and the same ranking aggregate.
-- The product id remains as a stable historical identifier but no longer cascades history on catalog deletion.
revoke all on function public.capture_product_snapshot(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.capture_product_snapshot(uuid,uuid,uuid,text) to service_role;
revoke all on function public.populate_cart_item_product_snapshot() from public,anon,authenticated;
revoke all on function public.save_guest_browser_cart(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.save_guest_browser_cart(text,text,jsonb) to service_role;
revoke all on function public.record_customer_product_event(text,text,uuid,uuid,text,uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.record_customer_product_event(text,text,uuid,uuid,text,uuid,uuid,uuid,integer) to service_role;
revoke all on function public.record_guest_product_activity(text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.record_guest_product_activity(text,text,uuid,text) to service_role;
revoke all on function public.customer_activity_summary(text,text) from public,anon,authenticated;
grant execute on function public.customer_activity_summary(text,text) to service_role;
revoke all on function public.platform_customer_activity_detail(uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.platform_customer_activity_detail(uuid,uuid,integer,integer) to service_role;

grant all on public.customer_product_events,public.guest_product_analytics,public.cart_items to service_role;
comment on column public.customer_product_events.product_snapshot is 'Server-captured complete product, brand, size, images, taxonomy, and store-offer snapshot at activity time.';
comment on column public.guest_product_analytics.product_snapshot is 'Latest complete catalog snapshot for this pseudonymous daily product ranking; retained if the catalog row is deleted.';
comment on column public.cart_items.product_snapshot is 'Server-refreshed current product and store-offer snapshot for the registered customer basket.';

