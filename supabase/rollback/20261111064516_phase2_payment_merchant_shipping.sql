-- Rollback of 20261111064516_phase2_payment_merchant_shipping.sql: the matcher goes back to the 20261103152100 definition (restored below), and everything
-- Phase 2 added is removed. Payment, notice and shipping-event rows are lost with their tables: take a backup first if any real order was paid.
begin;

drop trigger if exists guard_payment_fields on public.store_order_requests;
drop trigger if exists order_approval_stamp on public.store_order_requests;
drop trigger if exists guard_shipping_requires_payment on public.store_shipments;
drop trigger if exists log_shipment_event on public.store_shipments;

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
  v_items jsonb := case when jsonb_typeof(p_payload->'items') = 'array' then p_payload->'items' else '[]'::jsonb end;
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
          and j->>'platformOrderNumber' = i.platform_order_number
      )
  ) then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('items');
  end if;

  if (p_payload->>'subtotal')::numeric is distinct from v_request.subtotal then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('subtotal');
  end if;
  -- Shipping and total are the merchant's own display amounts. They are compared with an earlier ACCEPTED report only:
  -- a report that was held for review can be corrected with different amounts.
  if p_payload ? 'shipping' and v_request.shipping_amount is not null and v_request.status = 'completed'
     and (p_payload->>'shipping')::numeric is distinct from v_request.shipping_amount then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('shipping');
  end if;
  if p_payload ? 'total' and v_request.total_amount is not null and v_request.status = 'completed'
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
  if nullif(v_customer->>'id', '') is not null and ((v_customer->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_request.user_id is null or (v_customer->>'id')::uuid is distinct from v_request.user_id) then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('customer.id');
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
    if v_ref is null and exists (
      select 1 from jsonb_array_elements(v_items) j
      where nullif(trim(coalesce(j->>'merchantOrderReference','')), '') is null
    ) then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('merchantOrderReference');
    end if;
    if exists (
      select nullif(trim(j->>'merchantOrderReference'), '')
      from jsonb_array_elements(v_items) j
      where nullif(trim(j->>'merchantOrderReference'), '') is not null
      group by nullif(trim(j->>'merchantOrderReference'), '') having count(*) > 1
    ) then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('merchantOrderReference.duplicate');
    end if;
    if v_ref is not null and exists (select 1 from public.store_order_requests r
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

  v_has_commission := exists (
    select 1 from public.commissions c
    join public.store_order_request_items i on i.id = c.store_order_request_item_id
    where i.request_id = v_request.id and c.status in ('pending','payable','paid')
  );

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

  if v_completed_like and v_match then
    update public.store_order_request_items i
    set merchant_order_reference = nullif(trim(j->>'merchantOrderReference'), '')
    from jsonb_array_elements(v_items) j
    where i.request_id = v_request.id
      and j->>'platformOrderNumber' = i.platform_order_number;
  end if;

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
    else
      perform private.accrue_store_order_commission(v_request.id, 'store_report_mismatch', true, 'store_report_mismatch');
    end if;
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
        'customerId', v_request.user_id,
        'customer', coalesce(v_customer, '{}'::jsonb) || jsonb_build_object('id', v_request.user_id),
        'items', v_items, 'subtotal', p_payload->'subtotal',
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
revoke all on function public.receive_store_order_notification(jsonb) from public, anon, authenticated;
grant execute on function public.receive_store_order_notification(jsonb) to service_role;

drop function if exists public.merchant_review_order(uuid, jsonb);
drop function if exists public.select_order_payment_server(uuid, uuid, uuid, text);
drop function if exists public.record_payment_event(uuid, jsonb);
drop function if exists public.record_shipment_event(uuid, jsonb);
drop function if exists private.finalize_payment(uuid);
drop function if exists private.payment_instructions(public.order_payments, public.store_order_requests);
drop function if exists private.apply_delivery_proof(uuid, text);
drop function if exists private.store_payment_options(uuid);
drop function if exists private.guard_payment_fields();
drop function if exists private.order_approval_stamp();
drop function if exists private.guard_shipping_requires_payment();
drop function if exists private.log_shipment_event();

drop table if exists public.order_payment_events;
drop table if exists public.order_payments;
drop table if exists public.platform_order_notices;
drop table if exists public.store_shipment_events;
drop table if exists public.store_payment_methods;

drop function if exists private.payment_executed(text);
drop function if exists private.phase2_touch();
drop function if exists private.forbid_change();

alter table public.store_order_requests
  drop column if exists approved_at,
  drop column if exists payable_amount,
  drop column if exists payment_options,
  drop column if exists payment_status,
  drop column if exists payment_method,
  drop column if exists payment_provider,
  drop column if exists payment_reference,
  drop column if exists paid_at,
  drop column if exists cart_cleared_at,
  drop column if exists sale_proven_at;

commit;
