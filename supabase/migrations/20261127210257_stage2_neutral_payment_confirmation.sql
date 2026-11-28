-- Stage 2 (core) of docs/purchase-flow-correction-plan.ar.md, as the owner clarified it on 26 Nov 2026
-- (docs/merchant-linking-requirements.ar.md): payment providers, financiers and carriers are contracted with the MERCHANT only. Élan holds no contract and
-- no secret of its own at any of them. A payment is confirmed by a notice that leaves the PROVIDER's system for Élan's address (the merchant set that
-- address in its own provider account and gave Élan the key that verifies the provider's seal). The notice is evidence that is matched, not a proof:
-- the key is the merchant's too. What follows from it:
--   * public.store_payment_channels: one row per (store, provider) with the verification key the merchant gave. Server-only. A channel starts as
--     'pending_test' and moves to 'verified' only after a REAL signed notice from that provider's account has arrived and been logged: no money is ever
--     applied from a channel that has not proved itself on real traffic.
--   * public.payment_channel_log: every notice that passed its signature check (test, unmatched reference, applied...). Never lost.
--   * public.record_payment_event (same signature, now called only through a verified channel): records what the provider confirmed AS IT IS (amount,
--     currency, method, provider, transaction) and refuses no real money; comparing it with the products and with the merchant's own second notice is the
--     matching of stage 3. A payment that cannot be applied (the order was cancelled, was never approved, was already paid or cash on delivery, another
--     currency) opens a DISCREPANCY for the platform admin instead of being dropped; the order does not come back.
--   * public.record_cod_selection (new): the cash-on-delivery choice, reported signed by the merchant (the one who sees the customer press OK with no
--     provider window opened). It is a choice, not money: the collection is confirmed by the carrier at delivery.
--   * public.order_discrepancies: the cases the platform could not match, one per source event, never deleted (closing rules: stage 3).
--   * private.guard_payment_fields: the approved amount may change exactly once, from the payment functions, while the order is still unpaid.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The channels, their log and the discrepancies
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists public.store_payment_channels (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,39}$'),
  verification_key text not null check (char_length(verification_key) between 8 and 4096),
  status text not null default 'pending_test' check (status in ('pending_test', 'verified', 'disabled')),
  verified_at timestamptz,
  last_event_at timestamptz,
  notes text not null default '' check (char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, provider)
);
comment on table public.store_payment_channels is 'The merchant''s own payment provider (or financier) as it notifies Élan: the key the merchant gave to verify the provider''s seal. Not a contract of Élan with the provider. Server-only; a channel applies money only once verified by a real signed notice.';

