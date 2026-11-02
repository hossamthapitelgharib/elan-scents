begin;

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
     or new.created_at is distinct from old.created_at
     or (old.user_id is not null and new.user_id is not null and new.user_id is distinct from old.user_id) then
    raise exception 'The order base is immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;

alter table public.store_order_requests add column if not exists customer_confirmed_at timestamptz;

create table if not exists public.store_order_commissions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.store_order_requests(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete restrict,
  rate numeric(5,2) not null check (rate >= 0 and rate <= 100),
  gross_amount numeric(14,2) not null check (gross_amount >= 0),
  returned_amount numeric(14,2) not null default 0 check (returned_amount >= 0),
  commission_amount numeric(14,2) not null check (commission_amount >= 0),
  currency text not null,
  evidence text not null check (evidence in ('store_completed', 'store_report_mismatch', 'status_shipped', 'status_delivered', 'shipment')),
  review_required boolean not null default false,
  review_reason text check (review_reason is null or char_length(review_reason) <= 200),
  status text not null default 'accrued' check (status in ('accrued', 'voided')),
  void_reason text check (void_reason is null or char_length(void_reason) <= 500),
  voided_at timestamptz,
  voided_by uuid,
  accrued_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (returned_amount <= gross_amount)
);
create index if not exists store_order_commissions_store_idx on public.store_order_commissions (store_id, accrued_at desc);
alter table public.store_order_commissions enable row level security;
revoke all on table public.store_order_commissions from public, anon, authenticated;
grant select on table public.store_order_commissions to authenticated;
drop policy if exists store_order_commissions_read on public.store_order_commissions;
create policy store_order_commissions_read on public.store_order_commissions for select to authenticated
  using ((select private.is_platform_admin()) or (select private.is_store_member(store_id)));

drop trigger if exists protect_order_base_trigger on public.store_order_request_items;
create trigger protect_order_base_trigger before update or delete on public.store_order_request_items
  for each row execute function private.protect_order_base();
drop trigger if exists protect_order_base_trigger on public.store_order_requests;
create trigger protect_order_base_trigger before update on public.store_order_requests
  for each row execute function private.protect_order_base();

create or replace function private.commission_amounts(p_request_id uuid, out gross numeric, out returned numeric)
language sql
stable
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
  select g.gross,
         least(g.gross, coalesce((
           select sum(case when a.quantity > 0 then least(a.quantity, i.quantity) * i.unit_price else a.amount end)
           from public.store_order_item_adjustments a
           join public.store_order_request_items i on i.id = a.request_item_id
           where a.request_id = p_request_id and a.status = 'completed'
         ), 0))
  from (select coalesce(sum(i.line_total), 0) as gross
        from public.store_order_request_items i where i.request_id = p_request_id) g
$function$;

