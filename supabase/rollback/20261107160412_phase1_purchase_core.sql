-- Rollback of 20261107160412_phase1_purchase_core.sql: puts back the order functions, the protection trigger, the watch view and the health
-- report as they were before phase 1, and drops what phase 1 added. The merchant numbers and the snapshots are DROPPED with their columns:
-- take a backup of store_order_requests / store_order_request_items first if any order made after the migration must be kept.
begin;

-- The snapshot triggers go first, then the protection that read the new columns.
drop trigger if exists snapshot_order_customer on public.store_order_requests;
drop trigger if exists snapshot_order_item on public.store_order_request_items;
drop function if exists private.snapshot_order_customer();
drop function if exists private.snapshot_order_item();
drop function if exists private.build_customer_snapshot(uuid, text, text, text, text, text);

create or replace function private.protect_order_base()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  if tg_table_name = 'store_order_request_items' then
    if tg_op = 'DELETE' then
      if exists (select 1 from public.store_order_commissions c where c.request_id = old.request_id) then
        raise exception 'Order lines of a sold order cannot be deleted' using errcode = 'P0001';
      end if;
      return old;
    end if;
    if new.request_id is distinct from old.request_id or new.quantity is distinct from old.quantity
       or new.unit_price is distinct from old.unit_price or new.line_total is distinct from old.line_total
       or new.currency is distinct from old.currency then
      raise exception 'Order lines are immutable; use an adjustment' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.subtotal is distinct from old.subtotal or new.store_id is distinct from old.store_id
     or new.tracking_number is distinct from old.tracking_number or new.currency is distinct from old.currency
     or (old.user_id is not null and new.user_id is not null and new.user_id is distinct from old.user_id) then
    raise exception 'The order base is immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;

drop trigger if exists protect_order_base_trigger on public.store_order_requests;
create trigger protect_order_base_trigger before update on public.store_order_requests
  for each row execute function private.protect_order_base();

