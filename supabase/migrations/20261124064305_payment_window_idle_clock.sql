-- The idle time of the merchant's payment window (owner's ruling 22-23 Nov 2026, after the first version of "the window belongs to the merchant" kept no clock at all):
--   * Inside the merchant's window the merchant (or the provider) holds every real clock. Élan keeps ONE rule, for a customer who stops moving:
--     the merchant may give its idle time in the reply that opens the window (idleSeconds, 60 to 86400); none given = 30 minutes.
--   * The idle time is counted from the customer's LAST interaction in the window, and from the opening when there has been none. Every interaction
--     the merchant reports (merchant_window_interaction, event activity) starts it again: a customer who tried several methods for five minutes and then
--     stopped has the whole idle time from the moment of stopping, not from the opening. It is not a single chance.
--   * The clock stops for good when the customer leaves the merchant's window for the provider's (the merchant reports it: event provider_window) or comes
--     back with "success". From then on the time is the provider's alone.
--   * Closing the window (merchant's report, or the customer's) cancels at once, as before; a closed browser or a lost connection reaches us the same way
--     (the merchant's report) or, failing that, by the idle time. A store that reports nothing gets the plain idle time from the opening.
--   * The old 24 hours alert covered no real case, so it is narrowed to the one that remains: the customer went on to the provider's window and 24 hours
--     later nothing at all came back (no success, no failure). The platform dashboard is told once; nothing is cancelled, because a payment may be in progress.
--   * An ended window (the idle time ran out, or the store reported that its own window ended) is a customer who did not go on, exactly like closing it:
--     the owner wants it recorded and told in the same words, «تم إلغاء المعاملة برغبة العميل», to the customer, the platform dashboard and the store.
--     cancel_reason and the detail keep the real cause for the administration. Only a store that did not answer keeps its own apology.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------------------------------
alter table public.payment_windows add column if not exists idle_seconds integer not null default 1800;
alter table public.payment_windows drop constraint if exists payment_windows_idle_seconds_check;
alter table public.payment_windows add constraint payment_windows_idle_seconds_check check (idle_seconds between 60 and 86400);
alter table public.payment_windows add column if not exists idle_deadline_at timestamptz;
alter table public.payment_windows add column if not exists interacted_at timestamptz;
alter table public.payment_windows add column if not exists clock_stopped_at timestamptz;
comment on column public.payment_windows.idle_seconds is 'Seconds without any interaction of the customer after which the window is closed and the purchase cancelled: the merchant''s idleSeconds in its reply, else 1800.';
comment on column public.payment_windows.idle_deadline_at is 'When the idle time runs out: the last interaction (or the opening) plus idle_seconds. Null once the clock is stopped for good (the customer went on to the provider''s window, or came back with success) or the window is over.';
comment on column public.payment_windows.interacted_at is 'The last interaction of the customer in the merchant''s window, as the merchant reported it. Every one starts the idle time again.';
comment on column public.payment_windows.clock_stopped_at is 'When the customer left the merchant''s window for the provider''s (reported by the merchant) or came back with success. From then on Elan keeps no idle clock.';
comment on column public.payment_windows.stale_alerted_at is 'When the platform dashboard was told that the customer went on to the provider more than 24 hours ago and nothing came back (once; nothing is cancelled).';
comment on table public.payment_windows is 'The merchant''s own payment window for an approved order. Its real clocks belong to the merchant and the provider; Elan only closes a window whose customer stopped moving for idle_seconds. state: issued, opened, success_claimed (only what the browser said on return, it proves nothing), closed, expired. A payment is proven by a neutral confirmation (stage 2).';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Cancelling an unpaid order: every way a window ends is the customer not going on, in the customer's words
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
  -- The words of the owner (22-23 Nov 2026): closing or cancelling the merchant's window, a browser or a connection that went away, and a window whose
  -- customer stopped moving for its idle time are all the customer not going on with the purchase; only a store that did not answer is not.
  v_by_customer := p_reason <> 'store_unresponsive';
  v_body := case
    when p_reason = 'store_unresponsive' then 'نعتذر عن تنفيذ طلبك في الوقت الحالي، برجاء إعادة المحاولة بعد ساعة.'
    else 'تم إلغاء المعاملة برغبة العميل، ومنتجات الطلب ما زالت في سلة العميل.' end;
  perform public.emit_order_notification((select r from public.store_order_requests r where r.id = v_req.id),
    'order_cancelled', 'أُلغي الطلب ' || v_req.tracking_number, v_body,
    jsonb_build_object('trackingNumber', v_req.tracking_number, 'cancelReason', p_reason, 'byCustomer', v_by_customer, 'paymentMade', false, 'detail', left(p_detail, 200)));
  return true;
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2b. The merchant's approval carries its idle time; opening the window starts it; the customer's own "success" return stops it
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.merchant_review_order(p_store_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_tracking text := nullif(btrim(coalesce(p_payload->>'trackingNumber', '')), '');
  v_decision text := lower(coalesce(p_payload->>'decision', ''));
  v_reason text := nullif(btrim(coalesce(p_payload->>'reason', '')), '');
  v_req public.store_order_requests;
  v_url text;
  v_idle integer := 1800;
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
    -- The only time the reply may carry is the idle time of its window (seconds without any interaction of the customer before the window closes
    -- and the purchase is cancelled); none given = 30 minutes. Shipping, the total and the methods belong to the merchant's window and are not read.
    if jsonb_typeof(p_payload->'idleSeconds') is not null and jsonb_typeof(p_payload->'idleSeconds') <> 'null' then
      if jsonb_typeof(p_payload->'idleSeconds') <> 'number' or (p_payload->>'idleSeconds') !~ '^[0-9]{2,5}$'
         or (p_payload->>'idleSeconds')::integer not between 60 and 86400 then
        raise exception 'idleSeconds must be a whole number of seconds between 60 and 86400' using errcode = 'P0001';
      end if;
      v_idle := (p_payload->>'idleSeconds')::integer;
    end if;
    update public.store_order_requests set status = 'store_confirmed', updated_at = now() where id = v_req.id;
    insert into public.payment_windows (request_id, store_id, url, idle_seconds, idle_deadline_at)
    values (v_req.id, v_req.store_id, v_url, v_idle, now() + make_interval(secs => v_idle))
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
  -- A window whose customer stopped moving for its whole idle time is over, whether or not the sweep has reached it yet.
  if v_w.idle_deadline_at is not null and v_w.idle_deadline_at <= now() then
    perform private.cancel_unpaid_order(v_req.id, 'payment_window_expired', 'No customer interaction for ' || v_w.idle_seconds || ' seconds');
    return jsonb_build_object('state', 'cancelled', 'cancelReason', 'payment_window_expired');
  end if;
  -- Opening it is the start of the merchant's window: the idle time runs from here until the merchant reports an interaction (or the customer has
  -- gone on to the provider, when there is no clock any more).
  update public.payment_windows set state = 'opened', opened_at = coalesce(opened_at, now()),
         idle_deadline_at = case when clock_stopped_at is null then now() + make_interval(secs => idle_seconds) end
   where id = v_w.id;
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
    update public.payment_windows set state = 'success_claimed', returned_at = now(), idle_deadline_at = null,
           interacted_at = coalesce(interacted_at, now()), clock_stopped_at = coalesce(clock_stopped_at, now()) where id = v_w.id;
    return jsonb_build_object('state', 'success_claimed');
  end if;
  perform private.cancel_unpaid_order(v_req.id, case when p_outcome = 'cancel' then 'payment_window_cancelled' else 'payment_window_closed' end, null);
  return jsonb_build_object('state', 'cancelled', 'cancelReason', case when p_outcome = 'cancel' then 'payment_window_cancelled' else 'payment_window_closed' end);
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The merchant says what the customer does in its window: an interaction starts the idle time again; the move to the provider stops it for good
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.merchant_window_interaction(p_store_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_tracking text := nullif(btrim(coalesce(p_payload->>'trackingNumber', '')), '');
  v_kind text := lower(coalesce(nullif(btrim(coalesce(p_payload->>'event', '')), ''), 'activity'));
  v_req public.store_order_requests; v_w public.payment_windows;
begin
  if p_store_id is null or v_tracking is null then raise exception 'Order not found' using errcode = 'P0001'; end if;
  if v_kind not in ('activity', 'provider_window') then raise exception 'event must be activity or provider_window' using errcode = 'P0001'; end if;
  select * into v_req from public.store_order_requests where tracking_number = v_tracking and store_id = p_store_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0001'; end if;
  if v_req.status = 'cancelled' then
    return jsonb_build_object('trackingNumber', v_tracking, 'status', 'cancelled', 'cancelReason', v_req.cancel_reason, 'ignored', true);
  end if;
  select * into v_w from public.payment_windows where request_id = v_req.id for update;
  if not found or v_req.status <> 'store_confirmed' then raise exception 'Order has no open payment window' using errcode = 'P0001'; end if;
  if private.payment_executed(v_req.payment_status) then
    return jsonb_build_object('trackingNumber', v_tracking, 'status', v_req.status, 'ignored', true);
  end if;
  -- Once the customer has gone on to the provider there is no clock to move: a later report changes nothing.
  if v_w.clock_stopped_at is not null then
    return jsonb_build_object('trackingNumber', v_tracking, 'status', v_req.status, 'clockStopped', true, 'duplicate', true);
  end if;
  -- A report after the idle time ran out is too late: the window was over.
  if v_w.idle_deadline_at is not null and v_w.idle_deadline_at <= now() and v_w.state in ('issued', 'opened') then
    perform private.cancel_unpaid_order(v_req.id, 'payment_window_expired', 'No customer interaction for ' || v_w.idle_seconds || ' seconds');
    return jsonb_build_object('trackingNumber', v_tracking, 'status', 'cancelled', 'cancelReason', 'payment_window_expired', 'ignored', true);
  end if;
  if v_kind = 'activity' then
    update public.payment_windows set interacted_at = now(), idle_deadline_at = now() + make_interval(secs => idle_seconds) where id = v_w.id;
    return jsonb_build_object('trackingNumber', v_tracking, 'status', v_req.status, 'clockStopped', false, 'idleSeconds', v_w.idle_seconds, 'duplicate', false);
  end if;
  update public.payment_windows set interacted_at = coalesce(interacted_at, now()), idle_deadline_at = null, clock_stopped_at = now() where id = v_w.id;
  return jsonb_build_object('trackingNumber', v_tracking, 'status', v_req.status, 'clockStopped', true, 'duplicate', false);
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The sweep (the Worker's cron, every minute): a window whose customer stopped moving for its idle time is closed
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.close_idle_payment_windows()
returns integer language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_w record; v_req public.store_order_requests; v_n integer := 0;
begin
  for v_w in
    select w.id, w.request_id, w.idle_seconds from public.payment_windows w join public.store_order_requests r on r.id = w.request_id
    where w.state in ('issued', 'opened') and w.idle_deadline_at <= now() and r.status = 'store_confirmed' and not private.payment_executed(r.payment_status)
    order by w.idle_deadline_at limit 200
  loop
    -- The order row is locked first, as in every other path; the window is read again under the lock.
    select * into v_req from public.store_order_requests where id = v_w.request_id for update;
    if v_req.status = 'store_confirmed' and not private.payment_executed(v_req.payment_status)
       and exists (select 1 from public.payment_windows w2 where w2.id = v_w.id and w2.state in ('issued', 'opened') and w2.idle_deadline_at <= now()) then
      if private.cancel_unpaid_order(v_req.id, 'payment_window_expired', 'No customer interaction for ' || v_w.idle_seconds || ' seconds') then
        v_n := v_n + 1;
      end if;
    end if;
  end loop;
  return v_n;
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The alert: only for a customer who went on to the provider and then nothing came back for 24 hours
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.alert_stale_payment_windows()
returns integer language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_w record; v_req public.store_order_requests; v_n integer := 0;
begin
  for v_w in
    select w.id, w.request_id from public.payment_windows w join public.store_order_requests r on r.id = w.request_id
    where w.state in ('issued', 'opened', 'success_claimed') and w.stale_alerted_at is null
      and w.clock_stopped_at is not null and w.clock_stopped_at <= now() - interval '24 hours'
      and r.status = 'store_confirmed' and not private.payment_executed(r.payment_status)
    order by w.clock_stopped_at limit 200
  loop
    select * into v_req from public.store_order_requests where id = v_w.request_id for update;
    if v_req.status = 'store_confirmed' and not private.payment_executed(v_req.payment_status) then
      insert into public.notifications (user_id, recipient_role, checkout_session_id, request_id, store_id, tracking_number, type, title, body, payload)
      values (null, 'platform_admin', v_req.checkout_session_id, v_req.id, v_req.store_id, v_req.tracking_number, 'payment_window_stale',
              'لا نتيجة للدفع منذ أكثر من 24 ساعة: ' || v_req.tracking_number,
              'انتقل العميل من نافذة المتجر إلى نافذة الدفع ثم لم يصلنا من المزود ولا من المتجر نجاح ولا فشل منذ أكثر من 24 ساعة. لم يُلغَ الطلب لأن دفعة قد تكون جارية، والمطلوب مراجعة المزود والمتجر.',
              jsonb_build_object('trackingNumber', v_req.tracking_number, 'hours', 24));
      update public.payment_windows set stale_alerted_at = now() where id = v_w.id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The open-order lookup in place_store_order ignores an order whose window ran out its idle time (the sweep has not reached it yet)
-- ---------------------------------------------------------------------------------------------------------------------
do $do$
declare
  v_def text := pg_get_functiondef('public.place_store_order(jsonb)'::regprocedure);
  v_anchor constant text := E'    and not private.payment_executed(q.payment_status)\n';
  v_clause constant text := E'    and not exists (select 1 from public.payment_windows w where w.request_id = q.id and w.state in (''issued'', ''opened'') and w.idle_deadline_at <= now())\n';
begin
  if position(v_clause in v_def) > 0 then return; end if;
  if position(v_anchor in v_def) = 0 then raise exception 'place_store_order does not hold the expected anchor'; end if;
  execute replace(v_def, v_anchor, v_anchor || v_clause);
end $do$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Grants: the server alone
-- ---------------------------------------------------------------------------------------------------------------------
revoke all on function public.merchant_window_interaction(uuid, jsonb), public.close_idle_payment_windows(), public.alert_stale_payment_windows(),
  public.merchant_review_order(uuid, jsonb), public.open_payment_window(uuid, uuid), public.payment_window_return(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.merchant_window_interaction(uuid, jsonb), public.close_idle_payment_windows(), public.alert_stale_payment_windows(),
  public.merchant_review_order(uuid, jsonb), public.open_payment_window(uuid, uuid), public.payment_window_return(uuid, uuid, text) to service_role;
