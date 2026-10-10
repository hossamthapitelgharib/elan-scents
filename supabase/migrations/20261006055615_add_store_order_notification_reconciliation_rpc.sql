create or replace function public.receive_store_order_notification(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_tracking text := coalesce(p_payload->>'trackingNumber', p_payload->>'orderNumber');
  v_request public.store_order_requests;
  v_status text := lower(coalesce(p_payload->>'status',''));
  v_match boolean := true;
  v_mismatches jsonb := '[]'::jsonb;
  v_items jsonb := coalesce(p_payload->'items','[]'::jsonb);
  v_expected_count integer;
  v_received_count integer;
  v_event_type text;
  v_match_status text;
  v_new_status text;
begin
  if v_tracking is null or v_tracking = '' then raise exception 'Missing tracking number'; end if;
  select * into v_request from public.store_order_requests where tracking_number = v_tracking for update;
  if not found then raise exception 'Order not found for tracking number %', v_tracking; end if;
  select count(*) into v_expected_count from public.store_order_request_items where request_id = v_request.id;
  select jsonb_array_length(v_items) into v_received_count;
  if v_expected_count <> v_received_count then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('items.length');
  end if;
  if exists (select 1 from public.store_order_request_items i where i.request_id = v_request.id and not exists (select 1 from jsonb_array_elements(v_items) j where nullif(j->>'productSizeId','')::uuid = i.product_size_id and (j->>'quantity')::integer = i.quantity and (j->>'unitPrice')::numeric = i.unit_price and coalesce(j->>'currency','EGP') = i.currency and (j->>'total')::numeric = i.line_total)) then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('items');
  end if;
  if (p_payload->>'subtotal')::numeric is distinct from v_request.subtotal then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('subtotal');
  end if;
  if p_payload ? 'shipping' and v_request.shipping_amount is not null and (p_payload->>'shipping')::numeric is distinct from v_request.shipping_amount then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('shipping');
  end if;
  if p_payload ? 'total' and v_request.total_amount is not null and (p_payload->>'total')::numeric is distinct from v_request.total_amount then
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
  update public.store_order_requests set latest_store_payload = p_payload, reconciliation_status = v_match_status, mismatch_fields = v_mismatches, status = v_new_status, failure_reason = nullif(p_payload->>'reason',''), shipping_amount = case when p_payload ? 'shipping' then (p_payload->>'shipping')::numeric else shipping_amount end, total_amount = case when p_payload ? 'total' then (p_payload->>'total')::numeric else total_amount end, store_order_reference = coalesce(nullif(p_payload->>'storeOrderReference',''), store_order_reference), updated_at = now() where id = v_request.id;
  insert into public.store_order_notifications (request_id, tracking_number, event_type, store_status, match_status, mismatch_fields, payload) values (v_request.id, v_tracking, v_event_type, v_status, v_match_status, v_mismatches, p_payload);
  return jsonb_build_object('trackingNumber',v_tracking,'matched',v_match,'status',v_new_status,'mismatches',v_mismatches);
end;
$$;

revoke all on function public.receive_store_order_notification(jsonb) from public;
grant execute on function public.receive_store_order_notification(jsonb) to authenticated;