-- The customer's confirmation works again.
create or replace function public.confirm_store_order_purchase(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_request public.store_order_requests;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  select * into v_request from public.store_order_requests r
  where r.id = p_request_id and r.user_id = v_user_id
  for update;
  if not found then
    raise exception 'Order not found';
  end if;
  if v_request.customer_confirmed_at is not null then
    return jsonb_build_object('requestId', v_request.id, 'trackingNumber', v_request.tracking_number,
                              'confirmedAt', v_request.customer_confirmed_at, 'duplicate', true);
  end if;
  update public.store_order_requests set customer_confirmed_at = now(), updated_at = now()
  where id = v_request.id returning * into v_request;
  perform public.emit_order_notification(
    v_request, 'customer_confirmed_purchase', 'العميل أكد إتمام الشراء',
    'أكد العميل ' || v_request.customer_name || ' أنه أتمّ شراء الطلب ' || v_request.tracking_number
      || ' من المتجر. على المتجر إرسال إشعار الشراء للمنصة.',
    jsonb_build_object('status', v_request.status, 'trackingNumber', v_request.tracking_number,
                       'storeOrderReference', v_request.store_order_reference));
  return jsonb_build_object('requestId', v_request.id, 'trackingNumber', v_request.tracking_number,
                            'confirmedAt', v_request.customer_confirmed_at, 'duplicate', false);
end;
$function$;
comment on function public.confirm_store_order_purchase(uuid) is null;

create or replace function public.confirm_store_order_purchase_server(p_request_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  if p_user_id is null then raise exception 'Authentication required'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
  return public.confirm_store_order_purchase(p_request_id);
end;
$function$;
comment on function public.confirm_store_order_purchase_server(uuid, uuid) is null;

-- The watch view with the customer's flags (as 20261106122349 left it).
create or replace view public.platform_commission_watch with (security_invoker = true) as
select r.id as request_id, r.tracking_number, r.store_id, r.status, r.reconciliation_status,
       r.created_at, r.updated_at, f.flag
from public.store_order_requests r
left join public.store_shipments sh on sh.request_id = r.id
cross join lateral (values
  ('no_store_report', r.status = 'awaiting_store_confirmation' and r.created_at < now() - interval '3 days'),
  ('stuck_in_review', r.status = 'needs_review' and r.updated_at < now() - interval '2 days'),
  ('report_mismatched', r.status = 'needs_review'
      and lower(coalesce(r.latest_store_payload->>'status', '')) in ('completed', 'success', 'succeeded', 'paid', 'confirmed')),
  ('customer_confirmed_unreported', r.customer_confirmed_at is not null
      and r.status in ('awaiting_store_confirmation', 'store_confirmed', 'processing', 'needs_review')),
  ('rejected_but_customer_confirmed', r.customer_confirmed_at is not null
      and r.status in ('store_rejected', 'store_cancelled', 'cancelled')),
  ('rejected_but_shipped', r.status in ('store_rejected', 'store_cancelled', 'cancelled')
      and sh.shipping_status in ('handed_to_carrier', 'in_transit', 'out_for_delivery', 'delivered')),
  ('reversed_after_sale', r.mismatch_fields ? 'reversal_after_sale'
      or (r.status in ('store_rejected', 'store_cancelled', 'cancelled') and exists (
            select 1 from public.commissions c join public.store_order_request_items i on i.id = c.store_order_request_item_id
            where i.request_id = r.id))),
  ('shipped_unreported', sh.shipping_status in ('handed_to_carrier', 'in_transit', 'out_for_delivery', 'delivered')
      and r.status not in ('store_rejected', 'store_cancelled', 'cancelled', 'restored')
      and r.reconciliation_status is distinct from 'matched' and r.created_at < now() - interval '1 day'),
  ('delivery_not_confirmed', sh.shipping_status in ('handed_to_carrier', 'in_transit', 'out_for_delivery', 'delayed')
      and sh.updated_at < now() - interval '14 days'),
  ('delivered_unverified', sh.shipping_status = 'delivered' and sh.delivery_verified_at is null
      and sh.updated_at < now() - interval '3 days'),
  ('below_catalog_total', r.total_amount is not null and r.total_amount + 0.005 < r.subtotal)
) as f(flag, hit)
where f.hit;
revoke all on public.platform_commission_watch from public, anon, authenticated;
grant select on public.platform_commission_watch to service_role;
comment on view public.platform_commission_watch is 'Orders where the store''s report, the customer''s word and the carrier disagree. Reads the unified commission ledger; service_role only.';

drop function if exists public.platform_store_order_health(integer);
create function public.platform_store_order_health(p_days integer default 90)
returns table(store_id uuid, store_name text, orders bigint, reported bigint, rejected bigint, needs_review bigint,
              awaiting_over_3d bigint, customer_confirmed_unreported bigint, commission_total numeric)
language sql
stable
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
  select s.id, s.name,
         count(r.id),
         count(*) filter (where r.reconciliation_status = 'matched' and r.status in ('completed', 'shipped', 'delivered')),
         count(*) filter (where r.status in ('store_rejected', 'store_cancelled', 'cancelled')),
         count(*) filter (where r.status = 'needs_review'),
         count(*) filter (where r.status = 'awaiting_store_confirmation' and r.created_at < now() - interval '3 days'),
         count(*) filter (where r.customer_confirmed_at is not null
                            and r.status in ('awaiting_store_confirmation', 'store_confirmed', 'processing', 'needs_review')),
         coalesce(sum(cm.amount), 0)
  from public.stores s
  left join public.store_order_requests r
    on r.store_id = s.id and r.created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 90), 1000)))
  left join lateral (
    select sum(c.amount) as amount
    from public.commissions c join public.store_order_request_items i on i.id = c.store_order_request_item_id
    where i.request_id = r.id
  ) cm on true
  group by s.id, s.name
  order by s.name
$function$;
revoke all on function public.platform_store_order_health(integer) from public, anon, authenticated;
grant execute on function public.platform_store_order_health(integer) to service_role;

