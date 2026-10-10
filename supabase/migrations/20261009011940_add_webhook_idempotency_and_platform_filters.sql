begin;
alter table public.store_order_notifications add column if not exists idempotency_key text;
create unique index if not exists store_order_notifications_idempotency_uidx on public.store_order_notifications(idempotency_key) where idempotency_key is not null;

create or replace function public.receive_store_order_notification(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public, private as $$
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
begin
  if v_tracking is null or v_tracking = '' then raise exception 'Missing tracking number'; end if;
  select * into v_request from public.store_order_requests where tracking_number = v_tracking for update;
  if not found then raise exception 'Order not found for tracking number %', v_tracking; end if;
  if v_idempotency is not null then
    select * into v_existing from public.store_order_notifications where idempotency_key = v_idempotency limit 1;
    if found then
      return jsonb_build_object('trackingNumber',v_existing.tracking_number,'matched',v_existing.match_status='matched','status',case when v_existing.match_status='matched' and v_existing.store_status in ('completed','success','succeeded','paid','confirmed') then 'completed' else v_request.status end,'mismatches',coalesce(v_existing.mismatch_fields,'[]'::jsonb),'duplicate',true);
    end if;
  end if;
  select count(*) into v_expected_count from public.store_order_request_items where request_id = v_request.id;
  select jsonb_array_length(v_items) into v_received_count;
  if v_expected_count <> v_received_count then v_match := false; v_mismatches := v_mismatches || jsonb_build_array('items.length'); end if;
  if exists (select 1 from public.store_order_request_items i where i.request_id = v_request.id and not exists (select 1 from jsonb_array_elements(v_items) j where nullif(j->>'productSizeId','')::uuid = i.product_size_id and (j->>'quantity')::integer = i.quantity and (j->>'unitPrice')::numeric = i.unit_price and coalesce(j->>'currency','EGP') = i.currency and (j->>'total')::numeric = i.line_total)) then v_match := false; v_mismatches := v_mismatches || jsonb_build_array('items'); end if;
  if (p_payload->>'subtotal')::numeric is distinct from v_request.subtotal then v_match := false; v_mismatches := v_mismatches || jsonb_build_array('subtotal'); end if;
  if p_payload ? 'shipping' and v_request.shipping_amount is not null and (p_payload->>'shipping')::numeric is distinct from v_request.shipping_amount then v_match := false; v_mismatches := v_mismatches || jsonb_build_array('shipping'); end if;
  if p_payload ? 'total' and v_request.total_amount is not null and (p_payload->>'total')::numeric is distinct from v_request.total_amount then v_match := false; v_mismatches := v_mismatches || jsonb_build_array('total'); end if;
  if v_status in ('completed','success','succeeded','paid','confirmed') then v_event_type := 'store_completed'; v_new_status := case when v_match then 'completed' else 'needs_review' end;
  elsif v_status in ('rejected','failed','cancelled','not_completed','declined') then v_event_type := 'store_rejected'; v_new_status := 'store_rejected';
  else v_event_type := 'store_update'; v_new_status := 'needs_review'; end if;
  v_match_status := case when v_match then 'matched' else 'mismatched' end;
  update public.store_order_requests set latest_store_payload = p_payload, reconciliation_status = v_match_status, mismatch_fields = v_mismatches, status = v_new_status, failure_reason = nullif(p_payload->>'reason',''), shipping_amount = case when p_payload ? 'shipping' then (p_payload->>'shipping')::numeric else shipping_amount end, total_amount = case when p_payload ? 'total' then (p_payload->>'total')::numeric else total_amount end, store_order_reference = coalesce(nullif(p_payload->>'storeOrderReference',''), store_order_reference), updated_at = now() where id = v_request.id;
  insert into public.store_order_notifications (request_id,tracking_number,event_type,store_status,match_status,mismatch_fields,payload,idempotency_key) values (v_request.id,v_tracking,v_event_type,v_status,v_match_status,v_mismatches,p_payload,v_idempotency);
  return jsonb_build_object('trackingNumber',v_tracking,'matched',v_match,'status',v_new_status,'mismatches',v_mismatches,'duplicate',false);
end;
$$;

create or replace function public.cancel_store_order_request(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare
  v_request public.store_order_requests;
  v_restoration public.store_order_cart_restorations;
  v_existing public.store_order_notifications;
  v_tracking text := coalesce(p_payload->>'trackingNumber', p_payload->>'orderNumber');
  v_store_id uuid := nullif(p_payload->>'storeId','')::uuid;
  v_idempotency text := nullif(p_payload->>'idempotencyKey','');
  v_items jsonb := coalesce(p_payload->'items','[]'::jsonb);
  v_expected jsonb; v_mismatches jsonb := '[]'::jsonb; v_expected_count integer; v_received_count integer; v_match boolean := true;
begin
  if coalesce(v_tracking,'') = '' then raise exception 'Missing tracking number'; end if;
  select * into v_request from public.store_order_requests r where (r.tracking_number = v_tracking or (r.checkout_tracking_number = v_tracking and (v_store_id is null or r.store_id = v_store_id))) and (v_store_id is null or r.store_id = v_store_id) order by r.created_at desc limit 1 for update;
  if not found then raise exception 'Order not found for tracking number %', v_tracking; end if;
  if v_idempotency is not null then
    select * into v_existing from public.store_order_notifications where idempotency_key = v_idempotency limit 1;
    if found then select * into v_restoration from public.store_order_cart_restorations where request_id=v_request.id; return jsonb_build_object('trackingNumber',v_request.tracking_number,'checkoutTrackingNumber',v_request.checkout_tracking_number,'status',v_request.status,'matched',v_existing.match_status='matched','mismatches',coalesce(v_existing.mismatch_fields,'[]'::jsonb),'restoreToken',v_restoration.restore_token,'items',coalesce(v_restoration.items,'[]'::jsonb),'duplicate',true); end if;
  end if;
  if v_request.status = 'completed' then raise exception 'Completed order cannot be cancelled'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('productSizeId',i.product_size_id,'storeProductId',i.store_product_id,'name',i.product_name,'brand',i.brand_name,'size',i.size_label,'quantity',i.quantity,'unitPrice',i.unit_price,'total',i.line_total,'currency',i.currency) order by i.id),'[]'::jsonb), count(*) into v_expected, v_expected_count from public.store_order_request_items i where i.request_id=v_request.id;
  select jsonb_array_length(v_items) into v_received_count;
  if v_received_count <> v_expected_count then v_match := false; v_mismatches := v_mismatches || jsonb_build_array('items.length'); end if;
  if jsonb_array_length(v_items) > 0 and exists (select 1 from jsonb_array_elements(v_expected) e where not exists (select 1 from jsonb_array_elements(v_items) x where nullif(x->>'productSizeId','')::uuid = nullif(e->>'productSizeId','')::uuid and (x->>'quantity')::integer = (e->>'quantity')::integer and (x->>'unitPrice')::numeric = (e->>'unitPrice')::numeric and (x->>'total')::numeric = (e->>'total')::numeric)) then v_match := false; v_mismatches := v_mismatches || jsonb_build_array('items'); end if;
  if p_payload ? 'subtotal' and (p_payload->>'subtotal')::numeric is distinct from v_request.subtotal then v_match := false; v_mismatches := v_mismatches || jsonb_build_array('subtotal'); end if;
  update public.store_order_requests set status='store_cancelled',latest_store_payload=p_payload,reconciliation_status=case when v_match then 'matched' else 'mismatched' end,mismatch_fields=v_mismatches,failure_reason=coalesce(nullif(p_payload->>'reason',''),'Cancelled by customer in store basket'),updated_at=now() where id=v_request.id;
  insert into public.store_order_notifications (request_id,tracking_number,event_type,store_status,match_status,mismatch_fields,payload,idempotency_key) values (v_request.id,v_request.tracking_number,'store_cancelled','store_cancelled',case when v_match then 'matched' else 'mismatched' end,v_mismatches,p_payload,v_idempotency);
  insert into public.store_order_cart_restorations (request_id,tracking_number,user_id,customer_phone,customer_email,items,reason) values (v_request.id,v_request.tracking_number,v_request.user_id,v_request.customer_phone,v_request.customer_email,v_expected,coalesce(nullif(p_payload->>'reason',''),'Cancelled by customer in store basket')) on conflict (request_id) do update set items=excluded.items,reason=excluded.reason,status='pending',restored_at=null;
  select * into v_restoration from public.store_order_cart_restorations where request_id=v_request.id;
  return jsonb_build_object('trackingNumber',v_request.tracking_number,'checkoutTrackingNumber',v_request.checkout_tracking_number,'status','store_cancelled','matched',v_match,'mismatches',v_mismatches,'restoreToken',v_restoration.restore_token,'items',v_expected,'duplicate',false);
end;
$$;
commit;