-- A visitor who creates an account keeps his cart and hearts even when the confirmation link is opened in ANOTHER browser
-- (owner, 9 Nov 2026: registered in Opera, confirmed in Chrome, and the account started empty). A visitor's lists live in the browser
-- he built them in, so the browser that registers hands them to the server for the new (still unconfirmed) account, and the account
-- picks them up the first time it is confirmed or signed into.
--
-- The row is transport only: written by the server while the account is new and unconfirmed (stash_signup_carry), emptied and marked used
-- when the account takes it (claim_signup_carry). Clients cannot read or write it. It goes with the account (on delete cascade); a row of an
-- account that never confirmed is dropped after 30 days. A confirmed account's data is never deleted by this.
create table public.signup_carry (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  cart        jsonb not null default '[]'::jsonb,
  favs        jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  consumed_at timestamptz,
  constraint signup_carry_cart_array check (jsonb_typeof(cart) = 'array' and jsonb_array_length(cart) <= 100),
  constraint signup_carry_favs_array check (jsonb_typeof(favs) = 'array' and jsonb_array_length(favs) <= 200)
);

comment on table public.signup_carry is 'Cart and hearts a visitor had when he created his account, carried to the account at its first confirmation or sign-in (it may be confirmed in another browser). Server only; emptied once taken.';

alter table public.signup_carry enable row level security;
revoke all on public.signup_carry from public, anon, authenticated;
grant all on public.signup_carry to service_role;

-- Writes the carry of a NEW account: only while the account exists, is a customer, has not confirmed its e-mail and is under 24 hours old.
-- The lists are re-read here, never trusted: a cart line must name a real store product (its size comes from the product), a heart a real size.
create or replace function public.stash_signup_carry(p_user_id uuid, p_cart jsonb, p_favs jsonb)
returns boolean
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
declare
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_cart jsonb;
  v_favs jsonb;
begin
  if p_user_id is null
     or jsonb_typeof(coalesce(p_cart, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_favs, '[]'::jsonb)) <> 'array' then
    return false;
  end if;
  if not exists (
    select 1 from auth.users u join public.profiles pr on pr.id = u.id
    where u.id = p_user_id and u.email_confirmed_at is null and u.created_at > now() - interval '24 hours' and pr.role = 'customer'
  ) then
    return false;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('sid', x.sid, 'storeProductId', x.spid, 'q', x.q)), '[]'::jsonb)
    into v_cart
  from (
    select sp.product_size_id as sid, sp.id as spid, max(c.q) as q
    from (
      select (e->>'storeProductId')::uuid as spid,
             least(99, greatest(1, case when (e->>'q') ~ '^[0-9]{1,3}$' then (e->>'q')::integer else 1 end)) as q
      from jsonb_array_elements(coalesce(p_cart, '[]'::jsonb)) e
      where jsonb_typeof(e) = 'object' and (e->>'storeProductId') ~* v_uuid
      limit 100
    ) c
    join public.store_products sp on sp.id = c.spid
    group by sp.product_size_id, sp.id
  ) x;

  select coalesce(jsonb_agg(ps.id), '[]'::jsonb)
    into v_favs
  from (
    select distinct (e #>> '{}')::uuid as sid
    from (select e from jsonb_array_elements(coalesce(p_favs, '[]'::jsonb)) e limit 200) f
    where jsonb_typeof(e) = 'string' and (e #>> '{}') ~* v_uuid
  ) s
  join public.product_sizes ps on ps.id = s.sid;

  if jsonb_array_length(v_cart) = 0 and jsonb_array_length(v_favs) = 0 then
    return false;
  end if;

  insert into public.signup_carry (user_id, cart, favs)
  values (p_user_id, v_cart, v_favs)
  on conflict (user_id) do update
    set cart = excluded.cart, favs = excluded.favs, created_at = now()
    where public.signup_carry.consumed_at is null;

  delete from public.signup_carry sc
  where sc.consumed_at is null and sc.created_at < now() - interval '30 days'
    and exists (select 1 from auth.users u where u.id = sc.user_id and u.email_confirmed_at is null);

  return true;
end;
$function$;

-- The account takes its carry: only a confirmed account, only once. A line already in the account's cart keeps the larger quantity
-- (never the sum: the same list may reach the account from two places, and the browser merges by the larger one too).
create or replace function public.claim_signup_carry(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
declare
  v_row public.signup_carry%rowtype;
  v_cart integer := 0;
  v_favs integer := 0;
begin
  if p_user_id is null
     or not exists (select 1 from auth.users u where u.id = p_user_id and u.email_confirmed_at is not null) then
    return jsonb_build_object('claimed', false, 'cart', 0, 'favs', 0);
  end if;

  select * into v_row from public.signup_carry where user_id = p_user_id and consumed_at is null for update;
  if not found then
    return jsonb_build_object('claimed', false, 'cart', 0, 'favs', 0);
  end if;

  insert into public.cart_items (user_id, store_product_id, quantity)
  select p_user_id, (e->>'storeProductId')::uuid, least(99, greatest(1, (e->>'q')::integer))
  from jsonb_array_elements(v_row.cart) e
  where exists (select 1 from public.store_products sp where sp.id = (e->>'storeProductId')::uuid)
  on conflict (user_id, store_product_id) do update
    set quantity = greatest(public.cart_items.quantity, excluded.quantity), updated_at = now();
  get diagnostics v_cart = row_count;

  insert into public.favorites (user_id, product_size_id)
  select p_user_id, (e #>> '{}')::uuid
  from jsonb_array_elements(v_row.favs) e
  where exists (select 1 from public.product_sizes ps where ps.id = (e #>> '{}')::uuid)
  on conflict (user_id, product_size_id) do nothing;
  get diagnostics v_favs = row_count;

  update public.signup_carry set consumed_at = now(), cart = '[]'::jsonb, favs = '[]'::jsonb where user_id = p_user_id;
  return jsonb_build_object('claimed', true, 'cart', v_cart, 'favs', v_favs);
end;
$function$;

revoke all on function public.stash_signup_carry(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.claim_signup_carry(uuid) from public, anon, authenticated;
grant execute on function public.stash_signup_carry(uuid, jsonb, jsonb) to service_role;
grant execute on function public.claim_signup_carry(uuid) to service_role;

-- The guest cart of a browser is merged into an account's cart by the LARGER quantity, not the sum. With the carry above the same lines can
-- already be in the account when the browser that registered signs in and claims its guest cart; adding them would double every quantity.
-- (The page merges the local and the account cart by the larger quantity too.) Everything else in the function is unchanged.
create or replace function public.claim_guest_browser_cart(p_fingerprint_hash text, p_analytics_hash text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
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
        set quantity = greatest(public.cart_items.quantity, excluded.quantity), updated_at = now();
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
$function$;