-- The creation functions as they were: the cart-clearing creator and the place_store_order that trusted the browser's lines.
create or replace function public.create_store_order_request_from_cart(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_store_id uuid := nullif(p_payload->>'storeId', '')::uuid;
  v_session_id uuid := nullif(p_payload->>'checkoutSessionId', '')::uuid;
  v_tracking text := nullif(trim(p_payload->>'trackingNumber'), '');
  v_currency text;
  v_subtotal numeric;
  v_items jsonb;
  v_order_payload jsonb;
  v_result jsonb;
  v_request_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if v_store_id is null or not exists (
    select 1 from public.stores s where s.id = v_store_id and s.status = 'active'
  ) then
    raise exception 'Invalid or inactive store';
  end if;
  if v_tracking is null then
    raise exception 'Tracking number is required';
  end if;
  if coalesce(trim(p_payload->'customer'->>'name'), '') = ''
     or coalesce(trim(p_payload->'customer'->>'phone'), '') = ''
     or coalesce(trim(p_payload->'customer'->>'address'), '') = '' then
    raise exception 'Customer details are required';
  end if;
  if v_session_id is not null and not exists (
    select 1 from public.checkout_sessions cs where cs.id = v_session_id and cs.user_id = v_user_id
  ) then
    raise exception 'Checkout session not found';
  end if;

  SELECT min(sp.currency), sum(sp.price * ci.quantity),
         jsonb_agg(jsonb_build_object(
           'cartItemId', ci.id,
           'productSizeId', sp.product_size_id,
           'storeProductId', sp.id,
           'quantity', ci.quantity,
           'unitPrice', sp.price,
           'total', round(sp.price * ci.quantity, 2)
         ) ORDER BY ci.created_at)
  INTO v_currency, v_subtotal, v_items
  FROM public.cart_items ci
  JOIN public.store_products sp ON sp.id = ci.store_product_id
  WHERE ci.user_id = v_user_id
    AND sp.store_id = v_store_id
    AND sp.is_available
    AND (sp.stock_quantity IS NULL OR sp.stock_quantity >= ci.quantity);

  if v_items is null or jsonb_array_length(v_items) = 0 then
    raise exception 'Cart is empty or contains unavailable products for this store';
  end if;

  if exists (
    select 1
    from public.cart_items ci
    join public.store_products sp on sp.id = ci.store_product_id
    where ci.user_id = v_user_id
      and sp.store_id = v_store_id
      and (not sp.is_available or (sp.stock_quantity is not null and sp.stock_quantity < ci.quantity))
  ) then
    raise exception 'Cart contains unavailable or insufficient-stock products';
  end if;

  v_order_payload := jsonb_build_object(
    'storeId', v_store_id,
    'checkoutSessionId', v_session_id,
    'trackingNumber', v_tracking,
    'checkoutTrackingNumber', coalesce(nullif(p_payload->>'checkoutTrackingNumber', ''), v_tracking),
    'customer', p_payload->'customer',
    'items', v_items,
    'subtotal', v_subtotal,
    'currency', coalesce(v_currency, 'EGP')
  );

  v_result := public.create_store_order_request(v_order_payload);
  v_request_id := nullif(v_result->>'id', '')::uuid;

  UPDATE public.store_order_request_items ri
  SET source_cart_item_id = ci.id
  FROM public.cart_items ci
  JOIN public.store_products sp ON sp.id = ci.store_product_id
  WHERE ri.request_id = v_request_id
    AND ci.user_id = v_user_id
    AND sp.store_id = v_store_id
    AND ri.store_product_id = ci.store_product_id;

  DELETE FROM public.cart_items ci
  USING public.store_products sp
  WHERE ci.store_product_id = sp.id
    AND ci.user_id = v_user_id
    AND sp.store_id = v_store_id;

  return v_result || jsonb_build_object('createdFromCart', true, 'cartCleared', true);
end;
$function$;
comment on function public.create_store_order_request_from_cart(jsonb) is null;

create or replace function public.create_checkout_session(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
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
  v_key text := nullif(trim(p_payload->>'idempotencyKey'), '');
  v_items jsonb := p_payload->'items';
  v_customer jsonb := p_payload->'customer';
  v_item jsonb;
  v_sp public.store_products;
  v_sp_id uuid;
  v_size_id uuid;
  v_qty integer;
  v_seen uuid[] := array[]::uuid[];
  v_subtotal numeric := 0;
  v_currency text;
  v_existing uuid;
  v_result jsonb;
  v_session jsonb;
  v_tracking text;
  v_attempt integer;
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
  if v_key is not null and char_length(v_key) not between 8 and 64 then
    raise exception 'Invalid retry key';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('place_store_order:' || v_user_id::text, 0));

  if v_key is not null then
    select i.request_id into v_existing
    from private.store_order_idempotency i
    where i.user_id = v_user_id and i.idem_key = v_key;
    if found then
      select jsonb_build_object(
               'id', r.id, 'trackingNumber', r.tracking_number, 'checkoutTrackingNumber', r.checkout_tracking_number,
               'checkoutSessionId', r.checkout_session_id, 'status', r.status, 'subtotal', r.subtotal,
               'currency', r.currency, 'createdFromCart', true, 'cartCleared', true, 'duplicate', true)
        into v_result
      from public.store_order_requests r
      where r.id = v_existing and r.user_id = v_user_id;
      if v_result is not null then
        return v_result;
      end if;
    end if;
  end if;

  if (select count(*) from public.store_order_requests r
      where r.user_id = v_user_id and r.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Too many orders, try again later';
  end if;

  if v_customer is null or jsonb_typeof(v_customer) <> 'object'
     or coalesce(trim(v_customer->>'name'), '') = ''
     or coalesce(trim(v_customer->>'phone'), '') = ''
     or coalesce(trim(v_customer->>'address'), '') = '' then
    raise exception 'Customer details are required';
  end if;
  if char_length(trim(v_customer->>'name')) > 120 or char_length(trim(v_customer->>'phone')) > 32
     or char_length(trim(v_customer->>'address')) > 500
     or char_length(coalesce(trim(v_customer->>'email'), '')) > 254
     or char_length(coalesce(trim(v_customer->>'notes'), '')) > 1000 then
    raise exception 'Customer details are too long';
  end if;

  if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) not between 1 and 100 then
    raise exception 'Order items are required';
  end if;

  for v_item in select value from jsonb_array_elements(v_items) loop
    begin
      v_sp_id := nullif(v_item->>'storeProductId', '')::uuid;
      v_size_id := nullif(v_item->>'productSizeId', '')::uuid;
      v_qty := (v_item->>'quantity')::integer;
    exception when others then
      raise exception 'Invalid order item';
    end;
    if v_sp_id is null or v_qty is null or v_qty < 1 or v_qty > 99 or v_sp_id = any (v_seen) then
      raise exception 'Invalid order item';
    end if;
    v_seen := v_seen || v_sp_id;
    select * into v_sp from public.store_products sp where sp.id = v_sp_id and sp.store_id = v_store_id;
    if not found then
      raise exception 'Product is not offered by this store';
    end if;
    if v_size_id is not null and v_size_id is distinct from v_sp.product_size_id then
      raise exception 'Invalid order item';
    end if;
    if not v_sp.is_available or (v_sp.stock_quantity is not null and v_sp.stock_quantity < v_qty) then
      raise exception 'Product is unavailable or has insufficient stock';
    end if;
    begin
      if abs(coalesce((v_item->>'unitPrice')::numeric, -1) - v_sp.price) > 0.005 then
        raise exception 'Price changed for product %', v_sp.product_size_id;
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Invalid order item';
    end;
    if v_currency is null then
      v_currency := v_sp.currency;
    elsif v_currency <> v_sp.currency then
      raise exception 'Mixed currencies are not supported';
    end if;
    v_subtotal := v_subtotal + round(v_sp.price * v_qty, 2);
  end loop;

  if p_payload ? 'subtotal' then
    begin
      if abs(coalesce((p_payload->>'subtotal')::numeric, -1) - v_subtotal) > 0.005 then
        raise exception 'Subtotal mismatch';
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Subtotal mismatch';
    end;
  end if;

  delete from public.cart_items ci
  using public.store_products sp
  where ci.store_product_id = sp.id and ci.user_id = v_user_id and sp.store_id = v_store_id;
  insert into public.cart_items (user_id, store_product_id, quantity)
  select v_user_id, (e->>'storeProductId')::uuid, (e->>'quantity')::integer
  from jsonb_array_elements(v_items) e;

  for v_attempt in 1..8 loop
    v_tracking := private.new_tracking_number();
    begin
      v_session := public.create_checkout_session(jsonb_build_object(
        'trackingNumber', v_tracking, 'customer', v_customer, 'currency', v_currency, 'subtotal', v_subtotal));
      exit;
    exception when unique_violation then
      v_session := null;
    end;
  end loop;
  if v_session is null then
    raise exception 'Could not allocate a tracking number';
  end if;

  v_result := public.create_store_order_request_from_cart(jsonb_build_object(
    'storeId', v_store_id, 'trackingNumber', v_tracking, 'checkoutTrackingNumber', v_tracking,
    'checkoutSessionId', v_session->>'id', 'customer', v_customer));

  if v_key is not null then
    insert into private.store_order_idempotency (user_id, idem_key, request_id)
    values (v_user_id, v_key, (v_result->>'id')::uuid);
  end if;

  return v_result || jsonb_build_object('subtotal', v_subtotal, 'currency', v_currency);
end;
$function$;

drop function if exists private.order_result(uuid);

create or replace function private.enrich_initial_order_notification(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_req public.store_order_requests;
  v_store text;
  v_items jsonb;
  v_count integer;
  v_payload jsonb;
begin
  select * into v_req from public.store_order_requests where id = p_request_id;
  if not found then
    return;
  end if;
  select s.name into v_store from public.stores s where s.id = v_req.store_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'productName', i.product_name, 'brandName', i.brand_name, 'size', i.size_label,
           'productSizeId', i.product_size_id, 'quantity', i.quantity, 'unitPrice', i.unit_price,
           'lineTotal', i.line_total) order by i.created_at, i.id), '[]'::jsonb), count(*)
    into v_items, v_count
  from public.store_order_request_items i where i.request_id = p_request_id;
  v_payload := jsonb_build_object(
    'status', v_req.status, 'subtotal', v_req.subtotal, 'currency', v_req.currency,
    'trackingNumber', v_req.tracking_number, 'checkoutTrackingNumber', v_req.checkout_tracking_number,
    'store', jsonb_build_object('id', v_req.store_id, 'name', v_store),
    'customer', jsonb_build_object('name', v_req.customer_name, 'phone', v_req.customer_phone,
                                   'email', v_req.customer_email, 'address', v_req.customer_address,
                                   'notes', v_req.customer_notes),
    'items', v_items, 'itemCount', v_count, 'handedOffAt', v_req.created_at);
  update public.notifications set payload = v_payload
  where request_id = p_request_id and type = 'order_initial';
  update public.notifications
  set body = 'انتقل العميل ' || v_req.customer_name || ' (' || v_req.customer_phone || ') إلى سلة المتجر ' || coalesce(v_store, '')
             || ' بطلب من ' || v_count || ' منتج بإجمالي ' || v_req.subtotal || ' ' || v_req.currency
             || '. رقم التتبع: ' || v_req.tracking_number
  where request_id = p_request_id and type = 'order_initial' and recipient_role in ('platform_admin', 'store_admin');
end;
$function$;

-- The columns and the constraints phase 1 added.
alter table public.store_order_request_items drop column if exists product_snapshot, drop column if exists product_description;
alter table public.store_order_requests drop constraint if exists store_order_requests_merchant_numbers_fmt;
alter table public.store_order_requests drop column if exists merchant_order_number, drop column if exists merchant_invoice_number, drop column if exists customer_snapshot;
alter table public.commission_settlements drop constraint if exists commission_settlements_currency_egp;
alter table public.checkout_sessions drop constraint if exists checkout_sessions_currency_egp;
alter table public.store_order_request_items drop constraint if exists store_order_request_items_currency_egp;
alter table public.store_order_requests drop constraint if exists store_order_requests_currency_egp;

commit;
