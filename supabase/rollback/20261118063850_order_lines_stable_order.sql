-- Back to reading the cart in the order the rows were added (the stage 1 text of public.place_store_order).

create or replace function public.place_store_order(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_user_id uuid := auth.uid();
  v_store_id uuid;
  v_key text;
  v_draft public.order_drafts;
  v_draft_id uuid;
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
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then raise exception 'Order payload is required'; end if;
  begin v_store_id := nullif(p_payload->>'storeId', '')::uuid; exception when others then v_store_id := null; end;
  if v_store_id is null or not exists (select 1 from public.stores s where s.id = v_store_id and s.status = 'active') then
    raise exception 'Invalid or inactive store';
  end if;
  v_key := nullif(trim(p_payload->>'idempotencyKey'), '');
  if v_key is null or char_length(v_key) not between 8 and 64 then raise exception 'Invalid retry key'; end if;
  begin v_draft_id := nullif(p_payload->>'draftId', '')::uuid; exception when others then raise exception 'Order page expired'; end;

  -- One order at a time per customer: a double tap, or a retry that overlaps the first call, waits here and then finds the first call's key.
  perform pg_advisory_xact_lock(hashtextextended('place_store_order:' || v_user_id::text, 0));

  select i.request_id into v_existing from private.store_order_idempotency i where i.user_id = v_user_id and i.idem_key = v_key;
  if found then
    if not exists (select 1 from public.store_order_requests q where q.id = v_existing and q.user_id = v_user_id and q.store_id = v_store_id) then
      raise exception 'Invalid retry key';
    end if;
    return private.order_result(v_existing) || jsonb_build_object('duplicate', true);
  end if;

  if (select count(*) from public.store_order_requests q where q.user_id = v_user_id and q.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Too many orders, try again later';
  end if;

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

  for r in
    select ci.id as cart_item_id, ci.quantity, sp.id as store_product_id, sp.product_size_id, sp.price, sp.currency, sp.is_available, sp.stock_quantity
    from public.cart_items ci
    join public.store_products sp on sp.id = ci.store_product_id
    where ci.user_id = v_user_id and sp.store_id = v_store_id
    order by ci.created_at, ci.id
  loop
    if not exists (
      select 1 from public.catalog_platform_offers po
      where po.product_size_id = r.product_size_id and po.store_product_id = r.store_product_id and po.store_id = v_store_id
        and po.price = r.price and po.currency = r.currency
    ) then raise exception 'Product is not offered by this store'; end if;
    if not r.is_available or r.stock_quantity is null or r.stock_quantity <= 0 or r.stock_quantity < r.quantity then
      raise exception 'Product is unavailable or has insufficient stock';
    end if;
    if r.currency is distinct from 'EGP' then raise exception 'Only EGP orders are supported'; end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'cartItemId', r.cart_item_id, 'productSizeId', r.product_size_id, 'storeProductId', r.store_product_id,
      'quantity', r.quantity, 'unitPrice', r.price, 'total', round(r.price * r.quantity, 2)));
    v_subtotal := v_subtotal + round(r.price * r.quantity, 2);
  end loop;
  if jsonb_array_length(v_lines) = 0 then raise exception 'Cart is empty for this store'; end if;

  begin
    v_expected := coalesce(nullif(p_payload->>'expectedSubtotal', ''), nullif(p_payload->>'subtotal', ''))::numeric;
  exception when others then raise exception 'Subtotal mismatch';
  end;
  if v_expected is not null and abs(v_expected - v_subtotal) > 0.005 then raise exception 'Subtotal mismatch'; end if;

  -- The same lines at the same prices, already with the merchant or waiting for the payment confirmation, are the same order (a second tab, a reload).
  select jsonb_agg(jsonb_build_array(e->>'storeProductId', (e->>'quantity')::integer, (e->>'unitPrice')::numeric) order by e->>'storeProductId')
    into v_signature from jsonb_array_elements(v_lines) e;
  select q.id into v_existing
  from public.store_order_requests q
  where q.user_id = v_user_id and q.store_id = v_store_id and q.status in ('awaiting_store_confirmation', 'store_confirmed')
    and not private.payment_executed(q.payment_status)
    and not exists (select 1 from public.payment_windows w where w.request_id = q.id and w.state in ('issued', 'opened') and w.expires_at <= now())
    and (select jsonb_agg(jsonb_build_array(i.store_product_id::text, i.quantity, i.unit_price) order by i.store_product_id::text)
         from public.store_order_request_items i where i.request_id = q.id) = v_signature
  order by q.created_at desc limit 1;
  if found then
    insert into private.store_order_idempotency (user_id, idem_key, request_id) values (v_user_id, v_key, v_existing);
    return private.order_result(v_existing) || jsonb_build_object('duplicate', true, 'sameOpenOrder', true);
  end if;

  -- The number the page showed (an open draft of this customer and store), else a fresh one.
  if v_draft_id is not null then
    select * into v_draft from public.order_drafts d
    where d.id = v_draft_id and d.user_id = v_user_id and d.store_id = v_store_id and d.used_at is null and d.expires_at > now() for update;
    if not found then raise exception 'Order page expired'; end if;
    v_tracking := v_draft.tracking_number;
    begin
      v_session := public.create_checkout_session(jsonb_build_object('trackingNumber', v_tracking, 'customer', v_customer, 'subtotal', v_subtotal));
    exception when unique_violation then raise exception 'Order page expired';
    end;
  else
    for v_attempt in 1..8 loop
      v_tracking := private.new_tracking_number();
      begin
        v_session := public.create_checkout_session(jsonb_build_object('trackingNumber', v_tracking, 'customer', v_customer, 'subtotal', v_subtotal));
        exit;
      exception when unique_violation then v_session := null;
      end;
    end loop;
    if v_session is null then raise exception 'Could not allocate a tracking number'; end if;
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
  if v_draft.id is not null then update public.order_drafts set used_at = now(), request_id = v_request_id where id = v_draft.id; end if;

  -- Queued for the merchant in the same transaction as the order; the Worker sends it signed right after.
  insert into public.merchant_deliveries (request_id, store_id, kind) values (v_request_id, v_store_id, 'order');

  -- The cart stays as it is: the lines leave it only after a trusted payment result.
  return private.order_result(v_request_id) || jsonb_build_object('duplicate', false);
end; $$;
