-- Phase 1 follow-up: the courier's address line in the order is composed from the parts «حسابي» now keeps (governorate, city, street, building, floor, flat),
-- in the same order and with the same de-duplication as the page (acctOrderPrefill), so the order carries exactly the line the customer saw.
-- The snapshot keeps the parts as well as the line. Only function bodies change; no table, no data.
create or replace function private.compose_ship_address(v public.customer_details)
returns text
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  with parts(txt, ord) as (
    select * from unnest(array[
      case when v.ship_same then v.governorate else v.ship_governorate end,
      case when v.ship_same then v.city else v.ship_city end,
      coalesce(nullif(btrim(case when v.ship_same then v.address else v.ship_address end), ''), nullif(btrim(v.address), '')),
      case when nullif(btrim(case when v.ship_same then v.building_no else v.ship_building_no end), '') is not null
           then 'مبنى ' || btrim(case when v.ship_same then v.building_no else v.ship_building_no end) end,
      case when nullif(btrim(case when v.ship_same then v.floor_no else v.ship_floor_no end), '') is not null
           then 'الدور ' || btrim(case when v.ship_same then v.floor_no else v.ship_floor_no end) end,
      case when nullif(btrim(case when v.ship_same then v.apartment_no else v.ship_apartment_no end), '') is not null
           then 'شقة ' || btrim(case when v.ship_same then v.apartment_no else v.ship_apartment_no end) end
    ]) with ordinality as t(txt, ord)
  ), cleaned as (
    select btrim(txt) as txt, ord from parts where nullif(btrim(txt), '') is not null
  ), firsts as (
    select txt, min(ord) as ord from cleaned group by txt
  )
  select string_agg(txt, '، ' order by ord) from firsts
$function$;
revoke all on function private.compose_ship_address(public.customer_details) from public, anon, authenticated;

