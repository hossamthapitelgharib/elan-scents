-- Rollback of stage2_neutral_payment_confirmation (applied 2026-11-27, 20261127210257_stage2_neutral_payment_confirmation.sql): puts the payment event function and the payment-fields guard
-- back as the phase 2 migration (20261111064516_phase2_payment_merchant_shipping) wrote them and drops everything stage 2 added.
-- WARNING: this loses data the stage holds.
--   * the merchants' payment channels with their verification keys (public.store_payment_channels), the log of every signed notice they delivered
--     (public.payment_channel_log) and the discrepancy cases (public.order_discrepancies) are dropped; the discrepancy cases are the platform's record of money
--     it could not match to an order, so take a copy of them first if any is open;
--   * the provider's refusal words kept on orders (store_order_requests.payment_failure_reason / payment_failed_at) and the reason of an order payment event
--     are dropped with their columns;
--   * order_payment_events rows cannot be deleted (append-only) and stay; the old CHECK constraints are put back NOT VALID so rows with the new event type
--     ('cod.selected') or outcomes ('late_after_cancel', 'cod_recorded') do not block the rollback and are not checked again.
-- Payments, cash-on-delivery choices and first notices already written by the stage stay as ordinary rows of their own tables and are NOT touched.
begin;

drop function if exists public.record_cod_selection(uuid, jsonb);
drop function if exists public.record_channel_event(uuid, jsonb);
drop function if exists public.verify_payment_channel(uuid);
drop function if exists public.payment_channel_candidates(text, text);
drop function if exists private.open_discrepancy(uuid, text, text, jsonb);
drop function if exists private.notify_platform_admin(text, text, text, jsonb, uuid, uuid);

-- The guard first (the new one names the columns that are dropped below), then the payment event function as it was.
create or replace function private.guard_payment_fields()
returns trigger language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
begin
  if (new.payment_status, new.payment_method, new.payment_provider, new.payment_reference, new.paid_at, new.cart_cleared_at, new.sale_proven_at)
       is distinct from (old.payment_status, old.payment_method, old.payment_provider, old.payment_reference, old.paid_at, old.cart_cleared_at, old.sale_proven_at)
     and coalesce(current_setting('elan.pay_write', true), '') <> 'on' then
    raise exception 'Payment fields are written only by the payment functions' using errcode = 'P0001';
  end if;
  if old.approved_at is not null and (new.approved_at is distinct from old.approved_at
       or new.payable_amount is distinct from old.payable_amount or new.payment_options is distinct from old.payment_options) then
    raise exception 'The approved payment terms are fixed' using errcode = 'P0001';
  end if;
  if new.status in ('processing', 'shipped', 'delivered') and new.status is distinct from old.status and not private.payment_executed(new.payment_status) then
    raise exception 'Payment is required before processing or shipping' using errcode = 'P0001';
  end if;
  return new;
end; $$;

