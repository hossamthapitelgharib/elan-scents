begin;

-- Stores phase hardening (owner delegation of 2026-10-28). Closes the holes found in the live review of the stores
-- database, and gives the owner a way to link a store account to a store (there was none: store_accounts is empty and
-- clients cannot write it).
--
--   1. Orders are created only by place_store_order (owner decision of 2026-10-26: tracking numbers are made by the
--      server). The three older order functions let the caller choose the tracking number and are no longer used by the
--      storefront, so they are closed to clients (service_role keeps them). The two legacy insert policies on
--      orders/order_items (an own "pending" order with client-chosen values) are dropped.
--   2. Data rules the tables did not enforce: offers (title length, discount ranges, date order) and http(s)-only links
--      on stores and store_products (a store member can write product_url directly, and the page shows it as a link).
--   3. A store member can write store_products directly. The catalog "bestseller" flag feeds the public product
--      ranking, so only the platform admin (or the server sync, which has no user) may set it.
--   4. public.platform_audit_log: server-only record of admin actions (ids only, no personal data).
--   5. platform_store_accounts / platform_link_store_account / platform_unlink_store_account: service_role only, used by
--      /api/platform-store-accounts. Linking needs a confirmed email, refuses platform admins, and refuses a customer
--      who already has orders (turning that account into a store account would hide his order history: the owner's
--      rule is that order history is never erased). The profile role follows the links: customer -> store_admin on the
--      first link, back to customer when the last link is removed. A platform_admin is never touched.

-- 1. Orders only through place_store_order.
drop policy if exists own_insert on public.orders;
drop policy if exists own_insert on public.order_items;

revoke all on function public.create_checkout_session(jsonb) from public, anon, authenticated;
revoke all on function public.create_store_order_request(jsonb) from public, anon, authenticated;
revoke all on function public.create_store_order_request_from_cart(jsonb) from public, anon, authenticated;
grant execute on function public.create_checkout_session(jsonb) to service_role;
grant execute on function public.create_store_order_request(jsonb) to service_role;
grant execute on function public.create_store_order_request_from_cart(jsonb) to service_role;

-- 2. Data rules.
alter table public.offers
  add constraint offers_title_length check (char_length(btrim(title)) between 1 and 200),
  add constraint offers_description_length check (description is null or char_length(description) <= 2000),
  add constraint offers_discount_value_range check (
    discount_value is null
    or (discount_value > 0 and (discount_type is distinct from 'percentage' or discount_value <= 100))
  ),
  add constraint offers_dates_in_order check (start_date is null or end_date is null or end_date >= start_date);

alter table public.stores
  add constraint stores_links_are_http check (
    (website_url is null or website_url = '' or website_url ~* '^https?://[^[:space:]]+$')
    and (logo_url is null or logo_url = '' or logo_url ~* '^https?://[^[:space:]]+$')
    and (image_url is null or image_url = '' or image_url ~* '^https?://[^[:space:]]+$')
  );

alter table public.store_products
  add constraint store_products_link_is_http check (
    product_url is null or product_url = '' or product_url ~* '^https?://[^[:space:]]+$'
  );

-- 3. Platform-only catalog flag.
create or replace function private.guard_store_product_platform_columns()
returns trigger
language plpgsql
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  if (select auth.uid()) is not null and not private.is_platform_admin() then
    if (tg_op = 'INSERT' and new.is_catalog_bestseller)
       or (tg_op = 'UPDATE' and new.is_catalog_bestseller is distinct from old.is_catalog_bestseller) then
      raise exception 'Only the platform can set the bestseller flag' using errcode = '42501';
    end if;
  end if;
  return new;
end $function$;

revoke all on function private.guard_store_product_platform_columns() from public, anon, authenticated;

create trigger guard_platform_columns
  before insert or update on public.store_products
  for each row execute function private.guard_store_product_platform_columns();

-- 4. Audit log of platform-admin actions (server-only, like the other internal tables).
create table public.platform_audit_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_id uuid,
  action text not null check (char_length(action) between 1 and 80),
  target_type text not null check (char_length(target_type) between 1 and 80),
  target_id uuid,
  details jsonb not null default '{}'::jsonb
);
create index platform_audit_log_created_idx on public.platform_audit_log (created_at desc);
create index platform_audit_log_target_idx on public.platform_audit_log (target_type, target_id, created_at desc);
alter table public.platform_audit_log enable row level security;
revoke all on table public.platform_audit_log from public, anon, authenticated;
grant all on table public.platform_audit_log to service_role;

