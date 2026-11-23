-- Back to the previous text of the functions (20261122062358): a payment window on any https host is accepted, a store is linked without a
-- payment host, and the customer state carries only the window state. Drops payment_windows.host and store_integrations.payment_hosts.
-- NOT restorable: the list of hosts a store gave (the column is dropped with its values). Take a backup first (supabase/rollback/README.md rule 1).

create or replace function private.store_order_ready(p_store_id uuid)
returns boolean language sql stable security definer set search_path to 'public', 'private', 'pg_temp' as $$
  select exists (
    select 1 from public.store_integrations i join public.stores s on s.id = i.store_id
    where i.store_id = p_store_id and s.status = 'active' and i.enabled
      and i.order_endpoint is not null and char_length(btrim(i.webhook_secret)) >= 16);
$$;

create or replace function public.merchant_review_order(p_store_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_tracking text := nullif(btrim(coalesce(p_payload->>'trackingNumber', '')), '');
  v_decision text := lower(coalesce(p_payload->>'decision', ''));
  v_reason text := nullif(btrim(coalesce(p_payload->>'reason', '')), '');
  v_req public.store_order_requests;
  v_url text;
  v_event text := nullif(btrim(coalesce(p_payload->>'eventId', '')), '');
begin
  if p_store_id is null or v_tracking is null then raise exception 'Order not found' using errcode = 'P0001'; end if;
  select * into v_req from public.store_order_requests where tracking_number = v_tracking and store_id = p_store_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0001'; end if;
  if v_decision not in ('approve', 'reject') then raise exception 'Decision must be approve or reject' using errcode = 'P0001'; end if;
  if v_event is not null and exists (select 1 from public.store_order_notifications where idempotency_key = p_store_id::text || ':decision:' || v_event) then
    return jsonb_build_object('trackingNumber', v_tracking, 'status', v_req.status, 'duplicate', true);
  end if;
  if (v_decision = 'approve' and v_req.status = 'store_confirmed') or (v_decision = 'reject' and v_req.status = 'store_rejected') then
    return jsonb_build_object('trackingNumber', v_tracking, 'status', v_req.status, 'duplicate', true);
  end if;
  if v_req.status not in ('awaiting_store_confirmation', 'needs_review') then raise exception 'Order is not waiting for the store' using errcode = 'P0001'; end if;

  if v_decision = 'reject' then
    if v_reason is null then raise exception 'A rejection needs a reason' using errcode = 'P0001'; end if;
    if char_length(v_reason) > 500 then raise exception 'Reason is too long' using errcode = 'P0001'; end if;
    update public.store_order_requests set status = 'store_rejected', failure_reason = v_reason, updated_at = now() where id = v_req.id;
  else
    v_url := nullif(btrim(coalesce(p_payload->>'paymentWindowUrl', '')), '');
    if v_url is null or char_length(v_url) > 2000 or v_url !~* '^https://[^[:space:]/?#@]+(/[^[:space:]]*)?$' then
      raise exception 'An approval needs the https address of the payment window' using errcode = 'P0001';
    end if;
    -- Anything else in the reply (a validity, a shipping amount, a total) is not read: those belong to the merchant's window.
    update public.store_order_requests set status = 'store_confirmed', updated_at = now() where id = v_req.id;
    insert into public.payment_windows (request_id, store_id, url) values (v_req.id, v_req.store_id, v_url)
    on conflict (request_id) do nothing;
  end if;
  update public.merchant_deliveries set status = 'delivered', finished_at = now(), locked_until = null
    where request_id = v_req.id and kind = 'order' and status in ('pending', 'sending');

  insert into public.store_order_notifications (request_id, tracking_number, event_type, store_status, match_status, payload, idempotency_key)
  values (v_req.id, v_tracking, 'store_update', case when v_decision = 'approve' then 'confirmed' else 'rejected' end, 'pending',
          jsonb_build_object('type', 'merchant_decision', 'decision', v_decision, 'reason', v_reason), case when v_event is not null then p_store_id::text || ':decision:' || v_event end);
  return jsonb_build_object('trackingNumber', v_tracking, 'status', (select status from public.store_order_requests where id = v_req.id), 'duplicate', false,
                            'payableAmount', (select payable_amount from public.store_order_requests where id = v_req.id));
end; $$;

create or replace function public.customer_order_state(p_request_id uuid, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_req public.store_order_requests; v_d public.merchant_deliveries; v_w public.payment_windows;
begin
  if p_user_id is null then raise exception 'Authentication required' using errcode = 'P0001'; end if;
  select * into v_req from public.store_order_requests where id = p_request_id and user_id = p_user_id;
  if not found then raise exception 'Order not found' using errcode = 'P0001'; end if;
  select * into v_d from public.merchant_deliveries where request_id = v_req.id and kind = 'order';
  select * into v_w from public.payment_windows where request_id = v_req.id;
  return jsonb_build_object('id', v_req.id, 'trackingNumber', v_req.tracking_number, 'status', v_req.status, 'paymentStatus', v_req.payment_status,
    'cancelReason', v_req.cancel_reason, 'failureReason', v_req.failure_reason,
    'delivery', case when v_d.id is null then null else jsonb_build_object('state', v_d.status, 'attempts', v_d.attempts, 'maxAttempts', v_d.max_attempts) end,
    'window', case when v_w.id is null then null else jsonb_build_object('state', v_w.state) end);
end; $$;

alter table public.payment_windows drop column if exists host;
alter table public.store_integrations drop constraint if exists store_integrations_payment_hosts_valid;
alter table public.store_integrations drop column if exists payment_hosts;
drop function if exists private.payment_host_of(text);

revoke all on function public.merchant_review_order(uuid, jsonb), public.customer_order_state(uuid, uuid) from public, anon, authenticated;
grant execute on function public.merchant_review_order(uuid, jsonb), public.customer_order_state(uuid, uuid) to service_role;
