-- Keep checkout and store-order records bound to the authenticated user.
-- Existing user_id columns remain nullable for historical/guest compatibility,
-- but authenticated creation paths must always resolve auth.uid().
create or replace function public.create_checkout_session(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_session public.checkout_sessions;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;
  if coalesce(trim(p_payload->'customer'->>'name'),'') = ''
     or coalesce(trim(p_payload->'customer'->>'phone'),'') = ''
     or coalesce(trim(p_payload->'customer'->>'address'),'') = '' then
    raise exception 'Customer details are required';
  end if;
  insert into public.checkout_sessions
    (tracking_number, user_id, customer_name, customer_phone, customer_email,
     customer_address, currency, subtotal)
  values
    (p_payload->>'trackingNumber', v_user,
     trim(p_payload->'customer'->>'name'),
     trim(p_payload->'customer'->>'phone'),
     nullif(trim(p_payload->'customer'->>'email'), ''),
     trim(p_payload->'customer'->>'address'),
     coalesce(nullif(p_payload->>'currency', ''), 'EGP'),
     coalesce((p_payload->>'subtotal')::numeric, 0))
  returning * into v_session;
  return jsonb_build_object(
    'id', v_session.id,
    'trackingNumber', v_session.tracking_number,
    'status', v_session.status);
end;
$$;

create or replace function public.create_store_order_request(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_request public.store_order_requests;
  v_item jsonb;
  v_store_id uuid;
  v_user_id uuid := auth.uid();
  v_checkout_session_id uuid := nullif(p_payload->>'checkoutSessionId', '')::uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  v_store_id := (p_payload->>'storeId')::uuid;
  if not exists (
    select 1 from public.stores s
    where s.id = v_store_id and s.status = 'active'
  ) then
    raise exception 'Invalid or inactive store';
  end if;
  if v_checkout_session_id is not null and not exists (
    select 1 from public.checkout_sessions c
    where c.id = v_checkout_session_id and c.user_id = v_user_id
  ) then
    raise exception 'Checkout session does not belong to the authenticated user';
  end if;
  if coalesce(trim(p_payload->'customer'->>'name'),'') = ''
     or coalesce(trim(p_payload->'customer'->>'phone'),'') = ''
     or coalesce(trim(p_payload->'customer'->>'address'),'') = '' then
    raise exception 'Customer details are required';
  end if;
  insert into public.store_order_requests
    (tracking_number, checkout_tracking_number, checkout_session_id, store_id,
     user_id, customer_name, customer_phone, customer_email, customer_address,
     customer_notes, subtotal, currency, initial_payload)
  values
    (p_payload->>'trackingNumber',
     coalesce(nullif(p_payload->>'checkoutTrackingNumber', ''), p_payload->>'trackingNumber'),
     v_checkout_session_id, v_store_id, v_user_id,
     trim(p_payload->'customer'->>'name'),
     trim(p_payload->'customer'->>'phone'),
     nullif(trim(p_payload->'customer'->>'email'), ''),
     trim(p_payload->'customer'->>'address'),
     nullif(trim(p_payload->'customer'->>'notes'), ''),
     coalesce((p_payload->>'subtotal')::numeric, 0),
     coalesce(nullif(p_payload->>'currency', ''), 'EGP'), p_payload)
  returning * into v_request;

  for v_item in
    select value from jsonb_array_elements(coalesce(p_payload->'items', '[]'::jsonb))
  loop
    insert into public.store_order_request_items
      (request_id, store_product_id, product_size_id, product_name,
       brand_name, size_label, quantity, unit_price, line_total, currency)
    values
      (v_request.id,
       nullif(v_item->>'storeProductId', '')::uuid,
       nullif(v_item->>'productSizeId', '')::uuid,
       v_item->>'name', v_item->>'brand', nullif(v_item->>'size', ''),
       (v_item->>'quantity')::integer,
       (v_item->>'unitPrice')::numeric,
       (v_item->>'total')::numeric,
       coalesce(nullif(v_item->>'currency', ''), 'EGP'));
  end loop;

  insert into public.store_order_notifications
    (request_id, tracking_number, event_type, store_status, match_status, payload)
  values
    (v_request.id, v_request.tracking_number, 'initial_submitted',
     'awaiting_store_confirmation', 'matched', p_payload);

  return jsonb_build_object(
    'id', v_request.id,
    'trackingNumber', v_request.tracking_number,
    'checkoutTrackingNumber', v_request.checkout_tracking_number,
    'checkoutSessionId', v_request.checkout_session_id,
    'status', v_request.status);
end;
$$;

revoke all on function public.create_checkout_session(jsonb) from public;
grant execute on function public.create_checkout_session(jsonb) to authenticated;
revoke all on function public.create_store_order_request(jsonb) from public;
grant execute on function public.create_store_order_request(jsonb) to authenticated;
