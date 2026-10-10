begin;

-- Mark legacy device-attribute fingerprints separately. New visitors receive a random
-- browser-local identifier that is HMACed by the server before it reaches this table.
alter table public.guest_visitors
  add column if not exists identity_version smallint not null default 1;

create index if not exists guest_visitors_active_identity_idx
  on public.guest_visitors (identity_version, last_seen_at desc)
  where status = 'guest';

-- These analytics tables retain only a domain-separated HMAC, never the browser key,
-- a raw search query, or an account ID. This lets reporting survive basket transfer
-- while keeping the active guest identity/cart row deletable on sign-in.
create table if not exists public.guest_analytics_visits (
  visitor_hash text not null check (visitor_hash ~ '^[a-f0-9]{64}$'),
  activity_date date not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (visitor_hash, activity_date)
);

create table if not exists public.guest_product_analytics (
  visitor_hash text not null check (visitor_hash ~ '^[a-f0-9]{64}$'),
  product_id uuid not null references public.products(id) on delete cascade,
  activity_date date not null,
  event_type text not null check (event_type in ('view', 'search', 'cart_add')),
  event_count integer not null default 1 check (event_count between 1 and 1000000),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (visitor_hash, product_id, activity_date, event_type)
);

create index if not exists guest_product_analytics_date_type_idx
  on public.guest_product_analytics (activity_date desc, event_type, product_id);
create index if not exists guest_product_analytics_visitor_idx
  on public.guest_product_analytics (visitor_hash, activity_date desc);

alter table public.guest_analytics_visits enable row level security;
alter table public.guest_product_analytics enable row level security;
revoke all on table public.guest_analytics_visits from anon, authenticated;
revoke all on table public.guest_product_analytics from anon, authenticated;
grant all on table public.guest_analytics_visits to service_role;
grant all on table public.guest_product_analytics to service_role;

