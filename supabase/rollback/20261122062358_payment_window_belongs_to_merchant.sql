-- Back to the stage 1 payment window of 20 Nov 2026: the one Élan clocked (30 minutes at most, expires_at) and cancelled by itself.
--
-- This puts back the stage 1 text of private.cancel_unpaid_order, public.merchant_review_order, public.open_payment_window,
-- public.payment_window_return, public.expire_payment_windows and public.customer_order_state (copied from 20261115193039), puts the expiry clause back
-- into public.place_store_order, brings payment_windows.expires_at back and drops what 20261122062358 added (merchant_window_closed,
-- alert_stale_payment_windows, stale_alerted_at).
-- NOT restorable: an order cancelled while the new text was live keeps its reason, and a window row already written has no expiry of its own, so the
-- old expiry is given as issued_at + 30 minutes for rows that exist (an old window therefore expires the moment the clock function runs again).
-- Take a backup first (supabase/rollback/README.md rule 1).

-- 1. The table: the clock comes back
alter table public.payment_windows add column if not exists expires_at timestamptz;
update public.payment_windows set expires_at = issued_at + interval '30 minutes' where expires_at is null;
alter table public.payment_windows alter column expires_at set not null;
alter table public.payment_windows drop constraint if exists payment_windows_expiry_check;
alter table public.payment_windows add constraint payment_windows_expiry_check check (expires_at > issued_at and expires_at <= issued_at + interval '30 minutes');
alter table public.payment_windows drop column if exists stale_alerted_at;
comment on table public.payment_windows is 'The merchant''s own payment window for an approved order. success_claimed is only what the customer''s browser said on return: it proves nothing, a payment is proven by a neutral confirmation (stage 2).';

-- 2. What the new migration added
drop function if exists public.merchant_window_closed(uuid, jsonb);
drop function if exists public.alert_stale_payment_windows();

-- 3. The stage 1 text of the functions
create or replace function private.cancel_unpaid_order(p_request_id uuid, p_reason text, p_detail text default null)
returns boolean language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_req public.store_order_requests; v_body text;
begin
  if p_reason not in ('store_unresponsive', 'payment_window_cancelled', 'payment_window_closed', 'payment_window_expired', 'customer_requested_before_payment') then
    raise exception 'Unknown cancel reason' using errcode = 'P0001';
  end if;
  select * into v_req from public.store_order_requests where id = p_request_id for update;
  if not found or v_req.status not in ('awaiting_store_confirmation', 'store_confirmed') or private.payment_executed(v_req.payment_status) then
    return false;
  end if;
  -- Expiry only ever cancels a window that is still unfinished and past its time (the customer may have returned a moment ago).
  if p_reason = 'payment_window_expired' and not exists (
       select 1 from public.payment_windows w where w.request_id = v_req.id and w.state in ('issued', 'opened') and w.expires_at <= now()) then
    return false;
  end if;
  update public.store_order_requests set status = 'cancelled', cancel_reason = p_reason, cancel_detail = left(p_detail, 500), cancelled_at = now(), updated_at = now()
    where id = v_req.id;
  update public.payment_windows set state = case when p_reason = 'payment_window_expired' then 'expired' else 'closed' end, ended_at = now()
    where request_id = v_req.id and state in ('issued', 'opened');
  -- Anything still being sent to the merchant as an order is abandoned; the merchant is told of the cancellation instead.
  update public.merchant_deliveries set status = 'failed', finished_at = now()
    where request_id = v_req.id and kind = 'order' and status in ('pending', 'sending');
  insert into public.merchant_deliveries (request_id, store_id, kind, max_attempts) values (v_req.id, v_req.store_id, 'cancel', 8)
    on conflict (request_id, kind) do nothing;
  v_body := case p_reason
    when 'store_unresponsive' then 'نعتذر عن تنفيذ طلبك في الوقت الحالي، برجاء إعادة المحاولة بعد ساعة.'
    when 'customer_requested_before_payment' then 'أُلغي الطلب بناءً على طلبك قبل الدفع.'
    else 'أُلغي الطلب لأن نافذة الدفع أُغلقت قبل إتمام الدفع، ومنتجاتك ما زالت في سلتك.' end;
  perform public.emit_order_notification((select r from public.store_order_requests r where r.id = v_req.id),
    'order_cancelled', 'أُلغي الطلب ' || v_req.tracking_number, v_body,
    jsonb_build_object('trackingNumber', v_req.tracking_number, 'cancelReason', p_reason, 'detail', left(p_detail, 200)));
  return true;