-- 5. Store accounts: list, link, unlink (service_role only; /api/platform-store-accounts checks the admin role).
create or replace function public.platform_store_accounts(p_store_id uuid default null)
returns table (
  account_id uuid,
  store_id uuid,
  store_name text,
  user_id uuid,
  email text,
  full_name text,
  account_role text,
  profile_role text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path to 'public', 'private', 'auth', 'pg_temp'
as $function$
  select a.id, a.store_id, s.name, a.user_id, u.email::text, p.full_name, a.role, p.role, a.created_at
  from public.store_accounts a
  join public.stores s on s.id = a.store_id
  join auth.users u on u.id = a.user_id
  left join public.profiles p on p.id = a.user_id
  where p_store_id is null or a.store_id = p_store_id
  order by s.name, a.created_at, a.id
$function$;

create or replace function public.platform_link_store_account(p_store_id uuid, p_email text, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'auth', 'pg_temp'
as $function$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user_id uuid;
  v_confirmed timestamptz;
  v_role text;
  v_account uuid;
begin
  if v_email = '' or char_length(v_email) > 320 or position('@' in v_email) < 2 then
    raise exception 'Invalid email';
  end if;
  if not exists (select 1 from public.stores where id = p_store_id) then
    raise exception 'Store not found';
  end if;

  select u.id, u.email_confirmed_at into v_user_id, v_confirmed
  from auth.users u
  where lower(u.email) = v_email and u.deleted_at is null
  order by u.created_at
  limit 1;
  if v_user_id is null then
    raise exception 'User not found';
  end if;
  if v_confirmed is null then
    raise exception 'Email not confirmed';
  end if;

  select p.role into v_role from public.profiles p where p.id = v_user_id for update;
  if v_role is null then
    raise exception 'User not found';
  end if;
  if v_role = 'platform_admin' then
    raise exception 'Platform admin cannot be a store account';
  end if;

  select a.id into v_account from public.store_accounts a where a.store_id = p_store_id and a.user_id = v_user_id;
  if v_account is not null then
    return jsonb_build_object('account_id', v_account, 'store_id', p_store_id, 'user_id', v_user_id, 'already_linked', true);
  end if;

  if v_role = 'customer' and (
       exists (select 1 from public.store_order_requests r where r.user_id = v_user_id)
       or exists (select 1 from public.checkout_sessions c where c.user_id = v_user_id)
       or exists (select 1 from public.orders o where o.user_id = v_user_id)
     ) then
    raise exception 'Customer has order history';
  end if;

  insert into public.store_accounts (store_id, user_id, role)
  values (p_store_id, v_user_id, 'store_admin')
  on conflict (store_id, user_id) do nothing
  returning id into v_account;
  if v_account is null then
    select a.id into v_account from public.store_accounts a where a.store_id = p_store_id and a.user_id = v_user_id;
    return jsonb_build_object('account_id', v_account, 'store_id', p_store_id, 'user_id', v_user_id, 'already_linked', true);
  end if;

  if v_role = 'customer' then
    update public.profiles set role = 'store_admin' where id = v_user_id;
  end if;

  insert into public.platform_audit_log (actor_id, action, target_type, target_id, details)
  values (p_actor, 'store_account_linked', 'store_account', v_account,
          jsonb_build_object('store_id', p_store_id, 'user_id', v_user_id, 'previous_role', v_role));

  return jsonb_build_object('account_id', v_account, 'store_id', p_store_id, 'user_id', v_user_id, 'already_linked', false);
end $function$;

create or replace function public.platform_unlink_store_account(p_account_id uuid, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'auth', 'pg_temp'
as $function$
declare
  v_store_id uuid;
  v_user_id uuid;
  v_role_restored boolean := false;
begin
  delete from public.store_accounts where id = p_account_id returning store_id, user_id into v_store_id, v_user_id;
  if v_user_id is null then
    raise exception 'Account not found';
  end if;

  if not exists (select 1 from public.store_accounts a where a.user_id = v_user_id) then
    update public.profiles set role = 'customer' where id = v_user_id and role = 'store_admin';
    v_role_restored := found;
  end if;

  insert into public.platform_audit_log (actor_id, action, target_type, target_id, details)
  values (p_actor, 'store_account_unlinked', 'store_account', p_account_id,
          jsonb_build_object('store_id', v_store_id, 'user_id', v_user_id, 'role_back_to_customer', v_role_restored));

  return jsonb_build_object('account_id', p_account_id, 'store_id', v_store_id, 'user_id', v_user_id, 'role_back_to_customer', v_role_restored);
end $function$;

revoke all on function public.platform_store_accounts(uuid) from public, anon, authenticated;
revoke all on function public.platform_link_store_account(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.platform_unlink_store_account(uuid, uuid) from public, anon, authenticated;
grant execute on function public.platform_store_accounts(uuid) to service_role;
grant execute on function public.platform_link_store_account(uuid, text, uuid) to service_role;
grant execute on function public.platform_unlink_store_account(uuid, uuid) to service_role;

commit;
