-- Rolls back migrations/20261024165336_customer_data_hardening.sql.
-- Drops the size and format ceilings, restores the previous bodies of replace_customer_cart and handle_new_user
-- (the cart function goes back to server-only access), and reopens the anonymous insert policy on analytics_events.
begin;

alter table public.cart_items drop constraint if exists cart_items_quantity_max;

alter table public.checkout_sessions
  drop constraint if exists checkout_sessions_tracking_len,
  drop constraint if exists checkout_sessions_name_len,
  drop constraint if exists checkout_sessions_phone_len,
  drop constraint if exists checkout_sessions_email_len,
  drop constraint if exists checkout_sessions_address_len,
  drop constraint if exists checkout_sessions_currency_fmt;

alter table public.store_order_requests
  drop constraint if exists store_order_requests_tracking_len,
  drop constraint if exists store_order_requests_name_len,
  drop constraint if exists store_order_requests_phone_len,
  drop constraint if exists store_order_requests_email_len,
  drop constraint if exists store_order_requests_address_len,
  drop constraint if exists store_order_requests_notes_len;

alter table public.contact_messages
  drop constraint if exists contact_messages_name_len,
  drop constraint if exists contact_messages_email_len,
  drop constraint if exists contact_messages_phone_len,
  drop constraint if exists contact_messages_message_len;

alter table public.reviews drop constraint if exists reviews_comment_len;

alter table public.profiles
  drop constraint if exists profiles_full_name_len,
  drop constraint if exists profiles_phone_len,
  drop constraint if exists profiles_avatar_url_fmt;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.profiles (id, full_name, phone)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), new.phone)
  on conflict (id) do nothing;
  return new;
end $function$;

create or replace function public.replace_customer_cart(p_items jsonb)
returns setof public.cart_items
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_item jsonb;
  v_store_product_id uuid;
  v_quantity integer;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  delete from public.cart_items where user_id = v_user_id;

  for v_item in
    select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    begin
      v_store_product_id := nullif(v_item->>'storeProductId', '')::uuid;
      v_quantity := (v_item->>'quantity')::integer;
    exception when others then
      v_store_product_id := null;
      v_quantity := null;
    end;

    if v_store_product_id is null or coalesce(v_quantity, 0) < 1 then
      continue;
    end if;

    if exists (select 1 from public.store_products sp where sp.id = v_store_product_id) then
      insert into public.cart_items (user_id, store_product_id, quantity)
      values (v_user_id, v_store_product_id, v_quantity)
      on conflict (user_id, store_product_id)
      do update set quantity = excluded.quantity, updated_at = now();
    end if;
  end loop;

  return query
  select c.*
  from public.cart_items c
  where c.user_id = v_user_id
  order by c.updated_at desc;
end;
$function$;

revoke execute on function public.replace_customer_cart(jsonb) from public, anon, authenticated;
grant execute on function public.replace_customer_cart(jsonb) to service_role;

drop policy if exists event_insert on public.analytics_events;
grant insert on public.analytics_events to anon;
create policy event_insert on public.analytics_events
  for insert to anon, authenticated
  with check ((user_id is null) or (user_id = (select auth.uid())));

commit;
