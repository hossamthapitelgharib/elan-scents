-- Phase 3 of the purchase redesign (docs/implementation-phase-3-returns-refunds.ar.md): returns, refunds and closing the loop.
--
-- A return is a standalone record (return_requests) tied to the original purchase line, with ONE row per line (unique order_item_id).
--   1. the customer opens the returned product in «طلباتي» and writes only the reason; the SERVER copies everything else from the original
--      order (the original quantity, the money, the merchant order and invoice numbers, the payment, the shipment and waybill, the full
--      address snapshot). There is no exchange field and no quantity input: a return is always the full original quantity.
--   2. the request goes to the merchant. A rejection needs a reason (shown to the customer) and closes the request. An approval records the
--      pickup appointment, then the merchant records the receipt of the product. Approval does not close anything.
--   3. only a signed, replay-protected refund.completed notice that MATCHES the original order closes the request: order, merchant order and
--      invoice numbers, the original payment method and reference, the amount (the product's value, EGP) and the return itself. A mismatch is
--      recorded with its fields and changes nothing. The refund goes back through the original payment method: the notice cannot name another.
--   4. only after that matched notice the customer's issue ends: a completed adjustment (the existing ledger mechanism) reverses the product's
--      value and its commission completely. A commission that was already paid is never rewritten: it is flagged credit_due for the platform.
-- Nothing in this migration lets a browser create, decide or close a return: the tables and functions are reached by the server only.
begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------------------------------------------------------
create sequence if not exists public.return_number_seq;
revoke all on sequence public.return_number_seq from public, anon, authenticated;

-- The return window of a store, in days: the store's own setting, otherwise the platform default of 14 days.
create or replace function private.return_window_days(p_store_id uuid)
returns integer language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select coalesce((select s.return_window_days from public.stores s where s.id = p_store_id), 14)
$$;

-- When the return window starts: delivery documented by a signed delivered event with a waybill (sale_proven_at), or verified by the platform.
-- Never a customer click.
create or replace function private.return_window_start(p_request_id uuid)
returns timestamptz language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select coalesce(r.sale_proven_at, case when sh.delivery_verified_at is not null then sh.delivered_at end)
  from public.store_order_requests r left join public.store_shipments sh on sh.request_id = r.id
  where r.id = p_request_id
$$;

-- Why a purchase line cannot be returned right now; null when it can. The single source for the button and for the creation itself.
create or replace function private.return_block_reason(p_item_id uuid)
returns text language plpgsql stable security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_item public.store_order_request_items; v_req public.store_order_requests; v_start timestamptz;
begin
  select * into v_item from public.store_order_request_items where id = p_item_id;
  if not found then return 'item_not_found'; end if;
  select * into v_req from public.store_order_requests where id = v_item.request_id;
  if exists (select 1 from public.return_requests where order_item_id = p_item_id) then return 'already_requested'; end if;
  if v_req.status in ('awaiting_store_confirmation', 'needs_review', 'store_rejected', 'store_cancelled', 'cancelled', 'restored') then return 'order_closed'; end if;
  if not private.payment_executed(v_req.payment_status) then return 'payment_missing'; end if;
  v_start := private.return_window_start(v_req.id);
  if v_start is null then return 'not_delivered'; end if;
  if now() > v_start + make_interval(days => private.return_window_days(v_req.store_id)) then return 'window_closed'; end if;
  if v_req.merchant_order_number is null or v_req.merchant_invoice_number is null then return 'merchant_numbers_missing'; end if;
  return null;
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The return request (one per purchase line; the original data is a copy that never changes)
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists public.return_requests (
  id uuid primary key default gen_random_uuid(),
  return_number text not null unique default ('RET-' || to_char(now() at time zone 'Africa/Cairo', 'YYYYMMDD') || '-' || lpad(nextval('public.return_number_seq')::text, 6, '0')),
  elan_order_id uuid not null references public.store_order_requests(id),
  order_item_id uuid not null references public.store_order_request_items(id),
  customer_id uuid not null,
  store_id uuid not null references public.stores(id),
  status text not null default 'requested' check (status in ('requested', 'approved', 'received', 'refunded', 'rejected')),
  reason text not null check (char_length(reason) between 3 and 1000),
  rejection_reason text check (rejection_reason is null or char_length(rejection_reason) between 1 and 500),
  -- copied by the server from the original purchase (never sent by the browser)
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  line_total numeric(12,2) not null check (line_total >= 0),
  currency text not null default 'EGP' check (currency = 'EGP'),
  product_size_id uuid,
  product_name text not null,
  brand_name text,
  size_label text,
  platform_order_number text,
  tracking_number text not null,
  merchant_order_number text not null,
  merchant_invoice_number text not null,
  payment_method text not null check (payment_method in ('card', 'cod', 'other')),
  payment_provider text,
  payment_reference text,
  payable_amount numeric(12,2),
  paid_at timestamptz,
  shipment_snapshot jsonb not null default '{}'::jsonb,
  customer_snapshot jsonb not null,
  product_snapshot jsonb,
  window_starts_at timestamptz not null,
  window_ends_at timestamptz not null,
  -- what the refund must be: the product's value, by the original payment method
  refund_expected_amount numeric(12,2) not null check (refund_expected_amount > 0),
  refund_method text not null check (refund_method in ('card', 'cod', 'other')),
  -- the merchant's side
  decided_at timestamptz,
  pickup_at timestamptz,
  pickup_note text check (pickup_note is null or char_length(pickup_note) <= 500),
  received_at timestamptz,
  -- the refund (only from a matched signed notice)
  refund_amount numeric(12,2),
  refund_reference text check (refund_reference is null or char_length(refund_reference) between 1 and 160),
  refunded_at timestamptz,
  refund_notice_id uuid,
  commission_effect text check (commission_effect is null or commission_effect in ('reversed', 'credit_due', 'none')),
  commission_amount_reversed numeric(12,2),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint return_requests_one_per_line unique (order_item_id),
  constraint return_requests_rejection_needs_reason check (status <> 'rejected' or rejection_reason is not null),
  constraint return_requests_approved_has_pickup check (status not in ('approved', 'received', 'refunded') or (pickup_at is not null and decided_at is not null)),
  constraint return_requests_received_has_time check (status not in ('received', 'refunded') or received_at is not null),
  constraint return_requests_refunded_has_refund check (status <> 'refunded' or (refund_amount is not null and refund_reference is not null and refunded_at is not null and closed_at is not null)),
  constraint return_requests_closed_check check ((status in ('refunded', 'rejected')) = (closed_at is not null))
);
comment on table public.return_requests is 'One return per purchase line (unique order_item_id): the full original quantity, a copy of the original order''s numbers and address, the merchant''s decision and the matched refund. No exchange, no partial return, no browser access.';
create index if not exists return_requests_store_status_idx on public.return_requests (store_id, status, created_at desc);
create index if not exists return_requests_customer_idx on public.return_requests (customer_id, created_at desc);
create index if not exists return_requests_order_idx on public.return_requests (elan_order_id);

-- A direct insert must carry the very same data as the original purchase line: the full quantity, the same money, the same numbers.
create or replace function private.guard_return_request_insert()
returns trigger language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_item public.store_order_request_items; v_req public.store_order_requests;
begin
  select * into v_item from public.store_order_request_items where id = new.order_item_id;
  select * into v_req from public.store_order_requests where id = new.elan_order_id;
  if v_item.id is null or v_req.id is null or v_item.request_id <> v_req.id then raise exception 'Order item does not belong to the order' using errcode = 'P0001'; end if;
  if new.quantity <> v_item.quantity then raise exception 'A return covers the full original quantity' using errcode = 'P0001'; end if;
  if new.unit_price <> v_item.unit_price or new.line_total <> v_item.line_total or new.currency <> 'EGP' or new.refund_expected_amount <> v_item.line_total then
    raise exception 'The return must carry the original amounts' using errcode = 'P0001';
  end if;
  if v_req.user_id is distinct from new.customer_id or v_req.store_id <> new.store_id then raise exception 'The return must belong to the original customer and store' using errcode = 'P0001'; end if;
  if (new.tracking_number, new.merchant_order_number, new.merchant_invoice_number, new.payment_method, new.payment_reference)
       is distinct from (v_req.tracking_number, v_req.merchant_order_number, v_req.merchant_invoice_number, v_req.payment_method, v_req.payment_reference) then
    raise exception 'The return must carry the original order numbers' using errcode = 'P0001';
  end if;
  if new.refund_method <> v_req.payment_method then raise exception 'The refund goes back by the original payment method' using errcode = 'P0001'; end if;
  if new.status <> 'requested' or coalesce(current_setting('elan.return_write', true), '') <> 'on' then
    raise exception 'Returns are created only by the return functions' using errcode = 'P0001';
  end if;
  return new;
end; $$;
create or replace trigger guard_return_request_insert before insert on public.return_requests
  for each row execute function private.guard_return_request_insert();

-- The original data is fixed; the process columns move only through the return functions and only forward.
create or replace function private.guard_return_request_update()
returns trigger language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
begin
  if (new.id, new.return_number, new.elan_order_id, new.order_item_id, new.customer_id, new.store_id, new.reason, new.quantity, new.unit_price, new.line_total,
      new.currency, new.product_size_id, new.product_name, new.brand_name, new.size_label, new.platform_order_number, new.tracking_number,
      new.merchant_order_number, new.merchant_invoice_number, new.payment_method, new.payment_provider, new.payment_reference, new.payable_amount,
      new.paid_at, new.shipment_snapshot, new.customer_snapshot, new.product_snapshot, new.window_starts_at, new.window_ends_at,
      new.refund_expected_amount, new.refund_method, new.created_at)
     is distinct from
     (old.id, old.return_number, old.elan_order_id, old.order_item_id, old.customer_id, old.store_id, old.reason, old.quantity, old.unit_price, old.line_total,
      old.currency, old.product_size_id, old.product_name, old.brand_name, old.size_label, old.platform_order_number, old.tracking_number,
      old.merchant_order_number, old.merchant_invoice_number, old.payment_method, old.payment_provider, old.payment_reference, old.payable_amount,
      old.paid_at, old.shipment_snapshot, old.customer_snapshot, old.product_snapshot, old.window_starts_at, old.window_ends_at,
      old.refund_expected_amount, old.refund_method, old.created_at) then
    raise exception 'The original purchase data of a return never changes' using errcode = 'P0001';
  end if;
  if coalesce(current_setting('elan.return_write', true), '') <> 'on' then
    raise exception 'Return fields are written only by the return functions' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'requested' and new.status in ('approved', 'rejected'))
    or (old.status = 'approved' and new.status = 'received')
    or (old.status = 'received' and new.status = 'refunded')) then
    raise exception 'Invalid return transition' using errcode = 'P0001';
  end if;
  if old.status in ('refunded', 'rejected') then raise exception 'A closed return is never changed' using errcode = 'P0001'; end if;
  new.updated_at := now();
  return new;
