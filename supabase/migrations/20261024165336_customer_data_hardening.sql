begin;

-- Customer data hardening (customer-side review of 2026-10-24).
-- Nothing here changes how an order is created, priced or tracked: it puts ceilings on what a client may write,
-- makes the cart write atomic, and closes one anonymous insert door on an unused table.

-- 1. A cart line never holds more than 99 units. The order functions already refuse a quantity above the stock;
--    this keeps a script from storing an absurd number in a customer's cart row. No row exceeds it today.
alter table public.cart_items
  add constraint cart_items_quantity_max check (quantity <= 99);

-- 2. replace_customer_cart: the cart is replaced inside one transaction (a failure leaves the old cart intact),
--    with at most 100 lines and each quantity clamped to 1..99. The browser used to DELETE and then POST in two
--    calls, so a dropped connection between them emptied the stored cart. The function is already in the schema
--    (revoked from clients on 2026-10-09 while nothing called it); it is granted again now that the browser does.
create or replace function public.replace_customer_cart(p_items jsonb)
returns setof public.cart_items
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_items jsonb := coalesce(p_items, '[]'::jsonb);
  v_item jsonb;
  v_store_product_id uuid;
  v_quantity integer;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'Cart items must be an array';
  end if;
  if jsonb_array_length(v_items) > 100 then
    raise exception 'A cart holds at most 100 lines';
  end if;

  delete from public.cart_items where user_id = v_user_id;

  for v_item in select value from jsonb_array_elements(v_items) loop
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
    v_quantity := least(v_quantity, 99);

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

revoke all on function public.replace_customer_cart(jsonb) from public, anon;
grant execute on function public.replace_customer_cart(jsonb) to authenticated, service_role;

-- 3. Length and format ceilings on the text a customer can store. Every honest value is far below these;
--    the tables are empty or hold nothing longer today (checked before applying).
alter table public.checkout_sessions
  add constraint checkout_sessions_tracking_len check (char_length(tracking_number) between 1 and 64),
  add constraint checkout_sessions_name_len check (char_length(customer_name) between 1 and 120),
  add constraint checkout_sessions_phone_len check (char_length(customer_phone) between 1 and 32),
  add constraint checkout_sessions_email_len check (customer_email is null or char_length(customer_email) <= 254),
  add constraint checkout_sessions_address_len check (char_length(customer_address) between 1 and 500),
  add constraint checkout_sessions_currency_fmt check (currency ~ '^[A-Z]{3}$');

alter table public.store_order_requests
  add constraint store_order_requests_tracking_len check (char_length(tracking_number) between 1 and 64),
  add constraint store_order_requests_name_len check (char_length(customer_name) between 1 and 120),
  add constraint store_order_requests_phone_len check (char_length(customer_phone) between 1 and 32),
  add constraint store_order_requests_email_len check (customer_email is null or char_length(customer_email) <= 254),
  add constraint store_order_requests_address_len check (char_length(customer_address) between 1 and 500),
  add constraint store_order_requests_notes_len check (customer_notes is null or char_length(customer_notes) <= 1000);

alter table public.contact_messages
  add constraint contact_messages_name_len check (name is null or char_length(name) <= 120),
  add constraint contact_messages_email_len check (email is null or char_length(email) <= 254),
  add constraint contact_messages_phone_len check (phone is null or char_length(phone) <= 32),
  add constraint contact_messages_message_len check (char_length(message) between 1 and 4000);

alter table public.reviews
  add constraint reviews_comment_len check (comment is null or char_length(comment) <= 2000);

alter table public.profiles
  add constraint profiles_full_name_len check (full_name is null or char_length(full_name) <= 120),
  add constraint profiles_phone_len check (phone is null or char_length(phone) <= 32),
  add constraint profiles_avatar_url_fmt check (avatar_url is null or (char_length(avatar_url) <= 1000 and avatar_url ~ '^https://[^[:space:]]+$'));

-- The signup trigger copies the name typed on the sign-up form into profiles. It now cuts it to the column ceiling,
-- so a long value can no longer make the sign-up itself fail on the new constraint.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.profiles (id, full_name, phone)
  values (new.id, left(coalesce(new.raw_user_meta_data->>'full_name', ''), 120), left(new.phone, 32))
  on conflict (id) do nothing;
  return new;
end $function$;

-- 4. analytics_events is not written by any code of the site (the tracking tables are customer_*), yet its policy let
--    any anonymous caller insert unlimited rows with a metadata object of any size. Anonymous access is removed;
--    a signed-in user may still insert (for themselves), with a bounded metadata object.
drop policy event_insert on public.analytics_events;
revoke insert on public.analytics_events from anon;
create policy event_insert on public.analytics_events
  for insert to authenticated
  with check ((user_id is null or user_id = (select auth.uid())) and pg_column_size(metadata) <= 2048);

commit;
