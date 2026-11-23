-- The payment page must be on a host the store listed (owner's ruling 21 Nov 2026: the payment provider and the carrier belong to the store;
-- docs/purchase-flow-correction-plan.ar.md stage 1 "a store without a technical link takes no order").
--   * store_integrations.payment_hosts: the exact hosts (lower-case, no scheme, no path, no wildcard; at most 10) the store's payment windows may live on.
--   * A store is "linked" only with at least one host (private.store_order_ready), so the order button of a store without hosts stays locked.
--   * merchant_review_order refuses an approval whose payment window address is not on the list; the refusal is recorded as an invalid reply of
--     the merchant (the platform dashboard is told of the failed attempt, as for any invalid reply).
--   * payment_windows.host (stored, derived from the address) lets the customer's pages say where the payment page is before the customer goes there,
--     without ever sending the address itself.
-- store_integrations was empty on the live database when this was written (no store is linked yet), so no existing link is made unready by it.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The host of a payment page address
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.payment_host_of(p_url text)
returns text language sql immutable set search_path to 'pg_catalog' as $$
  select lower(substring(p_url from '^https://([^[:space:]/?#@:]+)'));
$$;
revoke all on function private.payment_host_of(text) from public, anon, authenticated;
grant execute on function private.payment_host_of(text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The list on the integration, and the host on the window
-- ---------------------------------------------------------------------------------------------------------------------
alter table public.store_integrations add column if not exists payment_hosts text[] not null default '{}'::text[];
alter table public.store_integrations drop constraint if exists store_integrations_payment_hosts_valid;
alter table public.store_integrations add constraint store_integrations_payment_hosts_valid check (
  cardinality(payment_hosts) <= 10 and array_position(payment_hosts, null) is null
  and (cardinality(payment_hosts) = 0
       or (char_length(array_to_string(payment_hosts, ',')) <= 2000
           and array_to_string(payment_hosts, ',') ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(,[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)*$')));
comment on column public.store_integrations.payment_hosts is 'The hosts (exact, lower-case, no scheme or path) that the payment windows of this store may live on. A store is linked only with at least one; merchant_review_order refuses a payment window address on any other host.';

alter table public.payment_windows add column if not exists host text generated always as (private.payment_host_of(url)) stored;
comment on column public.payment_windows.host is 'The host of the payment page, derived from url. The customer''s pages show it before the customer goes there; the address itself is never sent to them with the order list.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. A store is linked only with a payment host
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.store_order_ready(p_store_id uuid)
returns boolean language sql stable security definer set search_path to 'public', 'private', 'pg_temp' as $$
  select exists (
    select 1 from public.store_integrations i join public.stores s on s.id = i.store_id
    where i.store_id = p_store_id and s.status = 'active' and i.enabled
      and i.order_endpoint is not null and char_length(btrim(i.webhook_secret)) >= 16
      and cardinality(i.payment_hosts) > 0);
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The merchant's approval: its payment window must be on its list
-- ---------------------------------------------------------------------------------------------------------------------
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
    -- The payment page must be on one of the hosts the store listed when it was linked (a payment page elsewhere is not the store's).
    if not exists (select 1 from public.store_integrations i
                   where i.store_id = v_req.store_id and private.payment_host_of(v_url) = any (i.payment_hosts)) then
      raise exception 'The payment window address is not on the store''s list of payment hosts' using errcode = 'P0001';
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

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The customer's view of the order: the window says where it is
-- ---------------------------------------------------------------------------------------------------------------------
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
    'window', case when v_w.id is null then null else jsonb_build_object('state', v_w.state, 'host', v_w.host) end);
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Grants stay as they were: the server alone
-- ---------------------------------------------------------------------------------------------------------------------
revoke all on function public.merchant_review_order(uuid, jsonb), public.customer_order_state(uuid, uuid) from public, anon, authenticated;
grant execute on function public.merchant_review_order(uuid, jsonb), public.customer_order_state(uuid, uuid) to service_role;