end; $$;
create or replace trigger guard_return_request_update before update on public.return_requests
  for each row execute function private.guard_return_request_update();

-- Customer records are never deleted.
create or replace function private.forbid_return_delete()
returns trigger language plpgsql set search_path to 'pg_temp' as $$
begin raise exception 'A return record is never deleted' using errcode = 'P0001'; end; $$;
create or replace trigger forbid_return_delete before delete on public.return_requests
  for each row execute function private.forbid_return_delete();

alter table public.return_requests enable row level security;
create policy return_requests_admin_all on public.return_requests for all to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());
revoke all on public.return_requests from anon, authenticated;
grant select, insert, update on public.return_requests to service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The return's event log (append-only) and the refund notices (immutable)
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists public.return_request_events (
  id uuid primary key default gen_random_uuid(),
  return_request_id uuid not null references public.return_requests(id),
  store_id uuid not null references public.stores(id),
  event_key text unique,
  event_type text not null check (event_type in ('requested', 'approved', 'rejected', 'received', 'refund_completed', 'refund_mismatch', 'refund_ignored')),
  source text not null check (source in ('customer', 'merchant_api', 'store_dashboard', 'platform')),
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists return_request_events_return_idx on public.return_request_events (return_request_id, occurred_at);
create or replace trigger return_request_events_append_only before update or delete on public.return_request_events
  for each row execute function private.forbid_change();
alter table public.return_request_events enable row level security;
create policy return_request_events_admin_read on public.return_request_events for select to authenticated using (private.is_platform_admin());
revoke all on public.return_request_events from anon, authenticated;
grant select, insert on public.return_request_events to service_role;

create table if not exists public.return_refund_notices (
  id uuid primary key default gen_random_uuid(),
  return_request_id uuid not null references public.return_requests(id),
  store_id uuid not null references public.stores(id),
  event_key text not null unique,
  tracking_number text not null,
  merchant_order_number text,
  merchant_invoice_number text,
  original_payment_method text,
  original_payment_reference text,
  refund_amount numeric(12,2),
  currency text,
  refund_reference text,
  refund_status text,
  occurred_at timestamptz,
  outcome text not null check (outcome in ('applied', 'mismatch', 'not_received', 'already_closed', 'duplicate_refund')),
  mismatch_fields jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
comment on table public.return_refund_notices is 'Every signed refund.completed notice as it arrived (immutable), with its outcome: applied, or recorded without changing anything. A refund reference is applied at most once.';
create unique index if not exists return_refund_notices_one_applied_uq on public.return_refund_notices (return_request_id) where outcome = 'applied';
create unique index if not exists return_refund_notices_reference_uq on public.return_refund_notices (store_id, refund_reference) where outcome = 'applied';
create or replace trigger return_refund_notices_append_only before update or delete on public.return_refund_notices
  for each row execute function private.forbid_change();
alter table public.return_refund_notices enable row level security;
create policy return_refund_notices_admin_read on public.return_refund_notices for select to authenticated using (private.is_platform_admin());
revoke all on public.return_refund_notices from anon, authenticated;
grant select, insert on public.return_refund_notices to service_role;

create or replace function private.log_return_event(p_return_id uuid, p_store_id uuid, p_key text, p_type text, p_source text, p_payload jsonb)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
begin
  insert into public.return_request_events (return_request_id, store_id, event_key, event_type, source, payload)
  values (p_return_id, p_store_id, p_key, p_type, p_source, coalesce(p_payload, '{}'::jsonb))
  on conflict (event_key) do nothing;
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. What the customer sees: which lines can be returned right now (the single source for the button)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.customer_return_eligibility(p_user_id uuid, p_request_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_out jsonb := '[]'::jsonb; v_row record; v_code text; v_start timestamptz;
begin
  if p_user_id is null or p_request_ids is null or cardinality(p_request_ids) = 0 then return v_out; end if;
  for v_row in
    select i.id as item_id, r.id as request_id, r.store_id
    from public.store_order_requests r join public.store_order_request_items i on i.request_id = r.id
    where r.user_id = p_user_id and r.id = any (p_request_ids)
    order by r.created_at desc, i.created_at
    limit 500
  loop
    v_code := private.return_block_reason(v_row.item_id);
    v_start := private.return_window_start(v_row.request_id);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'requestItemId', v_row.item_id, 'requestId', v_row.request_id, 'eligible', v_code is null, 'code', coalesce(v_code, 'eligible'),
      'deadline', case when v_start is not null then v_start + make_interval(days => private.return_window_days(v_row.store_id)) end));
  end loop;
  return v_out;
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The customer opens a return: the reason is the only thing read from the browser
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.create_return_request_server(p_user_id uuid, p_request_item_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_item public.store_order_request_items; v_req public.store_order_requests; v_ship public.store_shipments; v_existing public.return_requests;
  v_ret public.return_requests; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_code text; v_start timestamptz; v_days integer;
begin
  if p_user_id is null or p_request_item_id is null then raise exception 'Order item not found' using errcode = 'P0001'; end if;
  select * into v_item from public.store_order_request_items where id = p_request_item_id;
  if not found then raise exception 'Order item not found' using errcode = 'P0001'; end if;
  -- the order belongs to this customer, or the line does not exist for them
  select * into v_req from public.store_order_requests where id = v_item.request_id and user_id = p_user_id for update;
  if not found then raise exception 'Order item not found' using errcode = 'P0001'; end if;

  select * into v_existing from public.return_requests where order_item_id = v_item.id;
  if found then
    return jsonb_build_object('returnRequestId', v_existing.id, 'returnNumber', v_existing.return_number, 'status', v_existing.status, 'duplicate', true);
  end if;

  if v_reason is null or char_length(v_reason) < 3 then raise exception 'A return needs a reason' using errcode = 'P0001'; end if;
  if char_length(v_reason) > 1000 then raise exception 'Reason is too long' using errcode = 'P0001'; end if;
  v_code := private.return_block_reason(v_item.id);
  if v_code is not null then
    raise exception '%', case v_code
      when 'order_closed' then 'This order cannot be returned'
      when 'payment_missing' then 'Payment is not recorded'
      when 'not_delivered' then 'Delivery is not documented yet'
      when 'window_closed' then 'The return window has closed'
      when 'merchant_numbers_missing' then 'The merchant numbers are not recorded yet'
      else 'Order item not found' end using errcode = 'P0001';
  end if;

  select * into v_ship from public.store_shipments where request_id = v_req.id;
  v_start := private.return_window_start(v_req.id);
  v_days := private.return_window_days(v_req.store_id);

  perform set_config('elan.return_write', 'on', true);
  insert into public.return_requests (
    elan_order_id, order_item_id, customer_id, store_id, status, reason, quantity, unit_price, line_total, currency, product_size_id, product_name, brand_name,
    size_label, platform_order_number, tracking_number, merchant_order_number, merchant_invoice_number, payment_method, payment_provider, payment_reference,
    payable_amount, paid_at, shipment_snapshot, customer_snapshot, product_snapshot, window_starts_at, window_ends_at, refund_expected_amount, refund_method)
  values (
    v_req.id, v_item.id, p_user_id, v_req.store_id, 'requested', v_reason, v_item.quantity, v_item.unit_price, v_item.line_total, 'EGP', v_item.product_size_id,
    v_item.product_name, v_item.brand_name, v_item.size_label, v_item.platform_order_number, v_req.tracking_number, v_req.merchant_order_number,
    v_req.merchant_invoice_number, v_req.payment_method, v_req.payment_provider, v_req.payment_reference, v_req.payable_amount, v_req.paid_at,
    jsonb_build_object('carrier', v_ship.carrier_name, 'waybill', v_ship.tracking_code, 'shippingStatus', v_ship.shipping_status,
                       'deliveredAt', v_ship.delivered_at, 'deliveryVerifiedAt', v_ship.delivery_verified_at, 'verificationSource', v_ship.delivery_verification_source),
    coalesce(v_req.customer_snapshot, '{}'::jsonb), v_item.product_snapshot, v_start, v_start + make_interval(days => v_days), v_item.line_total, v_req.payment_method)
  returning * into v_ret;
  perform set_config('elan.return_write', 'off', true);

  perform private.log_return_event(v_ret.id, v_ret.store_id, 'req:' || v_ret.id::text, 'requested', 'customer', jsonb_build_object('reason', v_reason));
  return jsonb_build_object('returnRequestId', v_ret.id, 'returnNumber', v_ret.return_number, 'status', v_ret.status, 'duplicate', false);
exception when unique_violation then
  perform set_config('elan.return_write', 'off', true);
  select * into v_existing from public.return_requests where order_item_id = p_request_item_id;
  if found then return jsonb_build_object('returnRequestId', v_existing.id, 'returnNumber', v_existing.return_number, 'status', v_existing.status, 'duplicate', true); end if;
  raise;
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The merchant's side: decision, receipt (the store id is the authenticated store: another store's return is "not found")
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.merchant_return_decision(p_store_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_tracking text := nullif(btrim(coalesce(p_payload->>'trackingNumber', '')), '');
  v_decision text := lower(coalesce(p_payload->>'decision', ''));
  v_reason text := nullif(btrim(coalesce(p_payload->>'reason', '')), '');
  v_note text := nullif(btrim(coalesce(p_payload->>'pickupNote', '')), '');
  v_event text := nullif(btrim(coalesce(p_payload->>'eventId', '')), '');
  v_source text := case when p_payload->>'source' = 'store_dashboard' then 'store_dashboard' else 'merchant_api' end;
  v_id uuid; v_pickup timestamptz; v_ret public.return_requests;
begin
  if p_store_id is null or v_tracking is null then raise exception 'Return not found' using errcode = 'P0001'; end if;
  begin v_id := nullif(p_payload->>'returnRequestId', '')::uuid; exception when others then raise exception 'Return not found' using errcode = 'P0001'; end;
  select rr.* into v_ret from public.return_requests rr join public.store_order_requests r on r.id = rr.elan_order_id
   where rr.id = v_id and rr.store_id = p_store_id and r.tracking_number = v_tracking for update of rr;
  if not found then raise exception 'Return not found' using errcode = 'P0001'; end if;
  if v_decision not in ('approve', 'reject') then raise exception 'Decision must be approve or reject' using errcode = 'P0001'; end if;
  if v_event is not null and exists (select 1 from public.return_request_events where event_key = p_store_id::text || ':rdecision:' || v_event) then
    return jsonb_build_object('returnRequestId', v_ret.id, 'status', v_ret.status, 'duplicate', true);
  end if;
  if (v_decision = 'approve' and v_ret.status in ('approved', 'received', 'refunded')) or (v_decision = 'reject' and v_ret.status = 'rejected') then
    return jsonb_build_object('returnRequestId', v_ret.id, 'status', v_ret.status, 'duplicate', true);
  end if;
  if v_ret.status <> 'requested' then raise exception 'Return is not waiting for the store' using errcode = 'P0001'; end if;

  perform set_config('elan.return_write', 'on', true);
  if v_decision = 'reject' then
    if v_reason is null then raise exception 'A rejection needs a reason' using errcode = 'P0001'; end if;
    if char_length(v_reason) > 500 then raise exception 'Reason is too long' using errcode = 'P0001'; end if;
    update public.return_requests set status = 'rejected', rejection_reason = v_reason, decided_at = now(), closed_at = now() where id = v_ret.id;
    perform private.log_return_event(v_ret.id, p_store_id, coalesce(p_store_id::text || ':rdecision:' || v_event, 'rej:' || v_ret.id::text), 'rejected', v_source, jsonb_build_object('reason', v_reason));
  else
    if nullif(btrim(coalesce(p_payload->>'pickupAt', '')), '') is null then raise exception 'A pickup time is required' using errcode = 'P0001'; end if;
    begin v_pickup := (p_payload->>'pickupAt')::timestamptz; exception when others then raise exception 'Invalid pickup time' using errcode = 'P0001'; end;
    if v_pickup < v_ret.created_at - interval '1 hour' or v_pickup > now() + interval '90 days' then raise exception 'Invalid pickup time' using errcode = 'P0001'; end if;
    if v_note is not null and char_length(v_note) > 500 then raise exception 'Reason is too long' using errcode = 'P0001'; end if;
    update public.return_requests set status = 'approved', decided_at = now(), pickup_at = v_pickup, pickup_note = v_note where id = v_ret.id;
    perform private.log_return_event(v_ret.id, p_store_id, coalesce(p_store_id::text || ':rdecision:' || v_event, 'app:' || v_ret.id::text), 'approved', v_source,
                                     jsonb_build_object('pickupAt', v_pickup, 'note', v_note));
  end if;
  perform set_config('elan.return_write', 'off', true);
  return jsonb_build_object('returnRequestId', v_ret.id, 'status', (select status from public.return_requests where id = v_ret.id), 'duplicate', false);
end; $$;

create or replace function public.record_return_receipt(p_store_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_tracking text := nullif(btrim(coalesce(p_payload->>'trackingNumber', '')), '');
  v_event text := nullif(btrim(coalesce(p_payload->>'eventId', '')), '');
  v_source text := case when p_payload->>'source' = 'store_dashboard' then 'store_dashboard' else 'merchant_api' end;
  v_note text := nullif(btrim(coalesce(p_payload->>'note', '')), '');
  v_id uuid; v_at timestamptz; v_ret public.return_requests;
begin
  if p_store_id is null or v_tracking is null then raise exception 'Return not found' using errcode = 'P0001'; end if;
  begin v_id := nullif(p_payload->>'returnRequestId', '')::uuid; exception when others then raise exception 'Return not found' using errcode = 'P0001'; end;
  select rr.* into v_ret from public.return_requests rr join public.store_order_requests r on r.id = rr.elan_order_id
   where rr.id = v_id and rr.store_id = p_store_id and r.tracking_number = v_tracking for update of rr;
  if not found then raise exception 'Return not found' using errcode = 'P0001'; end if;
  if v_event is not null and exists (select 1 from public.return_request_events where event_key = p_store_id::text || ':rreceipt:' || v_event) then
    return jsonb_build_object('returnRequestId', v_ret.id, 'status', v_ret.status, 'duplicate', true);
  end if;
  if v_ret.status in ('received', 'refunded') then return jsonb_build_object('returnRequestId', v_ret.id, 'status', v_ret.status, 'duplicate', true); end if;
  if v_ret.status <> 'approved' then raise exception 'Return is not approved' using errcode = 'P0001'; end if;
  if v_note is not null and char_length(v_note) > 500 then raise exception 'Reason is too long' using errcode = 'P0001'; end if;
  begin v_at := coalesce(nullif(p_payload->>'receivedAt', '')::timestamptz, now()); exception when others then raise exception 'Invalid time' using errcode = 'P0001'; end;
  if v_at > now() + interval '5 minutes' or v_at < v_ret.created_at then raise exception 'Invalid time' using errcode = 'P0001'; end if;
  perform set_config('elan.return_write', 'on', true);
  update public.return_requests set status = 'received', received_at = v_at where id = v_ret.id;
  perform set_config('elan.return_write', 'off', true);
  perform private.log_return_event(v_ret.id, p_store_id, coalesce(p_store_id::text || ':rreceipt:' || v_event, 'rcv:' || v_ret.id::text), 'received', v_source, jsonb_build_object('receivedAt', v_at, 'note', v_note));
  return jsonb_build_object('returnRequestId', v_ret.id, 'status', 'received', 'duplicate', false);
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. The signed refund.completed notice: the only thing that closes an approved return
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.record_refund_completed(p_store_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_tracking text := nullif(btrim(coalesce(p_payload->>'trackingNumber', '')), '');
  v_event text := nullif(btrim(coalesce(p_payload->>'eventId', '')), '');
  v_type text := lower(coalesce(nullif(btrim(p_payload->>'eventType'), ''), 'refund.completed'));
  v_status text := lower(coalesce(nullif(btrim(p_payload->>'status'), ''), 'completed'));
  v_ref text := nullif(btrim(coalesce(p_payload->>'refundReference', '')), '');
  v_mon text := nullif(btrim(coalesce(p_payload->>'merchantOrderNumber', '')), '');
  v_inv text := nullif(btrim(coalesce(p_payload->>'merchantInvoiceNumber', '')), '');
  v_method text := lower(nullif(btrim(coalesce(p_payload->>'paymentMethod', '')), ''));
  v_payref text := nullif(btrim(coalesce(p_payload->>'originalPaymentReference', '')), '');
  v_cur text := upper(coalesce(nullif(btrim(p_payload->>'currency'), ''), 'EGP'));
  v_amount numeric; v_at timestamptz; v_id uuid; v_key text; v_notice uuid;
  v_ret public.return_requests; v_req public.store_order_requests; v_mismatch jsonb := '[]'::jsonb; v_outcome text;
  v_commission public.commissions; v_effect text := 'none'; v_reversed numeric := 0;
begin
  if p_store_id is null or v_tracking is null then raise exception 'Return not found' using errcode = 'P0001'; end if;
  begin v_id := nullif(p_payload->>'returnRequestId', '')::uuid; exception when others then raise exception 'Return not found' using errcode = 'P0001'; end;
  select rr.* into v_ret from public.return_requests rr join public.store_order_requests r on r.id = rr.elan_order_id
   where rr.id = v_id and rr.store_id = p_store_id and r.tracking_number = v_tracking for update of rr;
  if not found then raise exception 'Return not found' using errcode = 'P0001'; end if;
  if v_event is null or char_length(v_event) > 200 then raise exception 'Invalid event id' using errcode = 'P0001'; end if;
  if v_type <> 'refund.completed' then raise exception 'Invalid event type' using errcode = 'P0001'; end if;
  if v_ref is null or char_length(v_ref) > 160 then raise exception 'A refund reference is required' using errcode = 'P0001'; end if;
  if v_payref is not null and char_length(v_payref) > 160 then raise exception 'Invalid payment reference' using errcode = 'P0001'; end if;
  if coalesce(p_payload->>'amount', '') !~ '^\d{1,9}(\.\d{1,2})?$' then raise exception 'Invalid amount' using errcode = 'P0001'; end if;
  v_amount := (p_payload->>'amount')::numeric;
  begin v_at := nullif(p_payload->>'occurredAt', '')::timestamptz; exception when others then raise exception 'Invalid time' using errcode = 'P0001'; end;
  v_key := p_store_id::text || ':refund:' || v_event;
  if exists (select 1 from public.return_refund_notices where event_key = v_key) then
    return jsonb_build_object('returnRequestId', v_ret.id, 'status', v_ret.status, 'duplicate', true, 'applied', false);
  end if;
  select * into v_req from public.store_order_requests where id = v_ret.elan_order_id;

  -- the same checks, one by one: every difference is named and nothing is overwritten
  if v_status <> 'completed' then v_mismatch := v_mismatch || to_jsonb('status'::text); end if;
  if v_mon is distinct from v_ret.merchant_order_number then v_mismatch := v_mismatch || to_jsonb('merchantOrderNumber'::text); end if;
  if v_inv is distinct from v_ret.merchant_invoice_number then v_mismatch := v_mismatch || to_jsonb('merchantInvoiceNumber'::text); end if;
  if v_method is distinct from v_ret.refund_method then v_mismatch := v_mismatch || to_jsonb('paymentMethod'::text); end if;
  if v_ret.payment_reference is not null and v_payref is distinct from v_ret.payment_reference then v_mismatch := v_mismatch || to_jsonb('originalPaymentReference'::text); end if;
  if v_amount <> v_ret.refund_expected_amount then v_mismatch := v_mismatch || to_jsonb('amount'::text); end if;
  if v_cur <> 'EGP' then v_mismatch := v_mismatch || to_jsonb('currency'::text); end if;

  v_outcome := case
    when v_ret.status in ('refunded', 'rejected') then 'already_closed'
    when jsonb_array_length(v_mismatch) > 0 then 'mismatch'
    when v_ret.status <> 'received' then 'not_received'
    when exists (select 1 from public.return_refund_notices where store_id = p_store_id and refund_reference = v_ref and outcome = 'applied') then 'duplicate_refund'
    else 'applied' end;

  insert into public.return_refund_notices (return_request_id, store_id, event_key, tracking_number, merchant_order_number, merchant_invoice_number, original_payment_method,
    original_payment_reference, refund_amount, currency, refund_reference, refund_status, occurred_at, outcome, mismatch_fields)
  values (v_ret.id, p_store_id, v_key, v_tracking, v_mon, v_inv, v_method, v_payref, v_amount, v_cur, v_ref, v_status, v_at, v_outcome, v_mismatch)
  returning id into v_notice;

  if v_outcome <> 'applied' then
    perform private.log_return_event(v_ret.id, p_store_id, null, case when v_outcome = 'mismatch' then 'refund_mismatch' else 'refund_ignored' end, 'merchant_api',
      jsonb_build_object('outcome', v_outcome, 'mismatches', v_mismatch, 'refundReference', v_ref));
    return jsonb_build_object('returnRequestId', v_ret.id, 'status', v_ret.status, 'duplicate', false, 'applied', false, 'outcome', v_outcome, 'mismatches', v_mismatch);
  end if;

  -- matched: close the return, then end the customer's issue (the product's value and its commission are reversed completely, only now)
  select * into v_commission from public.commissions where store_order_request_item_id = v_ret.order_item_id;
  if found then
    v_effect := case when v_commission.status = 'paid' then 'credit_due' else 'reversed' end;
    v_reversed := v_commission.amount;
  end if;
  insert into public.store_order_item_adjustments (request_id, request_item_id, adjustment_type, status, quantity, amount, currency, reason, external_reference)
  values (v_ret.elan_order_id, v_ret.order_item_id, 'return', 'completed', v_ret.quantity, v_ret.line_total, 'EGP', 'return ' || v_ret.return_number, v_ref);
  perform set_config('elan.return_write', 'on', true);
  update public.return_requests set status = 'refunded', refund_amount = v_amount, refund_reference = v_ref, refunded_at = coalesce(v_at, now()),
         refund_notice_id = v_notice, commission_effect = v_effect, commission_amount_reversed = v_reversed, closed_at = now()
   where id = v_ret.id;
  perform set_config('elan.return_write', 'off', true);
  perform private.log_return_event(v_ret.id, p_store_id, null, 'refund_completed', 'merchant_api',
    jsonb_build_object('refundReference', v_ref, 'amount', v_amount, 'method', v_method, 'commissionEffect', v_effect, 'commissionAmount', v_reversed));
  return jsonb_build_object('returnRequestId', v_ret.id, 'status', 'refunded', 'duplicate', false, 'applied', true, 'outcome', 'applied',
                            'commissionEffect', v_effect, 'mismatches', '[]'::jsonb);
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Who may call what: the server only
-- ---------------------------------------------------------------------------------------------------------------------
revoke all on function public.customer_return_eligibility(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.create_return_request_server(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.merchant_return_decision(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.record_return_receipt(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.record_refund_completed(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.customer_return_eligibility(uuid, uuid[]) to service_role;
grant execute on function public.create_return_request_server(uuid, uuid, text) to service_role;
grant execute on function public.merchant_return_decision(uuid, jsonb) to service_role;
grant execute on function public.record_return_receipt(uuid, jsonb) to service_role;
grant execute on function public.record_refund_completed(uuid, jsonb) to service_role;
revoke all on function private.return_window_days(uuid), private.return_window_start(uuid), private.return_block_reason(uuid),
  private.log_return_event(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;

commit;
