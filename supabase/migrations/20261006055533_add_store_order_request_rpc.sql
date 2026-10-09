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
begin
  v_store_id := (p_payload->>'storeId')::uuid;
  if not exists (select 1 from public.stores s where s.id = v_store_id and s.status = 'active') then
    raise exception 'Invalid or inactive store';
  end if;
  if coalesce(trim(p_payload->'customer'->>'name'), '') = '' or coalesce(trim(p_payload->'customer'->>'phone'), '') = '' or coalesce(trim(p_payload->'customer'->>'address'), '') = '' then
    raise exception 'Customer name, phone and address are required';
  end if;
  insert into public.store_order_requests (tracking_number, store_id, user_id, customer_name, customer_phone, customer_email, customer_address, customer_notes, subtotal, currency, initial_payload)
  values (p_payload->>'trackingNumber', v_store_id, v_user_id, trim(p_payload->'customer'->>'name'), trim(p_payload->'customer'->>'phone'), nullif(trim(p_payload->'customer'->>'email'), ''), trim(p_payload->'customer'->>'address'), nullif(trim(p_payload->'customer'->>'notes'), ''), coalesce((p_payload->>'subtotal')::numeric, 0), coalesce(nullif(p_payload->>'currency',''), 'EGP'), p_payload)
  returning * into v_request;
  for v_item in select value from jsonb_array_elements(coalesce(p_payload->'items','[]'::jsonb)) loop
    insert into public.store_order_request_items (request_id, store_product_id, product_size_id, product_name, brand_name, size_label, quantity, unit_price, line_total, currency)
    values (v_request.id, nullif(v_item->>'storeProductId','')::uuid, nullif(v_item->>'productSizeId','')::uuid, v_item->>'name', v_item->>'brand', nullif(v_item->>'size',''), (v_item->>'quantity')::integer, (v_item->>'unitPrice')::numeric, (v_item->>'total')::numeric, coalesce(nullif(v_item->>'currency',''), 'EGP'));
  end loop;
  insert into public.store_order_notifications (request_id, tracking_number, event_type, store_status, match_status, payload)
  values (v_request.id, v_request.tracking_number, 'initial_submitted', 'awaiting_store_confirmation', 'matched', p_payload);
  return jsonb_build_object('id', v_request.id, 'trackingNumber', v_request.tracking_number, 'status', v_request.status);
end;
$$;

revoke all on function public.create_store_order_request(jsonb) from public;
grant execute on function public.create_store_order_request(jsonb) to anon, authenticated;