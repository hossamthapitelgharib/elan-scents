alter table public.store_order_requests
  add column if not exists inventory_applied_at timestamptz;

create index if not exists store_order_requests_inventory_applied_idx
  on public.store_order_requests (inventory_applied_at)
  where inventory_applied_at is not null;

create or replace function public.receive_store_order_notification(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_tracking text := coalesce(p_payload->>'trackingNumber', p_payload->>'orderNumber');
  v_idempotency text := nullif(p_payload->>'idempotencyKey','');
  v_request public.store_order_requests;
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

  if v_status in ('completed','success','succeeded','paid','confirmed') then
    v_event_type := 'store_completed';
    v_new_status := case when v_match then 'completed' else 'needs_review' end;
  elsif v_status in ('rejected','failed','cancelled','not_completed','declined') then
    v_event_type := 'store_rejected';
    v_new_status := 'store_rejected';
  else
    v_event_type := 'store_update';
    v_new_status := 'needs_review';
  end if;

  v_match_status := case when v_match then 'matched' else 'mismatched' end;
  v_apply_inventory := v_match
    and v_new_status = 'completed'
    and v_request.inventory_applied_at is null;

  update public.store_order_requests
  set latest_store_payload = p_payload,
      reconciliation_status = v_match_status,
      mismatch_fields = v_mismatches,
      status = v_new_status,
      failure_reason = nullif(p_payload->>'reason',''),
      shipping_amount = case when p_payload ? 'shipping' then (p_payload->>'shipping')::numeric else shipping_amount end,
      total_amount = case when p_payload ? 'total' then (p_payload->>'total')::numeric else total_amount end,
      store_order_reference = coalesce(nullif(p_payload->>'storeOrderReference',''), store_order_reference),
      inventory_applied_at = case when v_apply_inventory then now() else inventory_applied_at end,
      updated_at = now()
  where id = v_request.id;

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

  insert into public.store_order_notifications
    (request_id,tracking_number,event_type,store_status,match_status,mismatch_fields,payload,idempotency_key)
  values
    (v_request.id,v_tracking,v_event_type,v_status,v_match_status,v_mismatches,p_payload,v_idempotency);

  return jsonb_build_object(
    'trackingNumber', v_tracking,
    'matched', v_match,
    'status', v_new_status,
    'mismatches', v_mismatches,
    'inventoryApplied', v_apply_inventory,
    'duplicate', false
  );
end;
$$;

revoke all on function public.receive_store_order_notification(jsonb) from public, anon, authenticated;
grant execute on function public.receive_store_order_notification(jsonb) to service_role;
