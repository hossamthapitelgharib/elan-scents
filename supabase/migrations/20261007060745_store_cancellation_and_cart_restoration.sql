alter table public.store_order_requests drop constraint if exists store_order_requests_status_check;
alter table public.store_order_requests add constraint store_order_requests_status_check check (status in ('awaiting_store_confirmation','store_confirmed','store_rejected','store_cancelled','needs_review','completed','cancelled'));
alter table public.store_order_notifications drop constraint if exists store_order_notifications_event_type_check;
alter table public.store_order_notifications add constraint store_order_notifications_event_type_check check (event_type in ('initial_submitted','store_completed','store_rejected','store_cancelled','store_update'));

create table if not exists public.store_order_cart_restorations (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.store_order_requests(id) on delete cascade,
  restore_token uuid not null unique default gen_random_uuid(),
  tracking_number text not null,
  user_id uuid references auth.users(id),
  customer_phone text,
  customer_email text,
  items jsonb not null default '[]'::jsonb,
  reason text,
  status text not null default 'pending' check (status in ('pending','restored','expired')),
  restored_at timestamptz,
  created_at timestamptz not null default now(),
  unique(request_id)
);
create index if not exists store_order_cart_restorations_tracking_idx on public.store_order_cart_restorations(tracking_number, created_at desc);
alter table public.store_order_cart_restorations enable row level security;
create policy store_order_cart_restorations_admin_all on public.store_order_cart_restorations for all to authenticated using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy store_order_cart_restorations_owner_read on public.store_order_cart_restorations for select to authenticated using (user_id = auth.uid());
create policy store_order_cart_restorations_owner_update on public.store_order_cart_restorations for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.cancel_store_order_request(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare
  v_request public.store_order_requests;
  v_restoration public.store_order_cart_restorations;
  v_tracking text := coalesce(p_payload->>'trackingNumber', p_payload->>'orderNumber');
  v_store_id uuid := nullif(p_payload->>'storeId','')::uuid;
  v_items jsonb := coalesce(p_payload->'items','[]'::jsonb);
  v_expected jsonb;
  v_mismatches jsonb := '[]'::jsonb;
  v_expected_count integer;
  v_received_count integer;
  v_match boolean := true;
begin
  if coalesce(v_tracking,'') = '' then raise exception 'Missing tracking number'; end if;
  select * into v_request from public.store_order_requests r where (r.tracking_number = v_tracking or (r.checkout_tracking_number = v_tracking and (v_store_id is null or r.store_id = v_store_id))) and (v_store_id is null or r.store_id = v_store_id) order by r.created_at desc limit 1 for update;
  if not found then raise exception 'Order not found for tracking number %', v_tracking; end if;
  if v_request.status = 'completed' then raise exception 'Completed order cannot be cancelled'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('productSizeId',i.product_size_id,'storeProductId',i.store_product_id,'name',i.product_name,'brand',i.brand_name,'size',i.size_label,'quantity',i.quantity,'unitPrice',i.unit_price,'total',i.line_total,'currency',i.currency) order by i.id),'[]'::jsonb), count(*) into v_expected, v_expected_count from public.store_order_request_items i where i.request_id=v_request.id;
  select jsonb_array_length(v_items) into v_received_count;
  if v_received_count <> v_expected_count then v_match := false; v_mismatches := v_mismatches || jsonb_build_array('items.length'); end if;
  if jsonb_array_length(v_items) > 0 and exists (select 1 from jsonb_array_elements(v_expected) e where not exists (select 1 from jsonb_array_elements(v_items) x where nullif(x->>'productSizeId','')::uuid = nullif(e->>'productSizeId','')::uuid and (x->>'quantity')::integer = (e->>'quantity')::integer and (x->>'unitPrice')::numeric = (e->>'unitPrice')::numeric and (x->>'total')::numeric = (e->>'total')::numeric)) then v_match := false; v_mismatches := v_mismatches || jsonb_build_array('items'); end if;
  if p_payload ? 'subtotal' and (p_payload->>'subtotal')::numeric is distinct from v_request.subtotal then v_match := false; v_mismatches := v_mismatches || jsonb_build_array('subtotal'); end if;
  update public.store_order_requests set status='store_cancelled', latest_store_payload=p_payload, reconciliation_status=case when v_match then 'matched' else 'mismatched' end, mismatch_fields=v_mismatches, failure_reason=coalesce(nullif(p_payload->>'reason',''),'Cancelled by customer in store basket'), updated_at=now() where id=v_request.id;
  insert into public.store_order_notifications (request_id, tracking_number, event_type, store_status, match_status, mismatch_fields, payload) values (v_request.id, v_request.tracking_number, 'store_cancelled', 'store_cancelled', case when v_match then 'matched' else 'mismatched' end, v_mismatches, p_payload);
  insert into public.store_order_cart_restorations (request_id, tracking_number, user_id, customer_phone, customer_email, items, reason) values (v_request.id, v_request.tracking_number, v_request.user_id, v_request.customer_phone, v_request.customer_email, v_expected, coalesce(nullif(p_payload->>'reason',''),'Cancelled by customer in store basket')) on conflict (request_id) do update set items=excluded.items, reason=excluded.reason, status='pending', restored_at=null;
  select * into v_restoration from public.store_order_cart_restorations where request_id=v_request.id;
  return jsonb_build_object('trackingNumber',v_request.tracking_number,'checkoutTrackingNumber',v_request.checkout_tracking_number,'status','store_cancelled','matched',v_match,'mismatches',v_mismatches,'restoreToken',v_restoration.restore_token,'items',v_expected);
end;
$$;
revoke all on function public.cancel_store_order_request(jsonb) from public;
grant execute on function public.cancel_store_order_request(jsonb) to authenticated;