create or replace function private.accrue_store_order_commission(
  p_request_id uuid, p_evidence text, p_review boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_req public.store_order_requests;
  v_rate numeric(5,2);
  v_gross numeric;
  v_returned numeric;
begin
  select * into v_req from public.store_order_requests where id = p_request_id;
  if not found then
    return;
  end if;
  select coalesce(s.commission_rate, 0) into v_rate from public.stores s where s.id = v_req.store_id;
  select a.gross, a.returned into v_gross, v_returned from private.commission_amounts(p_request_id) a;
  insert into public.store_order_commissions
    (request_id, store_id, rate, gross_amount, returned_amount, commission_amount, currency, evidence, review_required, review_reason)
  values
    (p_request_id, v_req.store_id, coalesce(v_rate, 0), v_gross, v_returned,
     round(greatest(v_gross - v_returned, 0) * coalesce(v_rate, 0) / 100, 2), v_req.currency, p_evidence,
     coalesce(p_review, false), case when coalesce(p_review, false) then left(p_reason, 200) end)
  on conflict (request_id) do update
    set review_required = public.store_order_commissions.review_required or excluded.review_required,
        review_reason = coalesce(public.store_order_commissions.review_reason, excluded.review_reason),
        updated_at = now()
    where public.store_order_commissions.status = 'accrued';
end;
$function$;

create or replace function private.commission_on_request_status()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  if new.status in ('completed', 'shipped', 'delivered') and old.status is distinct from new.status then
    perform private.accrue_store_order_commission(
      new.id,
      case new.status when 'completed' then 'store_completed' when 'shipped' then 'status_shipped' else 'status_delivered' end,
      new.reconciliation_status = 'mismatched' and old.status is distinct from 'needs_review',
      'reconciliation_mismatch');
  end if;
  return new;
end;
$function$;

drop trigger if exists store_order_commission_on_status on public.store_order_requests;
create trigger store_order_commission_on_status after update of status on public.store_order_requests
  for each row when (old.status is distinct from new.status)
  execute function private.commission_on_request_status();

create or replace function private.commission_on_adjustment()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_request uuid := coalesce(new.request_id, old.request_id);
begin
  update public.store_order_commissions c
  set returned_amount = a.returned,
      commission_amount = round(greatest(c.gross_amount - a.returned, 0) * c.rate / 100, 2),
      updated_at = now()
  from private.commission_amounts(v_request) a
  where c.request_id = v_request and c.status = 'accrued';
  return null;
end;
$function$;

drop trigger if exists store_order_commission_on_adjustment on public.store_order_item_adjustments;
create trigger store_order_commission_on_adjustment after insert or update or delete on public.store_order_item_adjustments
  for each row execute function private.commission_on_adjustment();

create or replace function private.can_shipping_transition(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path to 'pg_temp'
as $function$
  select case p_from
    when 'preparing' then p_to in ('preparing', 'handed_to_carrier', 'cancelled')
    when 'handed_to_carrier' then p_to in ('handed_to_carrier', 'in_transit', 'out_for_delivery', 'delayed', 'delivered', 'returned', 'cancelled')
    when 'in_transit' then p_to in ('in_transit', 'out_for_delivery', 'delayed', 'delivered', 'returned', 'cancelled')
    when 'out_for_delivery' then p_to in ('out_for_delivery', 'delivered', 'delayed', 'returned', 'cancelled')
    when 'delivered' then p_to in ('delivered')
    when 'delayed' then p_to in ('delayed', 'in_transit', 'out_for_delivery', 'delivered', 'returned', 'cancelled')
    when 'returned' then p_to in ('returned')
    when 'cancelled' then p_to in ('cancelled')
    else false
  end
$function$;

create or replace function private.shipment_signals()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_req public.store_order_requests;
begin
  if new.shipping_status not in ('handed_to_carrier', 'in_transit', 'out_for_delivery', 'delivered') then
    return new;
  end if;
  select * into v_req from public.store_order_requests where id = new.request_id;
  if not found then
    return new;
  end if;
  perform private.accrue_store_order_commission(
    v_req.id, 'shipment',
    v_req.reconciliation_status = 'mismatched' or v_req.status in ('needs_review', 'store_rejected', 'store_cancelled', 'cancelled'),
    case when v_req.status in ('store_rejected', 'store_cancelled', 'cancelled') then 'shipped_after_rejection' else 'reconciliation_mismatch' end);
  if v_req.status in ('awaiting_store_confirmation', 'store_confirmed', 'processing')
     or (v_req.status = 'shipped' and new.shipping_status = 'delivered') then
    update public.store_order_requests
    set status = case when new.shipping_status = 'delivered' then 'delivered' else 'shipped' end, updated_at = now()
    where id = v_req.id;
  end if;
  return new;
end;
$function$;

drop trigger if exists store_shipment_signals on public.store_shipments;
create trigger store_shipment_signals after insert or update of shipping_status on public.store_shipments
  for each row execute function private.shipment_signals();

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

create or replace function public.create_store_order_request(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_request public.store_order_requests;
  v_item jsonb;
  v_row jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_sp public.store_products;
  v_store_id uuid;
  v_user_id uuid := auth.uid();
  v_session_id uuid := nullif(p_payload->>'checkoutSessionId', '')::uuid;
  v_size_id uuid;
  v_store_product_id uuid;
  v_product_id uuid;
  v_product_name text;
  v_brand_name text;
  v_size_label text;
  v_qty integer;
  v_line numeric;
  v_subtotal numeric := 0;
  v_currency text;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  v_store_id := (p_payload->>'storeId')::uuid;
  if not exists (select 1 from public.stores s where s.id = v_store_id and s.status = 'active') then
    raise exception 'Invalid or inactive store';
  end if;
  if coalesce(trim(p_payload->'customer'->>'name'), '') = '' or coalesce(trim(p_payload->'customer'->>'phone'), '') = '' or coalesce(trim(p_payload->'customer'->>'address'), '') = '' then
    raise exception 'Customer details are required';
  end if;
  if coalesce(trim(p_payload->>'trackingNumber'), '') = '' then
    raise exception 'Tracking number is required';
  end if;
  if jsonb_typeof(p_payload->'items') is distinct from 'array' or jsonb_array_length(p_payload->'items') = 0 then
    raise exception 'Order items are required';
  end if;
  if v_session_id is not null and not exists (select 1 from public.checkout_sessions cs where cs.id = v_session_id and cs.user_id = v_user_id) then
    raise exception 'Checkout session not found';
  end if;

  for v_item in select value from jsonb_array_elements(p_payload->'items') loop
    v_size_id := nullif(v_item->>'productSizeId', '')::uuid;
    v_store_product_id := nullif(v_item->>'storeProductId', '')::uuid;
    v_qty := (v_item->>'quantity')::integer;
    if v_size_id is null or v_qty is null or v_qty < 1 then
      raise exception 'Invalid order item';
    end if;
    select * into v_sp from public.store_products sp
      where sp.store_id = v_store_id
        and sp.product_size_id = v_size_id
        and (v_store_product_id is null or sp.id = v_store_product_id)
      limit 1;
    if not found then
      raise exception 'Product is not offered by this store';
    end if;
    if not v_sp.is_available or (v_sp.stock_quantity is not null and v_sp.stock_quantity < v_qty) then
      raise exception 'Product is unavailable or has insufficient stock';
    end if;
    select ps.product_id, p.name, b.name, ps.size_label
      into v_product_id, v_product_name, v_brand_name, v_size_label
    from public.product_sizes ps
    join public.products p on p.id = ps.product_id
    left join public.brands b on b.id = p.brand_id
    where ps.id = v_sp.product_size_id
    limit 1;
    if not found or v_product_id is null then
      raise exception 'Product catalog identity is unavailable';
    end if;
    if abs(coalesce((v_item->>'unitPrice')::numeric, -1) - v_sp.price) > 0.005 then
      raise exception 'Price changed for product %', v_size_id;
    end if;
    v_line := round(v_sp.price * v_qty, 2);
    if abs(coalesce((v_item->>'total')::numeric, -1) - v_line) > 0.005 then
      raise exception 'Line total mismatch for product %', v_size_id;
    end if;
    if v_currency is null then
      v_currency := v_sp.currency;
    elsif v_currency <> v_sp.currency then
      raise exception 'Mixed currencies are not supported';
    end if;
    v_subtotal := v_subtotal + v_line;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'sp_id', v_sp.id, 'size_id', v_sp.product_size_id, 'product_id', v_product_id,
      'name', v_product_name, 'brand', v_brand_name, 'size', v_size_label,
      'qty', v_qty, 'unit', v_sp.price, 'line', v_line, 'currency', v_sp.currency));
  end loop;

  if p_payload ? 'subtotal' and abs(coalesce((p_payload->>'subtotal')::numeric, -1) - v_subtotal) > 0.005 then
    raise exception 'Subtotal mismatch';
  end if;

  insert into public.store_order_requests (tracking_number, checkout_tracking_number, checkout_session_id, store_id, user_id, customer_name, customer_phone, customer_email, customer_address, customer_notes, subtotal, currency, initial_payload)
  values (p_payload->>'trackingNumber', coalesce(nullif(p_payload->>'checkoutTrackingNumber', ''), p_payload->>'trackingNumber'), v_session_id, v_store_id, v_user_id, trim(p_payload->'customer'->>'name'), trim(p_payload->'customer'->>'phone'), nullif(trim(p_payload->'customer'->>'email'), ''), trim(p_payload->'customer'->>'address'), nullif(trim(p_payload->'customer'->>'notes'), ''), v_subtotal, v_currency, p_payload)
  returning * into v_request;

  for v_row in select value from jsonb_array_elements(v_rows) loop
    insert into public.store_order_request_items (request_id, store_product_id, product_size_id, product_id, product_name, brand_name, size_label, quantity, unit_price, line_total, currency)
    values (v_request.id, (v_row->>'sp_id')::uuid, (v_row->>'size_id')::uuid, (v_row->>'product_id')::uuid, v_row->>'name', v_row->>'brand', v_row->>'size', (v_row->>'qty')::integer, (v_row->>'unit')::numeric, (v_row->>'line')::numeric, v_row->>'currency');
  end loop;

  insert into public.store_order_notifications (request_id, tracking_number, event_type, store_status, match_status, payload)
  values (v_request.id, v_request.tracking_number, 'initial_submitted', 'awaiting_store_confirmation', 'matched', p_payload);

  perform private.enrich_initial_order_notification(v_request.id);

  return jsonb_build_object('id', v_request.id, 'trackingNumber', v_request.tracking_number, 'checkoutTrackingNumber', v_request.checkout_tracking_number, 'checkoutSessionId', v_request.checkout_session_id, 'status', v_request.status);
end;
$function$;

create or replace function public.receive_store_order_notification(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_tracking text := coalesce(p_payload->>'trackingNumber', p_payload->>'orderNumber');
  v_idempotency text := nullif(p_payload->>'idempotencyKey','');
  v_request public.store_order_requests;
  v_updated public.store_order_requests;
  v_existing public.store_order_notifications;
  v_status text := lower(coalesce(p_payload->>'status',''));
  v_match boolean := true;
  v_mismatches jsonb := '[]'::jsonb;
  v_items jsonb := coalesce(p_payload->'items','[]'::jsonb);
  v_expected_count integer;
  v_received_count integer;
  v_event_type text;
  v_match_status text;
  v_new_status text;
  v_apply_inventory boolean := false;
  v_completed_like boolean := v_status in ('completed','success','succeeded','paid','confirmed');
  v_rejected_like boolean := v_status in ('rejected','failed','cancelled','not_completed','declined');
  v_complete boolean;
  v_has_commission boolean;
  v_ref text := nullif(trim(coalesce(p_payload->>'storeOrderReference','')),'');
  v_ref_taken boolean := false;
  v_ship jsonb := case when jsonb_typeof(p_payload->'shipment') = 'object' then p_payload->'shipment' else null end;
  v_ship_status text;
  v_ship_ok boolean := false;
  v_ship_carrier text;
  v_ship_code text;
  v_ship_eta timestamptz;
  v_current_ship public.store_shipments;
  v_customer jsonb := case when jsonb_typeof(p_payload->'customer') = 'object' then p_payload->'customer' else null end;
begin
  if v_tracking is null or v_tracking = '' then
    raise exception 'Missing tracking number';
  end if;

  select * into v_request
  from public.store_order_requests
  where tracking_number = v_tracking
  for update;
  if not found then
    raise exception 'Order not found for tracking number %', v_tracking;
  end if;

  if v_idempotency is not null then
    select * into v_existing
    from public.store_order_notifications
    where idempotency_key = v_idempotency
    limit 1;
    if found then
      return jsonb_build_object(
        'trackingNumber', v_existing.tracking_number,
        'matched', v_existing.match_status = 'matched',
        'status', case when v_existing.match_status = 'matched'
          and v_existing.store_status in ('completed','success','succeeded','paid','confirmed')
          then 'completed' else v_request.status end,
        'mismatches', coalesce(v_existing.mismatch_fields,'[]'::jsonb),
        'inventoryApplied', v_request.inventory_applied_at is not null,
        'duplicate', true
      );
    end if;
  end if;

  select count(*) into v_expected_count
  from public.store_order_request_items
  where request_id = v_request.id;
  select jsonb_array_length(v_items) into v_received_count;
  if v_expected_count <> v_received_count then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('items.length');
  end if;

  if exists (
    select 1
    from public.store_order_request_items i
    where i.request_id = v_request.id
      and not exists (
        select 1
        from jsonb_array_elements(v_items) j
        where nullif(j->>'productSizeId','')::uuid = i.product_size_id
          and (j->>'quantity')::integer = i.quantity
          and (j->>'unitPrice')::numeric = i.unit_price
          and coalesce(j->>'currency','EGP') = i.currency
          and (j->>'total')::numeric = i.line_total
      )
  ) then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('items');
  end if;

  if (p_payload->>'subtotal')::numeric is distinct from v_request.subtotal then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('subtotal');
  end if;
  if p_payload ? 'shipping' and v_request.shipping_amount is not null
     and (p_payload->>'shipping')::numeric is distinct from v_request.shipping_amount then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('shipping');
  end if;
  if p_payload ? 'total' and v_request.total_amount is not null
     and (p_payload->>'total')::numeric is distinct from v_request.total_amount then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('total');
  end if;

  if v_customer is null or coalesce(trim(v_customer->>'name'),'') = '' or coalesce(trim(v_customer->>'phone'),'') = ''
     or coalesce(trim(v_customer->>'address'),'') = '' then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('customer');
  elsif right(regexp_replace(coalesce(v_customer->>'phone',''), '\D', '', 'g'), 9)
        is distinct from right(regexp_replace(coalesce(v_request.customer_phone,''), '\D', '', 'g'), 9) then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('customer.phone');
  end if;

  if v_ship is not null then
    v_ship_status := coalesce(nullif(v_ship->>'status',''), 'preparing');
    v_ship_carrier := nullif(trim(coalesce(v_ship->>'carrier','')), '');
    v_ship_code := nullif(trim(coalesce(v_ship->>'trackingCode','')), '');
    if v_ship_status not in ('preparing','handed_to_carrier','in_transit','out_for_delivery','delivered','delayed','returned','cancelled') then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('shipment.status');
    elsif v_ship_status in ('handed_to_carrier','in_transit','out_for_delivery','delivered') and v_ship_code is null then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('shipment.trackingCode');
    else
      v_ship_ok := true;
    end if;
    begin
      v_ship_eta := nullif(v_ship->>'estimatedDeliveryAt','')::timestamptz;
    exception when others then
      v_ship_eta := null;
    end;
  end if;

  if v_completed_like then
    if v_ref is null then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('storeOrderReference');
    elsif exists (select 1 from public.store_order_requests r
                  where r.store_id = v_request.store_id and r.id <> v_request.id and r.store_order_reference = v_ref) then
      v_ref_taken := true;
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('storeOrderReference.duplicate');
    end if;
    if v_ship is null or v_ship_carrier is null then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('shipment.carrier');
    end if;
    if not (p_payload ? 'shipping') then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('shipping');
    end if;
    if v_request.status in ('store_cancelled','cancelled','restored') then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('order_closed');
    end if;
  elsif v_rejected_like and nullif(trim(coalesce(p_payload->>'reason','')),'') is null then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('reason');
  end if;

  v_has_commission := exists (select 1 from public.store_order_commissions c
                              where c.request_id = v_request.id and c.status = 'accrued');

  v_complete := v_completed_like and v_match;
  if v_completed_like then
    v_event_type := 'store_completed';
    v_new_status := case when v_complete then 'completed' else 'needs_review' end;
    if v_complete and v_request.status in ('shipped','delivered') then
      v_new_status := v_request.status;
    end if;
  elsif v_rejected_like then
    v_event_type := 'store_rejected';
    if v_has_commission then
      v_new_status := 'needs_review';
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('reversal_after_sale');
    else
      v_new_status := 'store_rejected';
    end if;
  else
    v_event_type := 'store_update';
    v_new_status := 'needs_review';
  end if;

  v_match_status := case when v_match then 'matched' else 'mismatched' end;
  v_apply_inventory := v_complete and v_request.inventory_applied_at is null;

  update public.store_order_requests
  set latest_store_payload = p_payload,
      reconciliation_status = v_match_status,
      mismatch_fields = v_mismatches,
      status = v_new_status,
      failure_reason = nullif(p_payload->>'reason',''),
      shipping_amount = case when p_payload ? 'shipping' then (p_payload->>'shipping')::numeric else shipping_amount end,
      total_amount = case when p_payload ? 'total' then (p_payload->>'total')::numeric else total_amount end,
      store_order_reference = case when v_ref_taken then store_order_reference else coalesce(v_ref, store_order_reference) end,
      inventory_applied_at = case when v_apply_inventory then now() else inventory_applied_at end,
      updated_at = now()
  where id = v_request.id
  returning * into v_updated;

  if v_apply_inventory then
    update public.store_products sp
    set stock_quantity = greatest(0, sp.stock_quantity - quantities.total_quantity),
        is_available = case
          when greatest(0, sp.stock_quantity - quantities.total_quantity) = 0 then false
          else sp.is_available
        end,
        updated_at = now()
    from (
      select i.store_product_id, sum(i.quantity)::integer as total_quantity
      from public.store_order_request_items i
      where i.request_id = v_request.id
        and i.store_product_id is not null
      group by i.store_product_id
    ) quantities
    where sp.id = quantities.store_product_id
      and sp.stock_quantity is not null;
  end if;

  if v_ship_ok then
    select * into v_current_ship from public.store_shipments where request_id = v_request.id;
    if not found then
      insert into public.store_shipments (request_id, store_id, carrier_name, tracking_code, shipping_status, status_note, estimated_delivery_at, delivered_at)
      values (v_request.id, v_request.store_id, left(v_ship_carrier, 120), left(v_ship_code, 160), v_ship_status,
              left(nullif(trim(coalesce(v_ship->>'note','')), ''), 500), v_ship_eta,
              case when v_ship_status = 'delivered' then now() end);
    elsif private.can_shipping_transition(v_current_ship.shipping_status, v_ship_status) then
      update public.store_shipments
      set carrier_name = coalesce(left(v_ship_carrier, 120), carrier_name),
          tracking_code = coalesce(left(v_ship_code, 160), tracking_code),
          shipping_status = v_ship_status,
          status_note = coalesce(left(nullif(trim(coalesce(v_ship->>'note','')), ''), 500), status_note),
          estimated_delivery_at = coalesce(v_ship_eta, estimated_delivery_at),
          delivered_at = case when v_ship_status = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
          updated_at = now()
      where id = v_current_ship.id;
    end if;
  end if;

  if v_completed_like then
    if v_complete then
      perform private.accrue_store_order_commission(v_request.id, 'store_completed', false, null);
      update public.store_order_commissions
      set review_required = false, review_reason = null, updated_at = now()
      where request_id = v_request.id and status = 'accrued'
        and review_reason in ('store_report_mismatch', 'reconciliation_mismatch', 'later_report_mismatch');
    else
      perform private.accrue_store_order_commission(v_request.id, 'store_report_mismatch', true, 'store_report_mismatch');
    end if;
  elsif v_has_commission and not v_match then
    update public.store_order_commissions
    set review_required = true, review_reason = coalesce(review_reason, 'later_report_mismatch'), updated_at = now()
    where request_id = v_request.id and status = 'accrued';
  end if;

  insert into public.store_order_notifications
    (request_id,tracking_number,event_type,store_status,match_status,mismatch_fields,payload,idempotency_key)
  values
    (v_request.id,v_tracking,v_event_type,v_status,v_match_status,v_mismatches,p_payload,v_idempotency);

  if v_completed_like then
    perform public.emit_order_notification(
      v_updated,
      case when v_complete then 'store_purchase_completed' else 'store_purchase_needs_review' end,
      case when v_complete then 'إشعار المتجر بعملية شراء' else 'إشعار شراء من المتجر يحتاج مراجعة' end,
      'أبلغ المتجر بعملية شراء للطلب ' || v_tracking
        || case when v_ref is not null then ' (رقم طلب المتجر: ' || v_ref || ')' else '' end
        || ' للعميل ' || coalesce(v_customer->>'name', v_request.customer_name)
        || case when v_complete then '.' else '. عدم مطابقة في: ' || (select string_agg(m, '، ') from jsonb_array_elements_text(v_mismatches) m) || '.' end,
      jsonb_build_object(
        'status', v_new_status, 'trackingNumber', v_tracking, 'storeOrderReference', v_ref,
        'customer', v_customer, 'items', v_items, 'subtotal', p_payload->'subtotal',
        'shipping', p_payload->'shipping', 'total', p_payload->'total', 'shipment', v_ship,
        'matched', v_match, 'mismatches', v_mismatches));
  end if;

  return jsonb_build_object(
    'trackingNumber', v_tracking,
    'matched', v_match,
    'status', v_new_status,
    'mismatches', v_mismatches,
    'inventoryApplied', v_apply_inventory,
    'duplicate', false
  );
end;
$function$;

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

revoke all on function public.confirm_store_order_purchase(uuid) from public, anon;
grant execute on function public.confirm_store_order_purchase(uuid) to authenticated;

create or replace view public.platform_commission_watch with (security_invoker = true) as
select r.id as request_id, r.tracking_number, r.store_id, r.status, r.reconciliation_status,
       r.created_at, r.updated_at, f.flag
from public.store_order_requests r
left join public.store_order_commissions c on c.request_id = r.id
left join public.store_shipments sh on sh.request_id = r.id
cross join lateral (values
  ('no_store_report', r.status = 'awaiting_store_confirmation' and r.created_at < now() - interval '3 days'),
  ('stuck_in_review', r.status = 'needs_review' and r.updated_at < now() - interval '2 days'),
  ('customer_confirmed_unreported', r.customer_confirmed_at is not null and c.id is null
      and r.status not in ('store_rejected', 'store_cancelled', 'cancelled')),
  ('rejected_but_customer_confirmed', r.customer_confirmed_at is not null
      and r.status in ('store_rejected', 'store_cancelled', 'cancelled')),
  ('rejected_but_shipped', r.status in ('store_rejected', 'store_cancelled', 'cancelled')
      and sh.shipping_status in ('handed_to_carrier', 'in_transit', 'out_for_delivery', 'delivered')),
  ('reversed_after_sale', c.status = 'accrued' and r.status in ('store_rejected', 'store_cancelled', 'cancelled')),
  ('commission_needs_review', c.status = 'accrued' and c.review_required),
  ('delivery_not_confirmed', sh.shipping_status in ('handed_to_carrier', 'in_transit', 'out_for_delivery', 'delayed')
      and sh.updated_at < now() - interval '14 days'),
  ('below_catalog_total', r.total_amount is not null and r.total_amount + 0.005 < r.subtotal)
) as f(flag, hit)
where f.hit;

revoke all on public.platform_commission_watch from public, anon, authenticated;
grant select on public.platform_commission_watch to service_role;

create or replace function public.platform_store_order_health(p_days integer default 90)
returns table (store_id uuid, store_name text, orders bigint, reported bigint, rejected bigint, needs_review bigint,
               awaiting_over_3d bigint, customer_confirmed_unreported bigint, commission_total numeric)
language sql
stable
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
  select s.id, s.name,
         count(r.id),
         count(*) filter (where c.id is not null and c.status = 'accrued'),
         count(*) filter (where r.status in ('store_rejected', 'store_cancelled', 'cancelled')),
         count(*) filter (where r.status = 'needs_review'),
         count(*) filter (where r.status = 'awaiting_store_confirmation' and r.created_at < now() - interval '3 days'),
         count(*) filter (where r.customer_confirmed_at is not null and c.id is null),
         coalesce(sum(c.commission_amount) filter (where c.status = 'accrued'), 0)
  from public.stores s
  left join public.store_order_requests r
    on r.store_id = s.id and r.created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 90), 1000)))
  left join public.store_order_commissions c on c.request_id = r.id
  group by s.id, s.name
  order by s.name