create or replace function private.build_customer_snapshot(p_user_id uuid, p_name text, p_phone text, p_email text, p_address text, p_notes text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v public.customer_details;
  v_delivery jsonb := jsonb_build_object('name', p_name, 'phone', p_phone, 'email', p_email, 'address', p_address, 'notes', p_notes);
begin
  select * into v from public.customer_details cd where cd.user_id = p_user_id;
  if not found then
    return jsonb_build_object('source', 'order_columns', 'capturedAt', now(), 'delivery', v_delivery);
  end if;
  return jsonb_build_object(
    'source', 'customer_details',
    'capturedAt', now(),
    'buyer', jsonb_build_object('name', v.full_name, 'phone', v.phone, 'email', p_email, 'governorate', v.governorate,
                                'city', v.city, 'address', v.address, 'building', v.building_no, 'floor', v.floor_no,
                                'apartment', v.apartment_no, 'lat', v.address_lat, 'lng', v.address_lng),
    'shipping', jsonb_build_object('sameAsBuyer', v.ship_same,
                                   'governorate', case when v.ship_same then v.governorate else v.ship_governorate end,
                                   'city', case when v.ship_same then v.city else v.ship_city end,
                                   'address', case when v.ship_same then v.address else v.ship_address end,
                                   'building', case when v.ship_same then v.building_no else v.ship_building_no end,
                                   'floor', case when v.ship_same then v.floor_no else v.ship_floor_no end,
                                   'apartment', case when v.ship_same then v.apartment_no else v.ship_apartment_no end,
                                   'addressLine', private.compose_ship_address(v),
                                   'lat', case when v.ship_same then v.address_lat else v.ship_lat end,
                                   'lng', case when v.ship_same then v.address_lng else v.ship_lng end),
    'recipient', case when v.recipient_name is not null or v.recipient_phone is not null
                      then jsonb_build_object('name', v.recipient_name, 'phone', v.recipient_phone) end,
    'deliveryNotes', v.delivery_notes,
    'delivery', v_delivery);
end;
$function$;

create or replace function public.place_store_order(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_store_id uuid;
  v_key text;
  v_cd public.customer_details;
  v_email text;
  v_customer jsonb;
  v_lat double precision;
  v_lng double precision;
  v_address text;
  v_notes text;
  v_lines jsonb := '[]'::jsonb;
  v_signature jsonb;
  v_subtotal numeric := 0;
  v_expected numeric;
  v_existing uuid;
  v_session jsonb;
  v_tracking text;
  v_attempt integer;
  v_result jsonb;
  v_request_id uuid;
  r record;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Order payload is required';
  end if;
  begin
    v_store_id := nullif(p_payload->>'storeId', '')::uuid;
  exception when others then
    v_store_id := null;
  end;
  if v_store_id is null or not exists (select 1 from public.stores s where s.id = v_store_id and s.status = 'active') then
    raise exception 'Invalid or inactive store';
  end if;
  v_key := nullif(trim(p_payload->>'idempotencyKey'), '');
  if v_key is null or char_length(v_key) not between 8 and 64 then
    raise exception 'Invalid retry key';
  end if;

  -- One order at a time per customer: a double tap, or a retry that overlaps the first call, waits here and then finds the first call's key.
  perform pg_advisory_xact_lock(hashtextextended('place_store_order:' || v_user_id::text, 0));

  select i.request_id into v_existing from private.store_order_idempotency i where i.user_id = v_user_id and i.idem_key = v_key;
  if found then
    if not exists (select 1 from public.store_order_requests q where q.id = v_existing and q.user_id = v_user_id and q.store_id = v_store_id) then
      raise exception 'Invalid retry key';
    end if;
    return private.order_result(v_existing) || jsonb_build_object('duplicate', true);
  end if;

  if (select count(*) from public.store_order_requests q
      where q.user_id = v_user_id and q.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Too many orders, try again later';
  end if;

  -- The customer's data comes from his account, never from the browser. The first order completes it once.
  select * into v_cd from public.customer_details cd where cd.user_id = v_user_id;
  if not found or coalesce(btrim(v_cd.full_name), '') = '' or coalesce(btrim(v_cd.phone), '') = ''
     or coalesce(btrim(v_cd.governorate), '') = '' or coalesce(btrim(v_cd.address), '') = '' or coalesce(btrim(v_cd.ship_address), '') = '' then
    raise exception 'Account details are incomplete';
  end if;
  select u.email into v_email from auth.users u where u.id = v_user_id;
  v_lat := case when v_cd.ship_same then v_cd.address_lat else v_cd.ship_lat end;
  v_lng := case when v_cd.ship_same then v_cd.address_lng else v_cd.ship_lng end;
  v_address := private.compose_ship_address(v_cd);
  if v_lat is not null and v_lng is not null then
    v_address := v_address || E'\nhttps://www.google.com/maps?q=' || v_lat::text || ',' || v_lng::text;
  end if;
  v_notes := nullif(concat_ws(E'\n',
    case when nullif(btrim(v_cd.recipient_name), '') is not null or nullif(btrim(v_cd.recipient_phone), '') is not null
         then 'المشتري: ' || v_cd.full_name || ' - ' || v_cd.phone end,
    nullif(btrim(v_cd.delivery_notes), '')), '');
  v_customer := jsonb_build_object(
    'name', coalesce(nullif(btrim(v_cd.recipient_name), ''), v_cd.full_name),
    'phone', coalesce(nullif(btrim(v_cd.recipient_phone), ''), v_cd.phone),
    'email', coalesce(v_email, ''),
    'address', v_address,
    'notes', coalesce(v_notes, ''));

  -- The lines are the customer's saved cart for this store, priced by the live catalog. Nothing in the payload but the store and the key is read as truth.
  for r in
    select ci.id as cart_item_id, ci.quantity, sp.id as store_product_id, sp.product_size_id, sp.price, sp.currency, sp.is_available, sp.stock_quantity
    from public.cart_items ci
    join public.store_products sp on sp.id = ci.store_product_id
    where ci.user_id = v_user_id and sp.store_id = v_store_id
    order by ci.created_at, ci.id
  loop
    if not r.is_available or (r.stock_quantity is not null and r.stock_quantity < r.quantity) then
      raise exception 'Product is unavailable or has insufficient stock';
    end if;
    if r.currency is distinct from 'EGP' then
      raise exception 'Only EGP orders are supported';
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'cartItemId', r.cart_item_id, 'productSizeId', r.product_size_id, 'storeProductId', r.store_product_id,
      'quantity', r.quantity, 'unitPrice', r.price, 'total', round(r.price * r.quantity, 2)));
    v_subtotal := v_subtotal + round(r.price * r.quantity, 2);
  end loop;
  if jsonb_array_length(v_lines) = 0 then
    raise exception 'Cart is empty for this store';
  end if;

  -- What the customer saw is only a guard against a stale screen; it never sets a price.
  begin
    v_expected := coalesce(nullif(p_payload->>'expectedSubtotal', ''), nullif(p_payload->>'subtotal', ''))::numeric;
  exception when others then
    raise exception 'Subtotal mismatch';
  end;
  if v_expected is not null and abs(v_expected - v_subtotal) > 0.005 then
    raise exception 'Subtotal mismatch';
  end if;

  -- The same lines at the same prices, already waiting for the store, are the same order (a second tab, a reload).
  select jsonb_agg(jsonb_build_array(e->>'storeProductId', (e->>'quantity')::integer, (e->>'unitPrice')::numeric) order by e->>'storeProductId')
    into v_signature from jsonb_array_elements(v_lines) e;
  select q.id into v_existing
  from public.store_order_requests q
  where q.user_id = v_user_id and q.store_id = v_store_id and q.status = 'awaiting_store_confirmation'
    and not exists (select 1 from public.store_order_cancellation_requests c where c.request_id = q.id)
    and (select jsonb_agg(jsonb_build_array(i.store_product_id::text, i.quantity, i.unit_price) order by i.store_product_id::text)
         from public.store_order_request_items i where i.request_id = q.id) = v_signature
  order by q.created_at desc limit 1;
  if found then
    insert into private.store_order_idempotency (user_id, idem_key, request_id) values (v_user_id, v_key, v_existing);
    return private.order_result(v_existing) || jsonb_build_object('duplicate', true, 'sameOpenOrder', true);
  end if;

  -- The tracking number and the checkout session. A clash with a number made at the same instant by someone else is retried.
  for v_attempt in 1..8 loop
    v_tracking := private.new_tracking_number();
    begin
      v_session := public.create_checkout_session(jsonb_build_object(
        'trackingNumber', v_tracking, 'customer', v_customer, 'subtotal', v_subtotal));
      exit;
    exception when unique_violation then
      v_session := null;
    end;
  end loop;
  if v_session is null then
    raise exception 'Could not allocate a tracking number';
  end if;

  v_result := public.create_store_order_request(jsonb_build_object(
    'storeId', v_store_id, 'trackingNumber', v_tracking, 'checkoutTrackingNumber', v_tracking,
    'checkoutSessionId', v_session->>'id', 'customer', v_customer, 'items', v_lines,
    'subtotal', v_subtotal, 'currency', 'EGP'));
  v_request_id := (v_result->>'id')::uuid;

  update public.store_order_request_items ri
  set source_cart_item_id = (select ci.id from public.cart_items ci where ci.user_id = v_user_id and ci.store_product_id = ri.store_product_id)
  where ri.request_id = v_request_id;

  insert into private.store_order_idempotency (user_id, idem_key, request_id) values (v_user_id, v_key, v_request_id);

  -- The cart stays as it is: the lines leave it only after a trusted payment result (phase 2).
  return private.order_result(v_request_id) || jsonb_build_object('duplicate', false);
end;
$function$;
