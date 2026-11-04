begin;
do $jobs$
declare v_jobs bigint[]; v_job bigint;
begin
  select array_agg(jobid) into v_jobs from cron.job where jobname='release-due-store-commissions';
  foreach v_job in array coalesce(v_jobs, '{}') loop perform cron.unschedule(v_job); end loop;
end;
$jobs$;
drop trigger if exists set_verified_delivery_commission_deadlines on public.store_shipments;
drop trigger if exists commissions_on_request_adjustment on public.store_order_item_adjustments;
drop trigger if exists store_order_commission_on_status on public.store_order_requests;
create trigger store_order_commission_on_status after update of status on public.store_order_requests for each row when (old.status is distinct from new.status) execute function private.commission_on_request_status();
create trigger store_order_commission_on_adjustment after insert or update or delete on public.store_order_item_adjustments for each row execute function private.commission_on_adjustment();
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

drop function if exists private.assign_platform_order_number();
drop function if exists private.recalculate_request_item_commission(uuid);
drop function if exists private.recalculate_commissions_on_adjustment();
drop function if exists private.notify_commission_claim(uuid);
drop function if exists private.release_due_commissions();
drop function if exists private.set_verified_delivery_commission_deadlines();
drop function if exists public.platform_set_store_commercial_terms(uuid,integer,uuid);
drop function if exists public.platform_mark_commission_paid(uuid,text,uuid);
-- Keep additive columns, indexes, new commission rows and claim notifications: these may contain financial evidence.
commit;