$function$;

revoke all on function public.platform_store_order_health(integer) from public, anon, authenticated;
grant execute on function public.platform_store_order_health(integer) to service_role;

create or replace function public.platform_review_commission(
  p_commission_id uuid, p_action text, p_reason text default null, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_row public.store_order_commissions;
  v_reason text := left(nullif(trim(coalesce(p_reason, '')), ''), 500);
begin
  if p_action not in ('confirm', 'void') then
    raise exception 'Invalid action';
  end if;
  if p_action = 'void' and v_reason is null then
    raise exception 'A reason is required to void a commission';
  end if;
  select * into v_row from public.store_order_commissions where id = p_commission_id for update;
  if not found then
    raise exception 'Commission not found';
  end if;
  if v_row.status <> 'accrued' then
    raise exception 'Commission is not open';
  end if;
  if p_action = 'confirm' then
    update public.store_order_commissions
    set review_required = false, review_reason = null, updated_at = now()
    where id = v_row.id returning * into v_row;
  else
    update public.store_order_commissions
    set status = 'voided', void_reason = v_reason, voided_at = now(), voided_by = p_actor, updated_at = now()
    where id = v_row.id returning * into v_row;
  end if;
  insert into public.platform_audit_log (actor_id, action, target_type, target_id, details)
  values (p_actor, case p_action when 'confirm' then 'commission_confirmed' else 'commission_voided' end,
          'store_order_commission', v_row.id,
          jsonb_build_object('store_id', v_row.store_id, 'request_id', v_row.request_id,
                             'commission_amount', v_row.commission_amount, 'reason', v_reason));
  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'reviewRequired', v_row.review_required);