create table if not exists public.payment_channel_log (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.store_payment_channels(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  provider text not null,
  event_id text not null check (char_length(event_id) between 1 and 300),
  event_type text not null,
  tracking_number text,
  amount numeric,
  currency text,
  outcome text not null check (outcome in ('test_received', 'unmatched_reference', 'unsupported_kind', 'applied', 'failed_recorded', 'duplicate_payment',
                                           'state_rejected', 'late_after_cancel', 'amount_mismatch', 'currency_mismatch')),
  received_at timestamptz not null default now(),
  unique (channel_id, event_id)
);
create index if not exists payment_channel_log_channel_idx on public.payment_channel_log(channel_id, received_at desc);
comment on table public.payment_channel_log is 'Every notice from a merchant''s payment channel that passed its signature check, with what Élan did with it. Server-only.';

create table if not exists public.order_discrepancies (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.store_order_requests(id),
  store_id uuid not null references public.stores(id),
  kind text not null check (kind in ('payment_after_cancel', 'payment_without_approval', 'payment_after_cod', 'cod_after_payment', 'cod_after_cancel',
                                     'double_payment', 'payment_currency')),
  status text not null default 'open' check (status in ('open', 'closed')),
  source_ref text not null unique check (char_length(source_ref) between 1 and 300),
  detail jsonb not null default '{}'::jsonb,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closure jsonb
);
create index if not exists order_discrepancies_open_idx on public.order_discrepancies(opened_at desc) where status = 'open';
create index if not exists order_discrepancies_request_idx on public.order_discrepancies(request_id);
comment on table public.order_discrepancies is 'Cases the platform could not match (a payment after the order was cancelled, a second payment...). One case per source event. Never deleted; closing needs the evidence rules of stage 3.';
create or replace trigger order_discrepancies_no_delete before delete on public.order_discrepancies
  for each row execute function private.forbid_change();

alter table public.store_payment_channels enable row level security;
alter table public.payment_channel_log enable row level security;
alter table public.order_discrepancies enable row level security;
revoke all on public.store_payment_channels, public.payment_channel_log, public.order_discrepancies from anon, authenticated;
grant all on public.store_payment_channels, public.payment_channel_log, public.order_discrepancies to service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. What the order and the event log now carry
-- ---------------------------------------------------------------------------------------------------------------------
alter table public.store_order_requests
  add column if not exists payment_failure_reason text check (payment_failure_reason is null or char_length(payment_failure_reason) <= 500),
  add column if not exists payment_failed_at timestamptz;
comment on column public.store_order_requests.payment_failure_reason is 'The payment provider''s own words for its last refused payment (shown to the customer in «طلباتي»); cleared when a payment is confirmed. Written only by the payment functions.';

alter table public.order_payment_events add column if not exists reason text check (reason is null or char_length(reason) <= 500);
alter table public.order_payment_events drop constraint if exists order_payment_events_event_type_check;
alter table public.order_payment_events drop constraint if exists order_payment_events_outcome_check;
alter table public.order_payment_events
  add constraint order_payment_events_event_type_check check (event_type in ('payment.succeeded', 'payment.failed', 'cod.selected')),
  add constraint order_payment_events_outcome_check check (outcome in ('applied', 'failed_recorded', 'duplicate_payment', 'amount_mismatch', 'currency_mismatch',
                                                                       'state_rejected', 'late_after_cancel', 'cod_recorded'));

-- The payment fields are written only by the payment functions. The approved amount may change exactly once, by them, while the order is unpaid.
create or replace function private.guard_payment_fields()
returns trigger language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
begin
  if (new.payment_status, new.payment_method, new.payment_provider, new.payment_reference, new.paid_at, new.cart_cleared_at, new.sale_proven_at,
      new.payment_failure_reason, new.payment_failed_at)
       is distinct from (old.payment_status, old.payment_method, old.payment_provider, old.payment_reference, old.paid_at, old.cart_cleared_at, old.sale_proven_at,
      old.payment_failure_reason, old.payment_failed_at)
     and coalesce(current_setting('elan.pay_write', true), '') <> 'on' then
    raise exception 'Payment fields are written only by the payment functions' using errcode = 'P0001';
  end if;
  if old.approved_at is not null and (new.approved_at is distinct from old.approved_at or new.payment_options is distinct from old.payment_options
       or (new.payable_amount is distinct from old.payable_amount
           and (coalesce(current_setting('elan.terms_write', true), '') <> 'on' or old.payment_status not in ('not_started', 'failed')))) then
    raise exception 'The approved payment terms are fixed' using errcode = 'P0001';
  end if;
  if new.status in ('processing', 'shipped', 'delivered') and new.status is distinct from old.status and not private.payment_executed(new.payment_status) then
    raise exception 'Payment is required before processing or shipping' using errcode = 'P0001';
  end if;
  return new;
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Telling the platform admin (only): a discrepancy or an unmatched notice is not for the customer or the store
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.notify_platform_admin(p_type text, p_title text, p_body text, p_payload jsonb, p_request_id uuid default null, p_store_id uuid default null)
returns void language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_session uuid; v_tracking text; v_store uuid := p_store_id;
begin
  if p_request_id is not null then
    select r.checkout_session_id, r.tracking_number, coalesce(p_store_id, r.store_id) into v_session, v_tracking, v_store
      from public.store_order_requests r where r.id = p_request_id;
  end if;
  insert into public.notifications (user_id, recipient_role, checkout_session_id, request_id, store_id, tracking_number, type, title, body, payload)
  values (null, 'platform_admin', v_session, p_request_id, v_store, v_tracking, p_type, p_title, p_body, coalesce(p_payload, '{}'::jsonb));
end; $$;

create or replace function private.open_discrepancy(p_request_id uuid, p_kind text, p_source text, p_detail jsonb)
returns uuid language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_req public.store_order_requests; v_id uuid; v_what text;
begin
  select * into v_req from public.store_order_requests where id = p_request_id;
  if not found then return null; end if;
  insert into public.order_discrepancies (request_id, store_id, kind, source_ref, detail)
  values (v_req.id, v_req.store_id, p_kind, p_source, coalesce(p_detail, '{}'::jsonb))
  on conflict (source_ref) do nothing returning id into v_id;
  if v_id is null then return null; end if;
  v_what := case p_kind
    when 'payment_after_cancel' then 'وصل تأكيد دفع من قناة المتجر بعد أن أُلغي الطلب'
    when 'payment_without_approval' then 'وصل تأكيد دفع لطلب لم يوافق عليه المتجر'
    when 'payment_after_cod' then 'وصل تأكيد دفع إلكتروني لطلب اختار عميله الدفع عند الاستلام'
    when 'cod_after_payment' then 'أبلغ المتجر باختيار الدفع عند الاستلام لطلب مدفوع إلكترونيًا'
    when 'cod_after_cancel' then 'أبلغ المتجر باختيار الدفع عند الاستلام لطلب أُلغي'
    when 'payment_currency' then 'وصل تأكيد دفع بعملة غير الجنيه المصري'
    else 'وصل تأكيد دفع ثانٍ لطلب مدفوع' end;
  perform private.notify_platform_admin('order_discrepancy', 'حالة اختلاف جديدة: ' || v_req.tracking_number,
    v_what || '. الطلب لم يتغيّر، والحالة مفتوحة حتى تُغلق بدليل.',
    jsonb_build_object('trackingNumber', v_req.tracking_number, 'kind', p_kind, 'discrepancyId', v_id), v_req.id, v_req.store_id);
  return v_id;
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. What a provider confirmed, recorded as it is
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.record_payment_event(p_store_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_tracking text := nullif(btrim(coalesce(p_payload->>'trackingNumber', '')), '');
  v_event text := nullif(btrim(coalesce(p_payload->>'eventId', '')), '');
  v_type text := lower(coalesce(p_payload->>'eventType', ''));
  v_txn text := nullif(btrim(coalesce(p_payload->>'providerTransactionId', '')), '');
  v_ref text := nullif(btrim(coalesce(p_payload->>'paymentReference', '')), '');
  v_provider text := nullif(btrim(coalesce(p_payload->>'provider', '')), '');
  v_cur text := upper(coalesce(nullif(btrim(coalesce(p_payload->>'currency', '')), ''), 'EGP'));
  v_method text := case when lower(coalesce(p_payload->>'paymentMethod', 'other')) = 'card' then 'card' else 'other' end;
  v_reason text := nullif(btrim(regexp_replace(coalesce(p_payload->>'reason', ''), '[[:cntrl:]]', ' ', 'g')), '');
  v_amount numeric; v_at timestamptz;
  v_req public.store_order_requests; v_pay public.order_payments; v_outcome text; v_idem text; v_applied boolean := false; v_case text;
begin
  if p_store_id is null or v_tracking is null then raise exception 'Order not found' using errcode = 'P0001'; end if;
  if v_provider is null or not exists (select 1 from public.store_payment_channels c where c.store_id = p_store_id and c.provider = v_provider and c.status = 'verified') then
    raise exception 'Payment channel is not verified' using errcode = 'P0001';
  end if;
  select * into v_req from public.store_order_requests where tracking_number = v_tracking and store_id = p_store_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0001'; end if;
  if v_event is null or char_length(v_event) > 200 then raise exception 'Invalid event id' using errcode = 'P0001'; end if;
  if v_type not in ('payment.succeeded', 'payment.failed') then raise exception 'Invalid event type' using errcode = 'P0001'; end if;
  if v_type = 'payment.succeeded' and (v_txn is null or char_length(v_txn) > 160) then raise exception 'A provider transaction id is required' using errcode = 'P0001'; end if;
  if v_ref is not null and char_length(v_ref) > 160 then raise exception 'Invalid payment reference' using errcode = 'P0001'; end if;
  if nullif(p_payload->>'amount', '') is not null then
    if p_payload->>'amount' !~ '^\d{1,9}(\.\d{1,2})?$' then raise exception 'Invalid amount' using errcode = 'P0001'; end if;
    v_amount := (p_payload->>'amount')::numeric;
    if v_amount <= 0 then raise exception 'Invalid amount' using errcode = 'P0001'; end if;
  end if;
  if v_type = 'payment.succeeded' and v_amount is null then raise exception 'Invalid amount' using errcode = 'P0001'; end if;
  begin v_at := nullif(p_payload->>'occurredAt', '')::timestamptz; exception when others then raise exception 'Invalid time' using errcode = 'P0001'; end;
  v_idem := p_store_id::text || ':' || v_event;
  if exists (select 1 from public.order_payment_events where idempotency_key = v_idem) then
    return jsonb_build_object('trackingNumber', v_tracking, 'paymentStatus', v_req.payment_status, 'duplicate', true, 'applied', false);
  end if;

  if v_type = 'payment.failed' then
    -- The provider refused: its words go to the customer's «طلباتي»; the order stays open (the customer may try another method in the merchant's window).
    v_outcome := 'failed_recorded';
    if v_req.status = 'store_confirmed' and not private.payment_executed(v_req.payment_status) then
      perform set_config('elan.pay_write', 'on', true);
      update public.store_order_requests set payment_failure_reason = coalesce(left(v_reason, 500), 'لم يذكر مزود الدفع سببًا'), payment_failed_at = now(), updated_at = now()
        where id = v_req.id;
      perform set_config('elan.pay_write', 'off', true);
    end if;
  elsif exists (select 1 from public.order_payments p where p.provider = v_provider and p.provider_transaction_id = v_txn) then
    v_outcome := 'duplicate_payment';                                   -- the same payment told again under another event id: nothing to do, nothing to open
  elsif v_req.status in ('cancelled', 'store_cancelled') then
    v_outcome := 'late_after_cancel'; v_case := 'payment_after_cancel';  -- money arrived for an order that no longer stands: the order does NOT come back
  elsif v_req.approved_at is null or v_req.status in ('awaiting_store_confirmation', 'store_rejected') then
    v_outcome := 'state_rejected'; v_case := 'payment_without_approval';
  elsif v_req.payment_status = 'cod_selected' then
    v_outcome := 'state_rejected'; v_case := 'payment_after_cod';
  elsif v_req.payment_status = 'paid' then
    v_outcome := 'duplicate_payment'; v_case := 'double_payment';       -- a second, different payment for an order already paid
  elsif v_cur <> 'EGP' then
    v_outcome := 'currency_mismatch'; v_case := 'payment_currency';
  else
    -- Confirmed by the provider's own notice. It is recorded as it is: the amount may be more than the products (the merchant's shipping) or even less; the
    -- comparison with the products and with the merchant's second notice is the matching of stage 3, which opens a discrepancy for any difference.
    insert into public.order_payments (request_id, store_id, user_id, method_kind, mode, provider, status, amount, currency, idempotency_key)
    values (v_req.id, v_req.store_id, v_req.user_id, v_method, 'hosted', v_provider, 'initiated', v_amount, 'EGP', 'event:' || v_idem)
    returning * into v_pay;
    update public.order_payments set status = 'paid', provider_transaction_id = v_txn, payment_reference = coalesce(v_ref, v_txn),
           paid_at = coalesce(v_at, now()), updated_at = now() where id = v_pay.id returning * into v_pay;
    perform set_config('elan.pay_write', 'on', true);
    perform set_config('elan.terms_write', 'on', true);
    update public.store_order_requests set payment_status = 'paid', payment_method = v_method, payment_provider = v_provider,
           payment_reference = v_pay.payment_reference, paid_at = v_pay.paid_at, payable_amount = v_amount, total_amount = v_amount,
           payment_failure_reason = null, payment_failed_at = null, updated_at = now() where id = v_req.id;
    perform set_config('elan.terms_write', 'off', true);
    perform set_config('elan.pay_write', 'off', true);
    perform private.finalize_payment(v_req.id);
    v_outcome := 'applied'; v_applied := true;
  end if;

  insert into public.order_payment_events (request_id, payment_id, store_id, provider, event_id, event_type, provider_transaction_id, payment_reference,
                                           amount, currency, occurred_at, idempotency_key, payload_hash, outcome, reason)
  values (v_req.id, v_pay.id, p_store_id, v_provider, v_event, v_type, v_txn, v_ref, v_amount, v_cur, v_at, v_idem,
          encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex'), v_outcome, left(v_reason, 500));
  if v_case is not null then
    perform private.open_discrepancy(v_req.id, v_case, 'payment-event:' || v_idem,
      jsonb_build_object('eventId', v_event, 'provider', v_provider, 'providerTransactionId', v_txn, 'amount', v_amount, 'currency', v_cur,
                         'outcome', v_outcome, 'orderStatus', v_req.status, 'paymentStatus', v_req.payment_status, 'subtotal', v_req.subtotal));
  end if;
  return jsonb_build_object('trackingNumber', v_tracking, 'paymentStatus', (select r.payment_status from public.store_order_requests r where r.id = v_req.id),
                            'duplicate', false, 'applied', v_applied, 'outcome', v_outcome);
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Cash on delivery: the merchant tells that the customer pressed OK in its window with no provider window opened
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.record_cod_selection(p_store_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_tracking text := nullif(btrim(coalesce(p_payload->>'trackingNumber', '')), '');
  v_event text := nullif(btrim(coalesce(p_payload->>'eventId', '')), '');
  v_total numeric; v_at timestamptz; v_idem text;
  v_req public.store_order_requests; v_pay public.order_payments; v_outcome text; v_applied boolean := false; v_case text;
begin
  if p_store_id is null or v_tracking is null then raise exception 'Order not found' using errcode = 'P0001'; end if;
  select * into v_req from public.store_order_requests where tracking_number = v_tracking and store_id = p_store_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0001'; end if;
  if v_event is null or char_length(v_event) > 200 then raise exception 'Invalid event id' using errcode = 'P0001'; end if;
  if nullif(p_payload->>'total', '') is not null then
    if p_payload->>'total' !~ '^\d{1,9}(\.\d{1,2})?$' then raise exception 'Invalid total amount' using errcode = 'P0001'; end if;
    v_total := (p_payload->>'total')::numeric;
    if v_total <= 0 then raise exception 'Invalid total amount' using errcode = 'P0001'; end if;
  end if;
  if upper(coalesce(nullif(btrim(coalesce(p_payload->>'currency', '')), ''), 'EGP')) <> 'EGP' then raise exception 'Invalid total amount' using errcode = 'P0001'; end if;
  begin v_at := nullif(p_payload->>'occurredAt', '')::timestamptz; exception when others then raise exception 'Invalid time' using errcode = 'P0001'; end;
  v_idem := p_store_id::text || ':' || v_event;
  if exists (select 1 from public.order_payment_events where idempotency_key = v_idem) then
    return jsonb_build_object('trackingNumber', v_tracking, 'paymentStatus', v_req.payment_status, 'duplicate', true, 'applied', false);
  end if;

  if v_req.status in ('cancelled', 'store_cancelled') then
    v_outcome := 'late_after_cancel'; v_case := 'cod_after_cancel';
  elsif v_req.approved_at is null or v_req.status in ('awaiting_store_confirmation', 'store_rejected') then
    raise exception 'Order is not waiting for payment' using errcode = 'P0001';
  elsif v_req.payment_status = 'paid' then
    v_outcome := 'state_rejected'; v_case := 'cod_after_payment';
  elsif v_req.payment_status = 'cod_selected' then
    v_outcome := 'duplicate_payment';                                   -- the same choice told again
  else
    insert into public.order_payments (request_id, store_id, user_id, method_kind, mode, provider, status, amount, currency, idempotency_key)
    values (v_req.id, v_req.store_id, v_req.user_id, 'cod', 'none', 'cod', 'cod_selected', coalesce(v_total, v_req.payable_amount, v_req.subtotal), 'EGP', 'cod:' || v_idem)
    returning * into v_pay;
    perform set_config('elan.pay_write', 'on', true);
    perform set_config('elan.terms_write', 'on', true);
    update public.store_order_requests set payment_status = 'cod_selected', payment_method = 'cod', payment_provider = null,
           payment_reference = 'COD-' || v_req.tracking_number, paid_at = null,
           payable_amount = coalesce(v_total, payable_amount), total_amount = coalesce(v_total, total_amount),
           payment_failure_reason = null, payment_failed_at = null, updated_at = now() where id = v_req.id;
    perform set_config('elan.terms_write', 'off', true);
    perform set_config('elan.pay_write', 'off', true);
    perform private.finalize_payment(v_req.id);
    v_outcome := 'cod_recorded'; v_applied := true;
  end if;

  insert into public.order_payment_events (request_id, payment_id, store_id, provider, event_id, event_type, provider_transaction_id, payment_reference,
                                           amount, currency, occurred_at, idempotency_key, payload_hash, outcome)
  values (v_req.id, v_pay.id, p_store_id, 'merchant', v_event, 'cod.selected', null, null, v_total, 'EGP', v_at, v_idem,
          encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex'), v_outcome);
  if v_case is not null then
    perform private.open_discrepancy(v_req.id, v_case, 'cod-event:' || v_idem,
      jsonb_build_object('eventId', v_event, 'total', v_total, 'outcome', v_outcome, 'orderStatus', v_req.status, 'paymentStatus', v_req.payment_status, 'subtotal', v_req.subtotal));
  end if;
  return jsonb_build_object('trackingNumber', v_tracking, 'paymentStatus', (select r.payment_status from public.store_order_requests r where r.id = v_req.id),
                            'duplicate', false, 'applied', v_applied, 'outcome', v_outcome);
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The door the Worker uses for a provider's notice: which channels could have sealed it, what to do once one verified it, and the test gate
-- ---------------------------------------------------------------------------------------------------------------------
-- A notice whose reference is the tracking number of an order can only belong to that order's store; otherwise every live channel of the provider is a candidate
-- (so a genuine notice with an unknown reference is kept and shown to the admin instead of lost, while a forged one, which no key verifies, never is).
create or replace function public.payment_channel_candidates(p_provider text, p_reference text)
returns table (channel_id uuid, store_id uuid, verification_key text, status text, order_found boolean)
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  with ord as (select r.store_id from public.store_order_requests r where p_reference ~ '^[A-Za-z0-9._-]{1,64}$' and r.tracking_number = p_reference limit 1)
  select c.id, c.store_id, c.verification_key, c.status, (o.store_id is not null)
    from public.store_payment_channels c left join ord o on o.store_id = c.store_id
   where c.provider = p_provider and c.status in ('pending_test', 'verified')
     and (not exists (select 1 from ord) or o.store_id is not null)
   order by c.created_at, c.id limit 50
$$;

-- The Worker calls this only after a channel's key verified the notice's seal. The event is already normalised (eventId, eventType, trackingNumber,
-- providerTransactionId, amount, currency, paymentMethod, reason; eventType 'unsupported' for a refund, an authorisation or another kind not handled).
create or replace function public.record_channel_event(p_channel_id uuid, p_event jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_ch public.store_payment_channels;
  v_event text := nullif(btrim(coalesce(p_event->>'eventId', '')), '');
  v_type text := lower(coalesce(p_event->>'eventType', ''));
  v_ref text := nullif(btrim(coalesce(p_event->>'trackingNumber', '')), '');
  v_cur text := upper(coalesce(nullif(btrim(coalesce(p_event->>'currency', '')), ''), 'EGP'));
  v_amount numeric; v_outcome text; v_logged uuid; v_res jsonb; v_found boolean := false;
begin
  select * into v_ch from public.store_payment_channels where id = p_channel_id for update;
  if not found or v_ch.status = 'disabled' then raise exception 'Payment channel not found' using errcode = 'P0001'; end if;
  if v_event is null or char_length(v_event) > 300 then raise exception 'Invalid event id' using errcode = 'P0001'; end if;
  if v_type not in ('payment.succeeded', 'payment.failed', 'unsupported') then raise exception 'Invalid event type' using errcode = 'P0001'; end if;
  if v_ref is not null and v_ref !~ '^[A-Za-z0-9._-]{1,64}$' then v_ref := null; end if;
  if p_event->>'amount' ~ '^\d{1,9}(\.\d{1,2})?$' then v_amount := (p_event->>'amount')::numeric; end if;
  update public.store_payment_channels set last_event_at = now(), updated_at = now() where id = v_ch.id;

  if v_ch.status = 'pending_test' then
    v_outcome := 'test_received';                                        -- proof that the channel's seal verifies on real traffic; no money is applied
  elsif v_type = 'unsupported' then
    v_outcome := 'unsupported_kind';
  else
    select true into v_found from public.store_order_requests r where r.tracking_number = v_ref and r.store_id = v_ch.store_id;
    if not coalesce(v_found, false) then v_outcome := 'unmatched_reference'; end if;
  end if;

  if v_outcome is not null then
    insert into public.payment_channel_log (channel_id, store_id, provider, event_id, event_type, tracking_number, amount, currency, outcome)
    values (v_ch.id, v_ch.store_id, v_ch.provider, v_event, v_type, v_ref, v_amount, v_cur, v_outcome)
    on conflict (channel_id, event_id) do nothing returning id into v_logged;
    if v_logged is null then return jsonb_build_object('duplicate', true, 'applied', false, 'outcome', v_outcome); end if;
    if v_outcome = 'unmatched_reference' then
      perform private.notify_platform_admin('payment_unmatched', 'إشعار دفع بمرجع لا يطابق طلبًا',
        'وصل إشعار موقَّع من قناة الدفع (' || v_ch.provider || ') لكن مرجعه لا يطابق أي طلب لهذا المتجر. حُفظ في سجل القناة ولم يُطبَّق على شيء.',
        jsonb_build_object('provider', v_ch.provider, 'reference', v_ref, 'amount', v_amount, 'eventType', v_type), null, v_ch.store_id);
    elsif v_outcome = 'unsupported_kind' then
      perform private.notify_platform_admin('payment_unsupported', 'إشعار من قناة الدفع من نوع لا يُعالَج',
        'وصل من قناة الدفع (' || v_ch.provider || ') حدث من نوع لا تعالجه المنصة (استرداد أو تفويض أو غيره). حُفظ ولم يُطبَّق.',
        jsonb_build_object('provider', v_ch.provider, 'reference', v_ref, 'amount', v_amount), null, v_ch.store_id);
    end if;
    return jsonb_build_object('duplicate', false, 'applied', false, 'outcome', v_outcome);
  end if;

  v_res := public.record_payment_event(v_ch.store_id, p_event || jsonb_build_object('provider', v_ch.provider));
  if coalesce((v_res->>'duplicate')::boolean, false) then return v_res; end if;
  insert into public.payment_channel_log (channel_id, store_id, provider, event_id, event_type, tracking_number, amount, currency, outcome)
  values (v_ch.id, v_ch.store_id, v_ch.provider, v_event, v_type, v_ref, v_amount, v_cur, coalesce(v_res->>'outcome', 'applied'))
  on conflict (channel_id, event_id) do nothing;
  return v_res;
end; $$;

-- A channel becomes live only after a real signed notice from the provider's account has arrived on it (the log holds it).
create or replace function public.verify_payment_channel(p_channel_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_ch public.store_payment_channels;
begin
  select * into v_ch from public.store_payment_channels where id = p_channel_id for update;
  if not found or v_ch.status = 'disabled' then raise exception 'Payment channel not found' using errcode = 'P0001'; end if;
  if v_ch.status = 'verified' then return jsonb_build_object('status', 'verified', 'changed', false); end if;
  if not exists (select 1 from public.payment_channel_log l where l.channel_id = v_ch.id and l.outcome = 'test_received') then
    raise exception 'No signed test notice has arrived on this channel' using errcode = 'P0001';
  end if;
  update public.store_payment_channels set status = 'verified', verified_at = now(), updated_at = now() where id = v_ch.id;
  return jsonb_build_object('status', 'verified', 'changed', true);
end; $$;

revoke all on function public.record_payment_event(uuid, jsonb), public.record_cod_selection(uuid, jsonb), public.payment_channel_candidates(text, text),
  public.record_channel_event(uuid, jsonb), public.verify_payment_channel(uuid), private.notify_platform_admin(text, text, text, jsonb, uuid, uuid),
  private.open_discrepancy(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_payment_event(uuid, jsonb), public.record_cod_selection(uuid, jsonb), public.payment_channel_candidates(text, text),
  public.record_channel_event(uuid, jsonb), public.verify_payment_channel(uuid) to service_role;