create or replace function public.record_payment_event(p_store_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_tracking text := nullif(btrim(coalesce(p_payload->>'trackingNumber', '')), '');
  v_event text := nullif(btrim(coalesce(p_payload->>'eventId', '')), '');
  v_type text := lower(coalesce(p_payload->>'eventType', ''));
  v_txn text := nullif(btrim(coalesce(p_payload->>'providerTransactionId', '')), '');
  v_ref text := nullif(btrim(coalesce(p_payload->>'paymentReference', '')), '');
  v_provider text := coalesce(nullif(btrim(coalesce(p_payload->>'provider', '')), ''), 'merchant');
  v_cur text := upper(coalesce(nullif(btrim(coalesce(p_payload->>'currency', '')), ''), 'EGP'));
  v_amount numeric; v_at timestamptz;
  v_req public.store_order_requests; v_pay public.order_payments; v_outcome text; v_idem text; v_applied boolean := false; v_reason text := nullif(btrim(coalesce(p_payload->>'reason', '')), '');
begin
  if p_store_id is null or v_tracking is null then raise exception 'Order not found' using errcode = 'P0001'; end if;
  select * into v_req from public.store_order_requests where tracking_number = v_tracking and store_id = p_store_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0001'; end if;
  if v_event is null or char_length(v_event) > 200 then raise exception 'Invalid event id' using errcode = 'P0001'; end if;
  if v_type not in ('payment.succeeded', 'payment.failed') then raise exception 'Invalid event type' using errcode = 'P0001'; end if;
  if v_type = 'payment.succeeded' and (v_txn is null or char_length(v_txn) > 160) then raise exception 'A provider transaction id is required' using errcode = 'P0001'; end if;
  if v_ref is not null and char_length(v_ref) > 160 then raise exception 'Invalid payment reference' using errcode = 'P0001'; end if;
  if p_payload ? 'amount' then
    if p_payload->>'amount' !~ '^\d{1,9}(\.\d{1,2})?$' then raise exception 'Invalid amount' using errcode = 'P0001'; end if;
    v_amount := (p_payload->>'amount')::numeric;
  end if;
  begin v_at := nullif(p_payload->>'occurredAt', '')::timestamptz; exception when others then raise exception 'Invalid time' using errcode = 'P0001'; end;
  v_idem := p_store_id::text || ':' || v_event;
  if exists (select 1 from public.order_payment_events where idempotency_key = v_idem) then
    return jsonb_build_object('trackingNumber', v_tracking, 'paymentStatus', v_req.payment_status, 'duplicate', true, 'applied', false);
  end if;

  if v_type = 'payment.failed' then
    v_outcome := 'failed_recorded';
    if v_req.payment_status = 'awaiting_payment' then
      update public.order_payments set status = 'failed', failure_reason = left(v_reason, 500), updated_at = now()
        where request_id = v_req.id and status = 'initiated';
      perform set_config('elan.pay_write', 'on', true);
      update public.store_order_requests set payment_status = 'failed', updated_at = now() where id = v_req.id;
      perform set_config('elan.pay_write', 'off', true);
    end if;
  elsif v_req.approved_at is null or v_req.status in ('awaiting_store_confirmation', 'store_rejected', 'store_cancelled', 'cancelled', 'restored') then
    v_outcome := 'state_rejected';
  elsif v_req.payment_status = 'cod_selected' then
    v_outcome := 'state_rejected';
  elsif v_req.payment_status = 'paid' then
    v_outcome := 'duplicate_payment';
  elsif v_cur <> 'EGP' then
    v_outcome := 'currency_mismatch';
  elsif v_amount is null or v_amount <> v_req.payable_amount then
    v_outcome := 'amount_mismatch';
  elsif exists (select 1 from public.order_payments p where p.provider = v_provider and p.provider_transaction_id = v_txn) then
    v_outcome := 'duplicate_payment';
  else
    select * into v_pay from public.order_payments where request_id = v_req.id and status = 'initiated' order by created_at desc limit 1 for update;
    if not found then
      insert into public.order_payments (request_id, store_id, user_id, method_kind, mode, provider, status, amount, currency, idempotency_key)
      values (v_req.id, v_req.store_id, v_req.user_id, 'card', 'redirect', v_provider, 'initiated', v_req.payable_amount, 'EGP', 'event:' || v_idem)
      returning * into v_pay;
    end if;
    update public.order_payments set status = 'paid', provider = v_provider, provider_transaction_id = v_txn, payment_reference = coalesce(v_ref, v_txn),
           paid_at = coalesce(v_at, now()), updated_at = now() where id = v_pay.id returning * into v_pay;
    perform set_config('elan.pay_write', 'on', true);
    update public.store_order_requests set payment_status = 'paid', payment_method = coalesce(payment_method, v_pay.method_kind), payment_provider = v_provider,
           payment_reference = v_pay.payment_reference, paid_at = v_pay.paid_at, updated_at = now() where id = v_req.id;
    perform set_config('elan.pay_write', 'off', true);
    perform private.finalize_payment(v_req.id);
    v_outcome := 'applied'; v_applied := true;
  end if;

  insert into public.order_payment_events (request_id, payment_id, store_id, provider, event_id, event_type, provider_transaction_id, payment_reference,
                                           amount, currency, occurred_at, idempotency_key, payload_hash, outcome)
  values (v_req.id, v_pay.id, p_store_id, v_provider, v_event, v_type, v_txn, v_ref, v_amount, v_cur, v_at, v_idem,
          encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex'), v_outcome);
  if v_type = 'payment.succeeded' and not v_applied then
    perform public.emit_order_notification((select r from public.store_order_requests r where r.id = v_req.id), 'payment_event_rejected',
      'حدث دفع يحتاج مراجعة', 'وصل حدث دفع للطلب ' || v_tracking || ' ولم يُطبَّق (' || v_outcome || ').',
      jsonb_build_object('trackingNumber', v_tracking, 'outcome', v_outcome));
  end if;
  return jsonb_build_object('trackingNumber', v_tracking, 'paymentStatus', (select payment_status from public.store_order_requests where id = v_req.id),
                            'duplicate', false, 'applied', v_applied, 'outcome', v_outcome);
end; $$;

drop table if exists public.order_discrepancies;
drop table if exists public.payment_channel_log;
drop table if exists public.store_payment_channels;

alter table public.store_order_requests drop column if exists payment_failure_reason, drop column if exists payment_failed_at;
alter table public.order_payment_events drop column if exists reason;
alter table public.order_payment_events drop constraint if exists order_payment_events_event_type_check;
alter table public.order_payment_events drop constraint if exists order_payment_events_outcome_check;
alter table public.order_payment_events
  add constraint order_payment_events_event_type_check check (event_type in ('payment.succeeded', 'payment.failed')) not valid,
  add constraint order_payment_events_outcome_check check (outcome in ('applied', 'failed_recorded', 'duplicate_payment', 'amount_mismatch', 'currency_mismatch', 'state_rejected')) not valid;

revoke all on function public.record_payment_event(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_payment_event(uuid, jsonb) to service_role;

commit;
