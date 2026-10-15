begin;

-- When a guest signs in, their basket, visit sessions and product events already move to the
-- account. The anonymous analytics rows kept under the browser's HMAC must go too, otherwise the
-- same person (and the same visit) is counted once as a guest and again as a customer.
-- Before they go, one row is written to guest_conversions: it is the record of "this browser became
-- this registered person". It keeps the visitor-to-registered funnel measurable, and it shows how
-- many browsers one person used, which is what turns browser counts into an estimate of people.
create table if not exists public.guest_conversions (
  visitor_hash text not null check (visitor_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references public.profiles(id) on delete cascade,
  first_seen_date date not null,
  converted_on date not null,
  converted_at timestamptz not null default now(),
  primary key (visitor_hash, user_id)
);
create index if not exists guest_conversions_user_idx on public.guest_conversions (user_id);
create index if not exists guest_conversions_dates_idx on public.guest_conversions (first_seen_date, converted_on);
alter table public.guest_conversions enable row level security;
revoke all on table public.guest_conversions from anon, authenticated;
grant all on table public.guest_conversions to service_role;
drop policy if exists guest_conversions_no_client_access on public.guest_conversions;
create policy guest_conversions_no_client_access on public.guest_conversions
  for all to anon, authenticated using (false) with check (false);

-- The old two-argument function is dropped so that a call can never be ambiguous.
drop function if exists public.claim_guest_browser_cart(text, uuid);

create or replace function public.claim_guest_browser_cart(
  p_fingerprint_hash text,
  p_user_id uuid,
  p_analytics_hash text default null
)
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

  if coalesce(p_analytics_hash, '') ~ '^[a-f0-9]{64}$' then
    insert into public.guest_conversions (visitor_hash, user_id, first_seen_date, converted_on)
    values (
      p_analytics_hash, p_user_id,
      coalesce((select min(activity_date) from public.guest_analytics_visits where visitor_hash = p_analytics_hash),
               (v_guest.first_seen_at at time zone 'Africa/Cairo')::date),
      (now() at time zone 'Africa/Cairo')::date)
    on conflict (visitor_hash, user_id) do nothing;
    delete from public.guest_product_analytics where visitor_hash = p_analytics_hash;
    delete from public.guest_analytics_visits where visitor_hash = p_analytics_hash;
  end if;

  delete from public.guest_visitors where id=v_guest.id;
  select coalesce(jsonb_agg(jsonb_build_object('sid',sp.product_size_id,'storeProductId',sp.id,'q',ci.quantity)),'[]'::jsonb)
    into v_cart from public.cart_items ci join public.store_products sp on sp.id=ci.store_product_id
    where ci.user_id=p_user_id;
  return jsonb_build_object('claimed',true,'cart',v_moved,'items',jsonb_array_length(v_cart),'snapshot',v_cart);
end;
$$;

-- Visitor funnel for a period (Cairo dates). Browsers are what can be observed; the estimate of
-- people divides them by the measured average number of browsers per registered person.
create or replace function public.guest_funnel_summary(p_period text default 'today')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_end date := (now() at time zone 'Africa/Cairo')::date;
  v_start date;
  v_new bigint := 0;
  v_converted bigint := 0;
  v_people bigint := 0;
  v_sample bigint := 0;
  v_per_person numeric := 1;
  v_valid_guest bigint := 0;
  v_valid_customer bigint := 0;
  v_start_ts timestamptz;
  v_end_ts timestamptz;
begin
  if p_period not in ('today','week','month','year') then raise exception 'invalid funnel period'; end if;
  v_start := case p_period when 'today' then v_end when 'week' then v_end-6 when 'month' then v_end-29 else v_end-364 end;

  v_start_ts := v_start::timestamp at time zone 'Africa/Cairo';
  v_end_ts := (v_end+1)::timestamp at time zone 'Africa/Cairo';
  -- A valid visit is counted like a video view: a real visit (one session, shared by all tabs of
  -- a browser, renewed after 30 idle minutes) that lasted at least 10 active seconds or did
  -- something with a product. Instant bounces and bots that never interact are not counted.
  select count(*) filter (where cs.guest_id is not null), count(*) filter (where cs.user_id is not null)
    into v_valid_guest, v_valid_customer
    from public.customer_sessions cs
    where cs.started_at >= v_start_ts and cs.started_at < v_end_ts
      and (cs.active_seconds >= 10 or exists (select 1 from public.customer_product_events e where e.session_id = cs.session_id));

  select count(*) into v_new from (
    select visitor_hash, min(first_date) as first_date from (
      select visitor_hash, min(activity_date) as first_date from public.guest_analytics_visits group by visitor_hash
      union all
      select visitor_hash, first_seen_date from public.guest_conversions
    ) u group by visitor_hash
  ) seen where first_date between v_start and v_end;

  select count(distinct visitor_hash) into v_converted from public.guest_conversions where first_seen_date between v_start and v_end;
  select count(distinct user_id) into v_people from public.guest_conversions where converted_on between v_start and v_end;
  select count(*), coalesce(avg(c), 1) into v_sample, v_per_person
    from (select count(distinct visitor_hash) c from public.guest_conversions group by user_id) x;

  return jsonb_build_object(
    'period', p_period, 'startDate', v_start, 'endDate', v_end,
    'validVisitsGuest', v_valid_guest,
    'validVisitsCustomer', v_valid_customer,
    'newBrowsers', v_new,
    'convertedBrowsers', v_converted,
    'registeredPeople', v_people,
    'conversionRate', case when v_new > 0 then round(v_converted::numeric / v_new, 4) else 0 end,
    'browsersPerPerson', round(greatest(v_per_person, 1), 2),
    'browsersPerPersonSample', v_sample,
    'estimatedPeople', greatest(0, round(v_new / greatest(v_per_person, 1)))
  );
end;
$$;
revoke all on function public.guest_funnel_summary(text) from public, anon, authenticated;
grant execute on function public.guest_funnel_summary(text) to service_role;

revoke all on function public.claim_guest_browser_cart(text,uuid,text) from public, anon, authenticated;
grant execute on function public.claim_guest_browser_cart(text,uuid,text) to service_role;

commit;