create or replace function public.resolve_guest_browser(
  p_fingerprint_hash text,
  p_analytics_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_guest public.guest_visitors;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
begin
  if coalesce(p_fingerprint_hash, '') !~ '^[a-f0-9]{64}$' or coalesce(p_analytics_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid visitor identifier';
  end if;

  insert into public.guest_visitors (fingerprint_hash, identity_version, last_seen_at)
  values (p_fingerprint_hash, 2, now())
  on conflict (fingerprint_hash) do update
    set identity_version = 2, last_seen_at = now()
  returning * into v_guest;

  if v_guest.status = 'guest' then
    insert into public.guest_analytics_visits (visitor_hash, activity_date)
    values (p_analytics_hash, v_today)
    on conflict (visitor_hash, activity_date) do update
      set last_seen_at = now();
  end if;

  return jsonb_build_object(
    'visitorId', v_guest.id,
    'status', v_guest.status,
    'cart', coalesce(v_guest.cart_snapshot, '[]'::jsonb)
  );
end;
$$;

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
  v_today date := (now() at time zone 'Africa/Cairo')::date;
begin
  if coalesce(p_fingerprint_hash, '') !~ '^[a-f0-9]{64}$' or coalesce(p_analytics_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid visitor identifier';
  end if;
  if jsonb_typeof(coalesce(p_cart_snapshot, '[]'::jsonb)) <> 'array' then
    raise exception 'Invalid guest cart';
  end if;
  if jsonb_array_length(coalesce(p_cart_snapshot, '[]'::jsonb)) > 100 then
    raise exception 'Invalid guest cart';
  end if;

  insert into public.guest_visitors (fingerprint_hash, identity_version, cart_snapshot, last_seen_at)
  values (p_fingerprint_hash, 2, coalesce(p_cart_snapshot, '[]'::jsonb), now())
  on conflict (fingerprint_hash) do update
    set identity_version = 2,
        cart_snapshot = excluded.cart_snapshot,
        last_seen_at = now()
  returning * into v_guest;

  if v_guest.status = 'guest' then
    insert into public.guest_analytics_visits (visitor_hash, activity_date)
    values (p_analytics_hash, v_today)
    on conflict (visitor_hash, activity_date) do update
      set last_seen_at = now();
  end if;

  return jsonb_build_object(
    'visitorId', v_guest.id,
    'status', v_guest.status,
    'cart', coalesce(v_guest.cart_snapshot, '[]'::jsonb)
  );
end;
$$;

create or replace function public.record_guest_product_activity(
  p_fingerprint_hash text,
  p_analytics_hash text,
  p_product_id uuid,
  p_event_type text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'Africa/Cairo')::date;
begin
  if coalesce(p_fingerprint_hash, '') !~ '^[a-f0-9]{64}$' or coalesce(p_analytics_hash, '') !~ '^[a-f0-9]{64}$'
     or p_product_id is null or coalesce(p_event_type, '') not in ('view', 'search', 'cart_add') then
    raise exception 'Invalid guest activity';
  end if;

  if not exists (
    select 1 from public.guest_visitors g
    where g.fingerprint_hash = p_fingerprint_hash
      and g.status = 'guest'
      and g.identity_version = 2
  ) then
    return false;
  end if;

  insert into public.guest_product_analytics as target
    (visitor_hash, product_id, activity_date, event_type, event_count)
  values (p_analytics_hash, p_product_id, v_today, p_event_type, 1)
  on conflict (visitor_hash, product_id, activity_date, event_type) do update
    set event_count = least(target.event_count + 1, 1000000),
        last_seen_at = now();

  update public.guest_visitors
  set last_seen_at = now()
  where fingerprint_hash = p_fingerprint_hash and status = 'guest' and identity_version = 2;

  return true;
end;
$$;

create or replace function public.claim_guest_browser_cart(
  p_fingerprint_hash text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_guest public.guest_visitors;
  v_item jsonb;
  v_store_product_id uuid;
  v_quantity integer;
  v_rows integer := 0;
begin
  if coalesce(p_fingerprint_hash, '') !~ '^[a-f0-9]{64}$' or p_user_id is null then
    raise exception 'Invalid guest claim';
  end if;

  select * into v_guest
  from public.guest_visitors
  where fingerprint_hash = p_fingerprint_hash
    and status = 'guest'
    and identity_version = 2
  for update;

  if not found then
    return jsonb_build_object('claimed', false, 'cart', 0);
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(v_guest.cart_snapshot, '[]'::jsonb))
  loop
    if coalesce(v_item->>'storeProductId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      continue;
    end if;
    v_store_product_id := (v_item->>'storeProductId')::uuid;
    v_quantity := case
      when coalesce(v_item->>'q', v_item->>'quantity', '') ~ '^[0-9]{1,3}$'
        then greatest(1, least(99, coalesce(v_item->>'q', v_item->>'quantity')::integer))
      else 1
    end;

    insert into public.cart_items as target (user_id, store_product_id, quantity)
    values (p_user_id, v_store_product_id, v_quantity)
    on conflict (user_id, store_product_id) do update
      set quantity = greatest(target.quantity, excluded.quantity);
    v_rows := v_rows + 1;
  end loop;

  -- The account cart is committed in the same transaction; the active guest record
  -- and its basket are removed only after every valid item has been transferred.
  delete from public.guest_visitors where id = v_guest.id;
  return jsonb_build_object('claimed', true, 'cart', v_rows);
end;
$$;

create or replace function public.guest_analytics_summary(p_period text default 'today')
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_end date := (now() at time zone 'Africa/Cairo')::date;
  v_start date;
  v_visitors bigint := 0;
  v_active_visitors bigint := 0;
  v_views bigint := 0;
  v_searches bigint := 0;
  v_cart_adds bigint := 0;
  v_top_products jsonb := '[]'::jsonb;
  v_basket_products jsonb := '[]'::jsonb;
begin
  if p_period not in ('today', 'week', 'month', 'year') then
    raise exception 'Invalid analytics period';
  end if;
  v_start := case p_period
    when 'today' then v_end
    when 'week' then v_end - 6
    when 'month' then v_end - 29
    else v_end - 364
  end;

  select count(distinct visitor_hash) into v_visitors
  from public.guest_analytics_visits
  where activity_date between v_start and v_end;

  select count(*) into v_active_visitors
  from public.guest_visitors
  where status = 'guest' and identity_version = 2;

  select coalesce(sum(event_count) filter (where event_type = 'view'), 0),
         coalesce(sum(event_count) filter (where event_type = 'search'), 0),
         coalesce(sum(event_count) filter (where event_type = 'cart_add'), 0)
  into v_views, v_searches, v_cart_adds
  from public.guest_product_analytics
  where activity_date between v_start and v_end;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.views desc, r.searches desc, r.cart_adds desc), '[]'::jsonb)
  into v_top_products
  from (
    select p.id as product_id, p.name, p.brand_name,
      coalesce(count(distinct a.visitor_hash) filter (where a.event_type = 'view'), 0) as viewers,
      coalesce(sum(a.event_count) filter (where a.event_type = 'view'), 0) as views,
      coalesce(count(distinct a.visitor_hash) filter (where a.event_type = 'search'), 0) as searchers,
      coalesce(sum(a.event_count) filter (where a.event_type = 'search'), 0) as searches,
      coalesce(count(distinct a.visitor_hash) filter (where a.event_type = 'cart_add'), 0) as cart_add_visitors,
      coalesce(sum(a.event_count) filter (where a.event_type = 'cart_add'), 0) as cart_adds
    from public.guest_product_analytics a
    join public.public_products p on p.id = a.product_id
    where a.activity_date between v_start and v_end
    group by p.id, p.name, p.brand_name
    order by views desc, searches desc, cart_adds desc
    limit 20
  ) r;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.baskets desc, r.units desc), '[]'::jsonb)
  into v_basket_products
  from (
    select p.id as product_id, p.name, p.brand_name,
      count(distinct g.id) as baskets,
      sum(case
        when coalesce(item.value->>'q', item.value->>'quantity', '') ~ '^[0-9]{1,3}$'
          then greatest(1, least(99, coalesce(item.value->>'q', item.value->>'quantity')::integer))
        else 1
      end) as units
    from public.guest_visitors g
    cross join lateral jsonb_array_elements(coalesce(g.cart_snapshot, '[]'::jsonb)) as item(value)
    join public.product_sizes s
      on s.id = case
        when coalesce(item.value->>'sid', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then (item.value->>'sid')::uuid
        else null
      end
    join public.public_products p on p.id = s.product_id
    where g.status = 'guest' and g.identity_version = 2
    group by p.id, p.name, p.brand_name
    order by baskets desc, units desc
    limit 20
  ) r;

  return jsonb_build_object(
    'period', p_period,
    'startDate', v_start,
    'endDate', v_end,
    'visitorCount', v_visitors,
    'activeVisitors', v_active_visitors,
    'productViews', v_views,
    'productSearches', v_searches,
    'cartAdds', v_cart_adds,
    'topProducts', v_top_products,
    'activeBasketProducts', v_basket_products
  );
end;
$$;

revoke all on function public.resolve_guest_browser(text, text) from public, anon, authenticated;
grant execute on function public.resolve_guest_browser(text, text) to service_role;
revoke all on function public.save_guest_browser_cart(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_guest_browser_cart(text, text, jsonb) to service_role;
revoke all on function public.record_guest_product_activity(text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_guest_product_activity(text, text, uuid, text) to service_role;
revoke all on function public.claim_guest_browser_cart(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_guest_browser_cart(text, uuid) to service_role;
revoke all on function public.guest_analytics_summary(text) from public, anon, authenticated;
grant execute on function public.guest_analytics_summary(text) to service_role;

comment on table public.guest_analytics_visits is 'Daily unique pseudonymous browser visits; separate from active guest and registered account records.';
comment on table public.guest_product_analytics is 'Daily per-browser product view, search-result, and add-to-cart aggregates; no raw queries or account IDs.';
comment on column public.guest_visitors.identity_version is '1=legacy device-feature hash; 2=server-HMAC of a random browser-local key.';

commit;