end;
$function$;

revoke all on function public.platform_review_commission(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.platform_review_commission(uuid, text, text, uuid) to service_role;

revoke all on function private.protect_order_base() from public, anon, authenticated;
revoke all on function private.commission_amounts(uuid) from public, anon, authenticated;
revoke all on function private.accrue_store_order_commission(uuid, text, boolean, text) from public, anon, authenticated;
revoke all on function private.commission_on_request_status() from public, anon, authenticated;
revoke all on function private.commission_on_adjustment() from public, anon, authenticated;
revoke all on function private.can_shipping_transition(text, text) from public, anon, authenticated;
revoke all on function private.shipment_signals() from public, anon, authenticated;
revoke all on function private.enrich_initial_order_notification(uuid) from public, anon, authenticated;

do $check$
begin
  if not exists (select 1 from pg_trigger where tgname = 'store_order_commission_on_status' and not tgisinternal)
     or not exists (select 1 from pg_trigger where tgname = 'store_shipment_signals' and not tgisinternal)
     or not exists (select 1 from pg_trigger where tgname = 'protect_order_base_trigger' and not tgisinternal)
     or to_regclass('public.store_order_commissions') is null
     or to_regclass('public.platform_commission_watch') is null then
    raise exception 'order commission controls were not installed completely';
  end if;
end
$check$;

commit;