end; $$;

create or replace function public.merchant_review_order(p_store_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_tracking text := nullif(btrim(coalesce(p_payload->>'trackingNumber', '')), '');
  v_decision text := lower(coalesce(p_payload->>'decision', ''));
  v_reason text := nullif(btrim(coalesce(p_payload->>'reason', '')), '');
  v_req public.store_order_requests;
  v_ship numeric; v_total numeric; v_url text; v_valid integer := 1800; v_bad boolean;
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
    if p_payload ? 'validitySeconds' then
      v_bad := case when coalesce(p_payload->>'validitySeconds', '') ~ '^\d{1,5}$' then (p_payload->>'validitySeconds')::integer not between 60 and 1800 else true end;
      if v_bad then
        raise exception 'The payment window validity must be between 60 and 1800 seconds' using errcode = 'P0001';
      end if;
      v_valid := (p_payload->>'validitySeconds')::integer;
    end if;
    if p_payload ? 'shipping' and p_payload->>'shipping' !~ '^\d{1,9}(\.\d{1,2})?$' then raise exception 'Invalid shipping amount' using errcode = 'P0001'; end if;
    if p_payload ? 'total' and p_payload->>'total' !~ '^\d{1,9}(\.\d{1,2})?$' then raise exception 'Invalid total amount' using errcode = 'P0001'; end if;
    v_ship := case when p_payload ? 'shipping' then (p_payload->>'shipping')::numeric end;
    v_total := case when p_payload ? 'total' then (p_payload->>'total')::numeric end;
    if v_total is not null and v_total < v_req.subtotal then raise exception 'Total is below the products total' using errcode = 'P0001'; end if;
    update public.store_order_requests set status = 'store_confirmed', updated_at = now(),
      shipping_amount = coalesce(v_ship, shipping_amount), total_amount = coalesce(v_total, total_amount)
    where id = v_req.id;
    insert into public.payment_windows (request_id, store_id, url, expires_at)
    values (v_req.id, v_req.store_id, v_url, now() + make_interval(secs => v_valid))
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
-- 12. The payment window: opened by the customer, closed or returned from, expired by the clock
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.open_payment_window(p_request_id uuid, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_req public.store_order_requests; v_w public.payment_windows;
begin
  if p_user_id is null then raise exception 'Authentication required' using errcode = 'P0001'; end if;
  select * into v_req from public.store_order_requests where id = p_request_id and user_id = p_user_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0001'; end if;
  if v_req.status = 'cancelled' then return jsonb_build_object('state', 'cancelled', 'cancelReason', v_req.cancel_reason); end if;
  select * into v_w from public.payment_windows where request_id = v_req.id for update;
  if not found or v_req.status <> 'store_confirmed' or private.payment_executed(v_req.payment_status) then
    raise exception 'Order has no open payment window' using errcode = 'P0001';
  end if;
  if v_w.state in ('issued', 'opened') and v_w.expires_at <= now() then
    perform private.cancel_unpaid_order(v_req.id, 'payment_window_expired', null);
    return jsonb_build_object('state', 'cancelled', 'cancelReason', 'payment_window_expired');
  end if;
  if v_w.state = 'success_claimed' then return jsonb_build_object('state', 'success_claimed'); end if;
  if v_w.state = 'issued' then update public.payment_windows set state = 'opened', opened_at = now() where id = v_w.id; end if;
  return jsonb_build_object('state', 'opened', 'url', v_w.url, 'expiresAt', v_w.expires_at, 'trackingNumber', v_req.tracking_number);
end; $$;

create or replace function public.payment_window_return(p_request_id uuid, p_user_id uuid, p_outcome text)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_req public.store_order_requests; v_w public.payment_windows;
begin
  if p_user_id is null then raise exception 'Authentication required' using errcode = 'P0001'; end if;
  if p_outcome not in ('success', 'cancel', 'closed') then raise exception 'Invalid outcome' using errcode = 'P0001'; end if;
  select * into v_req from public.store_order_requests where id = p_request_id and user_id = p_user_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0001'; end if;
  if v_req.status = 'cancelled' then return jsonb_build_object('state', 'cancelled', 'cancelReason', v_req.cancel_reason); end if;
  select * into v_w from public.payment_windows where request_id = v_req.id for update;
  if not found then raise exception 'Order has no payment window' using errcode = 'P0001'; end if;
  if private.payment_executed(v_req.payment_status) then return jsonb_build_object('state', 'paid'); end if;
  if v_w.state in ('issued', 'opened') and v_w.expires_at <= now() then
    perform private.cancel_unpaid_order(v_req.id, 'payment_window_expired', null);
    return jsonb_build_object('state', 'cancelled', 'cancelReason', 'payment_window_expired');
  end if;
  if v_w.state = 'success_claimed' then return jsonb_build_object('state', 'success_claimed', 'ignored', true); end if;
  if p_outcome = 'success' then
    update public.payment_windows set state = 'success_claimed', returned_at = now() where id = v_w.id;
    return jsonb_build_object('state', 'success_claimed');
  end if;
  perform private.cancel_unpaid_order(v_req.id, case when p_outcome = 'cancel' then 'payment_window_cancelled' else 'payment_window_closed' end, null);
  return jsonb_build_object('state', 'cancelled', 'cancelReason', case when p_outcome = 'cancel' then 'payment_window_cancelled' else 'payment_window_closed' end);
end; $$;

create or replace function public.expire_payment_windows()
returns integer language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_w record; v_n integer := 0;
begin
  -- No lock here on purpose: the order row is always locked first (cancel_unpaid_order), as in every other path.
  for v_w in select w.request_id from public.payment_windows w where w.state in ('issued', 'opened') and w.expires_at <= now() order by w.expires_at limit 200 loop
    if private.cancel_unpaid_order(v_w.request_id, 'payment_window_expired', null) then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end; $$;

-- What the order page and «طلباتي» poll while an order is being sent or waits in the window (never the window address).
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
    'window', case when v_w.id is null then null else jsonb_build_object('state', v_w.state, 'expiresAt', v_w.expires_at) end);
end; $$;

-- 4. The expiry clause of the open-order lookup in place_store_order comes back
do $do$
declare
  v_def text := pg_get_functiondef('public.place_store_order(jsonb)'::regprocedure);
  v_anchor constant text := E'    and not private.payment_executed(q.payment_status)\n';
  v_clause constant text := E'    and not exists (select 1 from public.payment_windows w where w.request_id = q.id and w.state in (''issued'', ''opened'') and w.expires_at <= now())\n';
begin
  if position(v_clause in v_def) > 0 then return; end if;
  if position(v_anchor in v_def) = 0 then raise exception 'place_store_order does not hold the expected anchor'; end if;
  execute replace(v_def, v_anchor, v_anchor || v_clause);
end $do$;

-- 5. Grants: the server alone
revoke all on function public.merchant_review_order(uuid, jsonb), public.open_payment_window(uuid, uuid), public.payment_window_return(uuid, uuid, text),
  public.expire_payment_windows(), public.customer_order_state(uuid, uuid) from public, anon, authenticated;
grant execute on function public.merchant_review_order(uuid, jsonb), public.open_payment_window(uuid, uuid), public.payment_window_return(uuid, uuid, text),
  public.expire_payment_windows(), public.customer_order_state(uuid, uuid) to service_role;
