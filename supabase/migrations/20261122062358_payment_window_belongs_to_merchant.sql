-- The payment window belongs to the merchant (owner's ruling, 21 Nov 2026: docs/purchase-flow-final.ar.md step 6, docs/purchase-flow-correction-plan.ar.md stage 1).
--
-- Two different windows exist and only the first one is this migration's concern:
--   * the MERCHANT's payment window: opened by the merchant, offers all of its payment methods (including cash on delivery), has a close mark and a
--     cancel button, and the merchant is the only one who decides how long it stays open. Closing or cancelling it before a payment exists cancels
--     the purchase at once; the merchant (a platform notice), the platform dashboard and the customer ("طلباتي") are told; the customer comes back
--     to the platform with the full cart.
--   * the PROVIDER's payment window (the one with the OTP) opens by itself when an electronic method is chosen; only the provider controls its time,
--     and only the provider's own confirmation makes a payment (stage 2, not here).
-- Elan therefore sets no duration, no cap, no grace period, no expiry and no countdown for the merchant's window. What this migration removes:
--   * payment_windows.expires_at (and its 30-minute check), the clock that cancelled orders, and the validity / shipping / total the approval used
--     to carry: the merchant sets shipping and the final total inside its own window; the paid amount is confirmed by the neutral party (stage 2).
-- What it adds:
--   * merchant_window_closed: the merchant's signed report that ITS OWN window ended (its clock, or its own close mark): an unpaid order is cancelled,
--     a paid one or one whose customer returned with a success claim is left alone (a late confirmation may still arrive).
--   * alert_stale_payment_windows: a window that has stayed open for more than 24 hours without a payment tells the platform dashboard once. It never
--     cancels anything: the duration is the merchant's.
-- payment_windows was empty on the live database when this was written (no store is linked yet), so nothing is lost with the column.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The table: no Élan-side expiry
-- ---------------------------------------------------------------------------------------------------------------------
alter table public.payment_windows drop column if exists expires_at;
alter table public.payment_windows add column if not exists stale_alerted_at timestamptz;
comment on table public.payment_windows is 'The merchant''s own payment window for an approved order. Its duration belongs to the merchant alone: Elan keeps no expiry. state: issued, opened, success_claimed (only what the customer''s browser said on return: it proves nothing, a payment is proven by the neutral party''s confirmation), closed (the customer closed or cancelled it, or the order was cancelled), expired (the merchant reported its own window over).';
comment on column public.payment_windows.stale_alerted_at is 'When the platform dashboard was told that this window has stayed open for more than 24 hours without a payment (once; nothing is cancelled).';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Cancelling an unpaid order: who ended it decides the words everybody is shown
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.cancel_unpaid_order(p_request_id uuid, p_reason text, p_detail text default null)
returns boolean language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_req public.store_order_requests; v_body text; v_by_customer boolean;
begin
  if p_reason not in ('store_unresponsive', 'payment_window_cancelled', 'payment_window_closed', 'payment_window_expired', 'customer_requested_before_payment') then
    raise exception 'Unknown cancel reason' using errcode = 'P0001';
  end if;
  select * into v_req from public.store_order_requests where id = p_request_id for update;
  if not found or v_req.status not in ('awaiting_store_confirmation', 'store_confirmed') or private.payment_executed(v_req.payment_status) then
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
  v_by_customer := p_reason in ('payment_window_cancelled', 'payment_window_closed', 'customer_requested_before_payment');
  -- The words of the owner: closing or cancelling the merchant's window is the customer's own wish; the merchant ending its window is not.
  v_body := case
    when p_reason = 'store_unresponsive' then 'نعتذر عن تنفيذ طلبك في الوقت الحالي، برجاء إعادة المحاولة بعد ساعة.'
    when p_reason = 'payment_window_expired' then 'انتهت نافذة الدفع لدى المتجر قبل إتمام الدفع فأُلغي الطلب، ومنتجات الطلب ما زالت في سلة العميل.'
    else 'تم إلغاء المعاملة برغبة العميل، ومنتجات الطلب ما زالت في سلة العميل.' end;
  perform public.emit_order_notification((select r from public.store_order_requests r where r.id = v_req.id),
    'order_cancelled', 'أُلغي الطلب ' || v_req.tracking_number, v_body,
    jsonb_build_object('trackingNumber', v_req.tracking_number, 'cancelReason', p_reason, 'byCustomer', v_by_customer, 'paymentMade', false, 'detail', left(p_detail, 200)));
  return true;
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The merchant's approval: only the address of its payment window. Shipping, the final total, the methods and the time are the merchant's,
--    inside its window.
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
-- 4. The customer opens the merchant's window, and returns from it. No clock of ours is consulted.
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
  if v_w.state = 'success_claimed' then return jsonb_build_object('state', 'success_claimed'); end if;
  if v_w.state = 'issued' then update public.payment_windows set state = 'opened', opened_at = now() where id = v_w.id; end if;
  return jsonb_build_object('state', 'opened', 'url', v_w.url, 'trackingNumber', v_req.tracking_number);
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
  if v_w.state = 'success_claimed' then return jsonb_build_object('state', 'success_claimed', 'ignored', true); end if;
  if p_outcome = 'success' then
    update public.payment_windows set state = 'success_claimed', returned_at = now() where id = v_w.id;
    return jsonb_build_object('state', 'success_claimed');
  end if;
  perform private.cancel_unpaid_order(v_req.id, case when p_outcome = 'cancel' then 'payment_window_cancelled' else 'payment_window_closed' end, null);
  return jsonb_build_object('state', 'cancelled', 'cancelReason', case when p_outcome = 'cancel' then 'payment_window_cancelled' else 'payment_window_closed' end);
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The merchant reports that ITS OWN window ended (signed, through the Merchant Adapter)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.merchant_window_closed(p_store_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_tracking text := nullif(btrim(coalesce(p_payload->>'trackingNumber', '')), '');
  v_reason text := nullif(btrim(coalesce(p_payload->>'reason', '')), '');
  v_req public.store_order_requests; v_w public.payment_windows;
begin
  if p_store_id is null or v_tracking is null then raise exception 'Order not found' using errcode = 'P0001'; end if;
  if v_reason is not null and char_length(v_reason) > 200 then raise exception 'Reason is too long' using errcode = 'P0001'; end if;
  select * into v_req from public.store_order_requests where tracking_number = v_tracking and store_id = p_store_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0001'; end if;
  if v_req.status = 'cancelled' then
    return jsonb_build_object('trackingNumber', v_tracking, 'status', 'cancelled', 'cancelReason', v_req.cancel_reason, 'duplicate', true);
  end if;
  select * into v_w from public.payment_windows where request_id = v_req.id for update;
  if not found or v_req.status <> 'store_confirmed' then raise exception 'Order has no open payment window' using errcode = 'P0001'; end if;
  -- A payment is decided by the neutral party, never by this report; a customer who came back saying it worked may still be confirmed.
  if private.payment_executed(v_req.payment_status) or v_w.state = 'success_claimed' then
    return jsonb_build_object('trackingNumber', v_tracking, 'status', v_req.status, 'ignored', true);
  end if;
  perform private.cancel_unpaid_order(v_req.id, 'payment_window_expired', coalesce(v_reason, 'The store ended its payment window'));
  return jsonb_build_object('trackingNumber', v_tracking, 'status', 'cancelled', 'cancelReason', 'payment_window_expired', 'duplicate', false);
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. A window left open for more than 24 hours is told to the platform dashboard, once. Nothing is cancelled.
-- ---------------------------------------------------------------------------------------------------------------------
drop function if exists public.expire_payment_windows();
create or replace function public.alert_stale_payment_windows()
returns integer language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_w record; v_req public.store_order_requests; v_n integer := 0;
begin
  for v_w in
    select w.id, w.request_id from public.payment_windows w join public.store_order_requests r on r.id = w.request_id
    where w.state in ('issued', 'opened', 'success_claimed') and w.stale_alerted_at is null and w.issued_at <= now() - interval '24 hours'
      and r.status = 'store_confirmed' and not private.payment_executed(r.payment_status)
    order by w.issued_at limit 200
  loop
    -- The order row is locked first, as in every other path.
    select * into v_req from public.store_order_requests where id = v_w.request_id for update;
    if v_req.status = 'store_confirmed' and not private.payment_executed(v_req.payment_status) then
      insert into public.notifications (user_id, recipient_role, checkout_session_id, request_id, store_id, tracking_number, type, title, body, payload)
      values (null, 'platform_admin', v_req.checkout_session_id, v_req.id, v_req.store_id, v_req.tracking_number, 'payment_window_stale',
              'نافذة دفع مفتوحة منذ أكثر من 24 ساعة: ' || v_req.tracking_number,
              'ما زالت نافذة الدفع لدى المتجر مفتوحة بلا دفع بعد أكثر من 24 ساعة. لم يُلغَ الطلب لأن مدة النافذة بيد المتجر، والمطلوب مراجعة المتجر.',
              jsonb_build_object('trackingNumber', v_req.tracking_number, 'hours', 24));
      update public.payment_windows set stale_alerted_at = now() where id = v_w.id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. What the order page and «طلباتي» poll: no expiry any more, and never the window address
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
    'window', case when v_w.id is null then null else jsonb_build_object('state', v_w.state) end);
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. An open order of the same lines is the same order whatever the age of its window (the clause that read the expiry is gone).
--    The current text of the function is read and rewritten here so nothing else in it can drift from what is live.
-- ---------------------------------------------------------------------------------------------------------------------
do $do$
declare
  v_def text := pg_get_functiondef('public.place_store_order(jsonb)'::regprocedure);
  v_clause constant text := E'    and not exists (select 1 from public.payment_windows w where w.request_id = q.id and w.state in (''issued'', ''opened'') and w.expires_at <= now())\n';
begin
  if position(v_clause in v_def) = 0 then raise exception 'place_store_order does not hold the expected expiry clause'; end if;
  v_def := replace(v_def, v_clause, '');
  if position('w.expires_at' in v_def) > 0 then raise exception 'place_store_order still reads a payment window expiry'; end if;
  execute v_def;
end $do$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Grants: the server alone
-- ---------------------------------------------------------------------------------------------------------------------
revoke all on function public.merchant_window_closed(uuid, jsonb), public.alert_stale_payment_windows() from public, anon, authenticated;
grant execute on function public.merchant_window_closed(uuid, jsonb), public.alert_stale_payment_windows() to service_role;
