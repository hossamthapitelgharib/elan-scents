-- Phase 2 of the purchase redesign (docs/implementation-phase-2-payment-merchant-shipping.ar.md): merchant approval, payment, the two notices, shipping.
--
-- Order of an order:
--   1. the merchant approves (or rejects with a reason)           -> approved_at, the payment terms (amount + the methods offered) are fixed
--   2. the customer chooses one of the merchant's payment methods  -> card: a payment attempt that a signed event settles; cash on delivery: recorded at once
--   3. a TRUSTED payment result (signed event, or the cash-on-delivery choice) -> payment recorded, the FIRST immutable platform notice is written,
--      and the paid lines (only those) leave the customer's cart, once
--   4. the merchant's signed notice is matched against the platform notice -> only a successful match records the merchant's order number,
--      invoice number and payment reference; a difference is recorded and never overwrites what is already recorded
--   5. shipping events (signed) are logged with carrier, waybill, status and time; shipping needs a recorded payment
--   6. a delivered event with a waybill is the documented receipt: it starts the sale proof and the return window (no customer confirmation)
-- The browser's return from a payment page is display-only: nothing in this migration lets a browser mark an order paid.
begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.phase2_touch()
returns trigger language plpgsql set search_path to 'pg_temp' as $$
begin new.updated_at := now(); return new; end; $$;

create or replace function private.forbid_change()
returns trigger language plpgsql set search_path to 'pg_temp' as $$
begin raise exception 'This record is append-only and is never changed or removed' using errcode = 'P0001'; end; $$;

create or replace function private.payment_executed(p_status text)
returns boolean language sql immutable set search_path to 'pg_temp' as $$ select p_status in ('paid', 'cod_selected') $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The merchant's payment methods (public data only: no key, no secret, no card data ever)
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists public.store_payment_methods (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  kind text not null check (kind in ('card', 'cod', 'other')),
  mode text not null default 'redirect' check (mode in ('redirect', 'hosted', 'none')),
  provider text not null default 'merchant' check (char_length(btrim(provider)) between 1 and 60),
  label_ar text not null check (char_length(btrim(label_ar)) between 1 and 80),
  label_en text check (label_en is null or char_length(label_en) <= 80),
  redirect_url text check (redirect_url is null or (char_length(redirect_url) <= 500 and redirect_url ~* '^https://[^[:space:]/?#@]+(/[^[:space:]]*)?$')),
  hosted_config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, kind, provider),
  constraint store_payment_methods_cod_has_no_page check (kind <> 'cod' or (mode = 'none' and redirect_url is null)),
  constraint store_payment_methods_online_has_page check (kind = 'cod' or (mode <> 'none' and redirect_url is not null)),
  constraint store_payment_methods_hosted_is_public check (
    jsonb_typeof(hosted_config) = 'object' and pg_column_size(hosted_config) <= 4000
    and hosted_config::text !~* '(secret|private|password|passwd|card_?number|cvv|cvc|pan)')
);
comment on table public.store_payment_methods is 'The payment methods a merchant offers inside the Elan experience. Page addresses and public settings only: a card is paid on the merchant''s or the provider''s own page, so card data never reaches Elan.';
create or replace trigger store_payment_methods_touch before update on public.store_payment_methods
  for each row execute function private.phase2_touch();
alter table public.store_payment_methods enable row level security;
create policy store_payment_methods_admin_all on public.store_payment_methods for all to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());
-- Like every order table, the payment tables are reached by the server (service_role) only: a browser token has no grant on them.
revoke all on public.store_payment_methods from anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The order's payment terms and result
-- ---------------------------------------------------------------------------------------------------------------------
alter table public.store_order_requests
  add column if not exists approved_at timestamptz,
  add column if not exists payable_amount numeric(12,2),
  add column if not exists payment_options jsonb,
  add column if not exists payment_status text not null default 'not_started',
  add column if not exists payment_method text,
  add column if not exists payment_provider text,
  add column if not exists payment_reference text,
  add column if not exists paid_at timestamptz,
  add column if not exists cart_cleared_at timestamptz,
  add column if not exists sale_proven_at timestamptz;
alter table public.store_order_requests
  add constraint store_order_requests_payment_status_check check (payment_status in ('not_started', 'awaiting_payment', 'paid', 'cod_selected', 'failed')),
  add constraint store_order_requests_payment_method_check check (payment_method is null or payment_method in ('card', 'cod', 'other')),
  add constraint store_order_requests_payable_check check (payable_amount is null or payable_amount >= 0),
  add constraint store_order_requests_payment_reference_len check (payment_reference is null or char_length(payment_reference) between 1 and 160);
comment on column public.store_order_requests.payment_status is 'not_started | awaiting_payment (a card attempt is open) | paid (a signed provider event settled it) | cod_selected (cash on delivery chosen) | failed. Written only by the payment functions.';
comment on column public.store_order_requests.cart_cleared_at is 'When the paid lines of this order left the customer''s cart. Set once, in the same transaction as the trusted payment result.';
comment on column public.store_order_requests.sale_proven_at is 'When delivery was documented (a signed delivered event with a waybill, or a platform check): the start of the sale proof and of the return window.';

-- Payment fields are written only by the payment functions; the approved terms are fixed.
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
create or replace trigger guard_payment_fields before update on public.store_order_requests
  for each row execute function private.guard_payment_fields();

-- The moment the merchant approves, the amount to pay and the methods offered are frozen on the order.
create or replace function private.store_payment_options(p_store_id uuid)
returns jsonb language sql stable security definer set search_path to 'public', 'private', 'pg_temp' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'mode', m.mode, 'provider', m.provider,
           'labelAr', m.label_ar, 'labelEn', m.label_en, 'redirectUrl', m.redirect_url, 'hostedConfig', m.hosted_config)
         order by m.sort_order, m.created_at, m.id), '[]'::jsonb)
  from public.store_payment_methods m where m.store_id = p_store_id and m.enabled;
$$;

create or replace function private.order_approval_stamp()
returns trigger language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
begin
  if new.status = 'store_confirmed' and old.status is distinct from 'store_confirmed' and old.approved_at is null then
    if new.payment_options is null then new.payment_options := private.store_payment_options(new.store_id); end if;
    if jsonb_typeof(new.payment_options) is distinct from 'array' or jsonb_array_length(new.payment_options) = 0 then
      raise exception 'Configure a payment method before approving orders' using errcode = 'P0001';
    end if;
    new.payable_amount := coalesce(new.total_amount, new.subtotal + coalesce(new.shipping_amount, 0));
    new.total_amount := new.payable_amount;
    new.approved_at := now();
  end if;
  return new;
end; $$;
create or replace trigger order_approval_stamp before update on public.store_order_requests
  for each row execute function private.order_approval_stamp();

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Payment attempts, the signed payment events, the first platform notice, the shipping events
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists public.order_payments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.store_order_requests(id),
  store_id uuid not null references public.stores(id),
  user_id uuid,
  method_kind text not null check (method_kind in ('card', 'cod', 'other')),
  mode text not null check (mode in ('redirect', 'hosted', 'none')),
  provider text not null,
  status text not null check (status in ('initiated', 'paid', 'failed', 'cancelled', 'cod_selected')),
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'EGP' check (currency = 'EGP'),
  provider_transaction_id text check (provider_transaction_id is null or char_length(provider_transaction_id) between 1 and 160),
  payment_reference text check (payment_reference is null or char_length(payment_reference) between 1 and 160),
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 200),
  failure_reason text check (failure_reason is null or char_length(failure_reason) <= 500),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists order_payments_one_settled_idx on public.order_payments(request_id) where status in ('paid', 'cod_selected');
create unique index if not exists order_payments_provider_txn_idx on public.order_payments(provider, provider_transaction_id) where provider_transaction_id is not null;
create index if not exists order_payments_request_idx on public.order_payments(request_id, created_at desc);
create index if not exists order_payments_store_idx on public.order_payments(store_id);
create or replace trigger order_payments_touch before update on public.order_payments
  for each row execute function private.phase2_touch();

create table if not exists public.order_payment_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.store_order_requests(id),
  payment_id uuid references public.order_payments(id),
  store_id uuid not null references public.stores(id),
  provider text not null,
  event_id text not null check (char_length(event_id) between 1 and 200),
  event_type text not null check (event_type in ('payment.succeeded', 'payment.failed')),
  provider_transaction_id text,
  payment_reference text,
  amount numeric(12,2),
  currency text,
  occurred_at timestamptz,
  idempotency_key text not null unique,
  payload_hash text not null,
  outcome text not null check (outcome in ('applied', 'failed_recorded', 'duplicate_payment', 'amount_mismatch', 'currency_mismatch', 'state_rejected')),
  received_at timestamptz not null default now()
);
create index if not exists order_payment_events_request_idx on public.order_payment_events(request_id, received_at desc);
create or replace trigger order_payment_events_append_only before update or delete on public.order_payment_events
  for each row execute function private.forbid_change();

create table if not exists public.platform_order_notices (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.store_order_requests(id),
  store_id uuid not null references public.stores(id),
  tracking_number text not null,
  idempotency_key text not null unique,
  payload jsonb not null,
  payload_hash text not null,
  created_at timestamptz not null default now()
);
comment on table public.platform_order_notices is 'The FIRST notice: written once, by the platform, after the trusted payment result of the order. Immutable. The merchant''s own notice is matched against it.';
create or replace trigger platform_order_notices_append_only before update or delete on public.platform_order_notices
  for each row execute function private.forbid_change();

create table if not exists public.store_shipment_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.store_order_requests(id),
  store_id uuid not null references public.stores(id),
  event_key text not null unique,
  carrier_name text,
  tracking_code text,
  shipping_status text not null check (shipping_status in ('preparing', 'handed_to_carrier', 'in_transit', 'out_for_delivery', 'delivered', 'delayed', 'returned', 'cancelled')),
  occurred_at timestamptz not null default now(),
  source text not null check (source in ('merchant_api', 'merchant_notice', 'store_dashboard', 'platform_admin')),
  note text,
  created_at timestamptz not null default now()
);
create index if not exists store_shipment_events_request_idx on public.store_shipment_events(request_id, occurred_at, created_at);
create index if not exists store_shipment_events_store_idx on public.store_shipment_events(store_id);
create or replace trigger store_shipment_events_append_only before update or delete on public.store_shipment_events
  for each row execute function private.forbid_change();

alter table public.order_payments enable row level security;
alter table public.order_payment_events enable row level security;
alter table public.platform_order_notices enable row level security;
alter table public.store_shipment_events enable row level security;
create policy order_payments_admin_all on public.order_payments for all to authenticated using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy order_payment_events_admin_all on public.order_payment_events for all to authenticated using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy platform_order_notices_admin_all on public.platform_order_notices for all to authenticated using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy store_shipment_events_admin_all on public.store_shipment_events for all to authenticated using (private.is_platform_admin()) with check (private.is_platform_admin());
revoke all on public.order_payments, public.order_payment_events, public.platform_order_notices, public.store_shipment_events from anon, authenticated;

-- Shipping needs a recorded payment, and every change of a shipment is logged whoever made it.
create or replace function private.guard_shipping_requires_payment()
returns trigger language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
begin
  if new.shipping_status in ('handed_to_carrier', 'in_transit', 'out_for_delivery', 'delivered', 'delayed', 'returned')
     and not exists (select 1 from public.store_order_requests r where r.id = new.request_id and private.payment_executed(r.payment_status)) then
    raise exception 'Payment is required before shipping' using errcode = 'P0001';
  end if;
  return new;
end; $$;
create or replace trigger guard_shipping_requires_payment before insert or update on public.store_shipments
  for each row execute function private.guard_shipping_requires_payment();

create or replace function private.log_shipment_event()
returns trigger language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_ctx text := nullif(current_setting('elan.shipment_event', true), ''); v_parts text[]; v_key text; v_source text; v_at timestamptz;
begin
  -- A change made outside the event functions that moves nothing is not an event; a reported event is always logged.
  if tg_op = 'UPDATE' and v_ctx is null and new.shipping_status is not distinct from old.shipping_status
     and new.carrier_name is not distinct from old.carrier_name and new.tracking_code is not distinct from old.tracking_code then
    return new;
  end if;
  if v_ctx is not null then
    v_parts := string_to_array(v_ctx, '|');
    v_key := v_parts[1]; v_source := coalesce(v_parts[2], 'store_dashboard');
    begin v_at := nullif(v_parts[3], '')::timestamptz; exception when others then v_at := null; end;
  end if;
  v_key := coalesce(v_key, 'auto:' || md5(new.request_id::text || '|' || new.shipping_status || '|' || coalesce(new.carrier_name, '') || '|' || coalesce(new.tracking_code, '') || '|' || clock_timestamp()::text));
  insert into public.store_shipment_events (request_id, store_id, event_key, carrier_name, tracking_code, shipping_status, occurred_at, source, note)
  values (new.request_id, new.store_id, v_key, new.carrier_name, new.tracking_code, new.shipping_status, coalesce(v_at, now()),
          case when v_source in ('merchant_api', 'merchant_notice', 'store_dashboard', 'platform_admin') then v_source else 'store_dashboard' end, new.status_note)
  on conflict (event_key) do nothing;
  return new;
end; $$;
create or replace trigger log_shipment_event after insert or update on public.store_shipments
  for each row execute function private.log_shipment_event();

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The first platform notice, and the paid lines leaving the cart (both once, in the transaction of the trusted result)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.finalize_payment(p_request_id uuid)
returns void language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_req public.store_order_requests; v_payload jsonb; v_notice uuid; v_store_name text; v_paid boolean;
begin
  select * into v_req from public.store_order_requests where id = p_request_id for update;
  if not found or not private.payment_executed(v_req.payment_status) then return; end if;
  v_paid := v_req.payment_status = 'paid';
  select name into v_store_name from public.stores where id = v_req.store_id;
  v_payload := jsonb_build_object(
    'type', 'platform_order_notice', 'version', 1,
    'elanOrderId', v_req.id, 'trackingNumber', v_req.tracking_number, 'checkoutTrackingNumber', v_req.checkout_tracking_number,
    'store', jsonb_build_object('id', v_req.store_id, 'name', v_store_name),
    'customerId', v_req.user_id, 'customer', v_req.customer_snapshot,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('lineId', i.id, 'platformOrderNumber', i.platform_order_number,
                'productSizeId', i.product_size_id, 'productName', i.product_name, 'brandName', i.brand_name, 'sizeLabel', i.size_label,
                'quantity', i.quantity, 'unitPrice', i.unit_price, 'lineTotal', i.line_total) order by i.created_at, i.id), '[]'::jsonb)
              from public.store_order_request_items i where i.request_id = v_req.id),
    'subtotal', v_req.subtotal, 'shipping', v_req.shipping_amount, 'total', v_req.payable_amount, 'currency', v_req.currency,
    'payment', jsonb_build_object('method', v_req.payment_method, 'provider', v_req.payment_provider,
                'status', case when v_paid then 'paid' else 'cash_on_delivery' end,
                'reference', v_req.payment_reference, 'paidAt', v_req.paid_at),
    'createdAt', now());
  insert into public.platform_order_notices (request_id, store_id, tracking_number, idempotency_key, payload, payload_hash)
  values (v_req.id, v_req.store_id, v_req.tracking_number, 'platform-notice:' || v_req.id::text, v_payload,
          encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex'))
  on conflict (request_id) do nothing returning id into v_notice;
  if v_notice is null then return; end if;

  -- The paid lines leave the cart: the customer's lines for the products of THIS order, by the quantity ordered, once.
  if v_req.user_id is not null and v_req.cart_cleared_at is null then
    delete from public.cart_items ci using (
      select i.store_product_id, sum(i.quantity)::integer as q from public.store_order_request_items i
      where i.request_id = v_req.id and i.store_product_id is not null group by i.store_product_id) o
    where ci.user_id = v_req.user_id and ci.store_product_id = o.store_product_id and ci.quantity <= o.q;
    update public.cart_items ci set quantity = ci.quantity - o.q from (
      select i.store_product_id, sum(i.quantity)::integer as q from public.store_order_request_items i
      where i.request_id = v_req.id and i.store_product_id is not null group by i.store_product_id) o
    where ci.user_id = v_req.user_id and ci.store_product_id = o.store_product_id and ci.quantity > o.q;
    perform set_config('elan.pay_write', 'on', true);
    update public.store_order_requests set cart_cleared_at = now() where id = v_req.id;
    perform set_config('elan.pay_write', 'off', true);
  end if;

  perform public.emit_order_notification(
    (select r from public.store_order_requests r where r.id = v_req.id),
    case when v_paid then 'order_payment_recorded' else 'order_cod_selected' end,
    case when v_paid then 'تم تسجيل الدفع' else 'تم اختيار الدفع عند الاستلام' end,
    case when v_paid then 'سُجّل دفع الطلب ' || v_req.tracking_number || ' وأُرسل إشعار المنصة الأول.'
         else 'اختار العميل الدفع عند الاستلام للطلب ' || v_req.tracking_number || ' وأُرسل إشعار المنصة الأول.' end,
    jsonb_build_object('trackingNumber', v_req.tracking_number, 'paymentMethod', v_req.payment_method, 'paymentReference', v_req.payment_reference));
end; $$;

create or replace function private.payment_instructions(p_payment public.order_payments, p_req public.store_order_requests)
returns jsonb language sql stable security definer set search_path to 'public', 'private', 'pg_temp' as $$
  select jsonb_build_object('paymentId', p_payment.id, 'elanOrderId', p_req.id, 'trackingNumber', p_req.tracking_number,
    'kind', p_payment.method_kind, 'mode', p_payment.mode, 'provider', p_payment.provider, 'status', p_payment.status,
    'amount', p_payment.amount, 'currency', p_payment.currency,
    'redirectUrl', (select o->>'redirectUrl' from jsonb_array_elements(coalesce(p_req.payment_options, '[]'::jsonb)) o
                    where o->>'kind' = p_payment.method_kind and o->>'provider' = p_payment.provider limit 1),
    'paymentStatus', p_req.payment_status);
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The merchant's decision (the adapter's approval / rejection), scoped to the merchant's own store
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.merchant_review_order(p_store_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_tracking text := nullif(btrim(coalesce(p_payload->>'trackingNumber', '')), '');
  v_decision text := lower(coalesce(p_payload->>'decision', ''));
  v_reason text := nullif(btrim(coalesce(p_payload->>'reason', '')), '');
  v_req public.store_order_requests;
  v_ship numeric; v_total numeric; v_options jsonb; v_m jsonb; v_kind text; v_mode text; v_url text; v_n integer := 0; v_event text := nullif(btrim(coalesce(p_payload->>'eventId', '')), '');
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
    if p_payload ? 'shipping' and p_payload->>'shipping' !~ '^\d{1,9}(\.\d{1,2})?$' then raise exception 'Invalid shipping amount' using errcode = 'P0001'; end if;
    if p_payload ? 'total' and p_payload->>'total' !~ '^\d{1,9}(\.\d{1,2})?$' then raise exception 'Invalid total amount' using errcode = 'P0001'; end if;
    v_ship := case when p_payload ? 'shipping' then (p_payload->>'shipping')::numeric end;
    v_total := case when p_payload ? 'total' then (p_payload->>'total')::numeric end;
    if v_total is not null and v_total < v_req.subtotal then raise exception 'Total is below the products total' using errcode = 'P0001'; end if;
    if p_payload ? 'paymentMethods' then
      if jsonb_typeof(p_payload->'paymentMethods') is distinct from 'array' or jsonb_array_length(p_payload->'paymentMethods') not between 1 and 5 then
        raise exception 'Invalid payment methods' using errcode = 'P0001';
      end if;
      v_options := '[]'::jsonb;
      for v_m in select * from jsonb_array_elements(p_payload->'paymentMethods') loop
        v_kind := lower(coalesce(v_m->>'kind', '')); v_mode := lower(coalesce(v_m->>'mode', case when v_kind = 'cod' then 'none' else 'redirect' end)); v_url := nullif(btrim(coalesce(v_m->>'redirectUrl', '')), '');
        if v_kind not in ('card', 'cod', 'other') or v_mode not in ('redirect', 'hosted', 'none')
           or (v_kind = 'cod' and (v_mode <> 'none' or v_url is not null))
           or (v_kind <> 'cod' and (v_mode = 'none' or v_url is null or v_url !~* '^https://[^[:space:]/?#@]+(/[^[:space:]]*)?$' or char_length(v_url) > 500))
           or char_length(btrim(coalesce(v_m->>'labelAr', ''))) not between 1 and 80 then
          raise exception 'Invalid payment method' using errcode = 'P0001';
        end if;
        v_options := v_options || jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'kind', v_kind, 'mode', v_mode,
          'provider', coalesce(nullif(btrim(v_m->>'provider'), ''), 'merchant'), 'labelAr', btrim(v_m->>'labelAr'),
          'labelEn', nullif(btrim(coalesce(v_m->>'labelEn', '')), ''), 'redirectUrl', v_url, 'hostedConfig', '{}'::jsonb));
        v_n := v_n + 1;
      end loop;
    end if;
    update public.store_order_requests set status = 'store_confirmed', updated_at = now(),
      shipping_amount = coalesce(v_ship, shipping_amount), total_amount = coalesce(v_total, total_amount),
      payment_options = coalesce(v_options, payment_options)
    where id = v_req.id;
  end if;

  insert into public.store_order_notifications (request_id, tracking_number, event_type, store_status, match_status, payload, idempotency_key)
  values (v_req.id, v_tracking, 'store_update', case when v_decision = 'approve' then 'confirmed' else 'rejected' end, 'pending',
          jsonb_build_object('type', 'merchant_decision', 'decision', v_decision, 'reason', v_reason), case when v_event is not null then p_store_id::text || ':decision:' || v_event end);
  return jsonb_build_object('trackingNumber', v_tracking, 'status', (select status from public.store_order_requests where id = v_req.id), 'duplicate', false,
                            'payableAmount', (select payable_amount from public.store_order_requests where id = v_req.id));
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. The customer chooses how to pay (never marks anything paid by card)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.select_order_payment_server(p_request_id uuid, p_user_id uuid, p_method_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_req public.store_order_requests; v_opt jsonb; v_pay public.order_payments; v_key text; v_kind text;
begin
  if p_user_id is null then raise exception 'Authentication required' using errcode = 'P0001'; end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'Invalid retry key' using errcode = 'P0001'; end if;
  select * into v_req from public.store_order_requests where id = p_request_id for update;
  if not found or v_req.user_id is distinct from p_user_id then raise exception 'Order not found' using errcode = 'P0001'; end if;
  v_key := p_request_id::text || ':' || p_idempotency_key;
  select * into v_pay from public.order_payments where idempotency_key = v_key;
  if found then return private.payment_instructions(v_pay, v_req); end if;
  if v_req.status <> 'store_confirmed' or v_req.approved_at is null then raise exception 'Order is not approved for payment' using errcode = 'P0001'; end if;
  if private.payment_executed(v_req.payment_status) then raise exception 'Payment is already settled' using errcode = 'P0001'; end if;
  if v_req.currency is distinct from 'EGP' then raise exception 'Only EGP orders are supported' using errcode = 'P0001'; end if;
  if v_req.payable_amount is null or v_req.payable_amount <= 0 then raise exception 'Order has no payable amount' using errcode = 'P0001'; end if;
  select o into v_opt from jsonb_array_elements(coalesce(v_req.payment_options, '[]'::jsonb)) o where o->>'id' = p_method_id::text;
  if v_opt is null then raise exception 'Payment method is not offered for this order' using errcode = 'P0001'; end if;
  v_kind := v_opt->>'kind';

  update public.order_payments set status = 'cancelled', updated_at = now() where request_id = p_request_id and status = 'initiated';
  insert into public.order_payments (request_id, store_id, user_id, method_kind, mode, provider, status, amount, currency, idempotency_key, paid_at)
  values (v_req.id, v_req.store_id, p_user_id, v_kind, v_opt->>'mode', coalesce(v_opt->>'provider', 'merchant'),
          case when v_kind = 'cod' then 'cod_selected' else 'initiated' end, v_req.payable_amount, 'EGP', v_key, null)
  returning * into v_pay;

  perform set_config('elan.pay_write', 'on', true);
  update public.store_order_requests set payment_status = case when v_kind = 'cod' then 'cod_selected' else 'awaiting_payment' end,
         payment_method = v_kind, payment_provider = v_pay.provider, updated_at = now() where id = v_req.id;
  perform set_config('elan.pay_write', 'off', true);
  if v_kind = 'cod' then perform private.finalize_payment(v_req.id); end if;
  select * into v_req from public.store_order_requests where id = v_req.id;
  return private.payment_instructions(v_pay, v_req);
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. The signed payment event (the only way a card payment becomes "paid")
-- ---------------------------------------------------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Shipping: the signed event, and the documented receipt
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.apply_delivery_proof(p_request_id uuid, p_reference text default null)
returns void language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_req public.store_order_requests; v_ship public.store_shipments;
begin
  select * into v_req from public.store_order_requests where id = p_request_id for update;
  select * into v_ship from public.store_shipments where request_id = p_request_id for update;
  if v_req.id is null or v_ship.id is null or not private.payment_executed(v_req.payment_status) then return; end if;
  if v_ship.shipping_status <> 'delivered' or v_ship.delivered_at is null or nullif(btrim(coalesce(v_ship.tracking_code, '')), '') is null then return; end if;
  if v_ship.delivery_verified_at is null then
    update public.store_shipments set delivery_verified_at = now(), delivery_verification_source = 'carrier_api',
           delivery_verification_reference = left(coalesce(p_reference, 'waybill:' || v_ship.tracking_code), 200) where id = v_ship.id;
  end if;
  if v_req.sale_proven_at is null then
    perform set_config('elan.pay_write', 'on', true);
    update public.store_order_requests set sale_proven_at = v_ship.delivered_at, updated_at = now() where id = v_req.id;
    perform set_config('elan.pay_write', 'off', true);
  end if;
end; $$;

create or replace function public.record_shipment_event(p_store_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_tracking text := nullif(btrim(coalesce(p_payload->>'trackingNumber', '')), '');
  v_event text := nullif(btrim(coalesce(p_payload->>'eventId', '')), '');
  v_status text := lower(coalesce(p_payload->>'status', ''));
  v_carrier text := nullif(btrim(coalesce(p_payload->>'carrier', '')), '');
  v_code text := nullif(btrim(coalesce(p_payload->>'trackingCode', p_payload->>'waybill', '')), '');
  v_note text := nullif(btrim(coalesce(p_payload->>'note', '')), '');
  v_at timestamptz; v_eta timestamptz; v_key text;
  v_req public.store_order_requests; v_cur public.store_shipments;
begin
  if p_store_id is null or v_tracking is null then raise exception 'Order not found' using errcode = 'P0001'; end if;
  select * into v_req from public.store_order_requests where tracking_number = v_tracking and store_id = p_store_id for update;
  if not found then raise exception 'Order not found' using errcode = 'P0001'; end if;
  if v_event is null or char_length(v_event) > 200 then raise exception 'Invalid event id' using errcode = 'P0001'; end if;
  if v_status not in ('preparing', 'handed_to_carrier', 'in_transit', 'out_for_delivery', 'delivered', 'delayed', 'returned', 'cancelled') then raise exception 'Invalid shipping status' using errcode = 'P0001'; end if;
  if (v_carrier is not null and char_length(v_carrier) > 120) or (v_code is not null and char_length(v_code) > 160) or (v_note is not null and char_length(v_note) > 500) then raise exception 'Shipment data is too long' using errcode = 'P0001'; end if;
  begin v_at := coalesce(nullif(p_payload->>'occurredAt', '')::timestamptz, now()); v_eta := nullif(p_payload->>'estimatedDeliveryAt', '')::timestamptz; exception when others then raise exception 'Invalid time' using errcode = 'P0001'; end;
  v_key := p_store_id::text || ':' || v_event;
  if exists (select 1 from public.store_shipment_events where event_key = v_key) then
    return jsonb_build_object('trackingNumber', v_tracking, 'shippingStatus', (select shipping_status from public.store_shipments where request_id = v_req.id), 'duplicate', true);
  end if;
  if v_req.status in ('awaiting_store_confirmation', 'store_rejected', 'store_cancelled', 'cancelled', 'restored') then raise exception 'Order is not shippable' using errcode = 'P0001'; end if;
  if v_status <> 'preparing' and not private.payment_executed(v_req.payment_status) then raise exception 'Payment is required before shipping' using errcode = 'P0001'; end if;
  select * into v_cur from public.store_shipments where request_id = v_req.id for update;
  -- (FOUND is not used below: set_config through PERFORM would overwrite it.)
  if v_cur.id is not null and not private.can_shipping_transition(v_cur.shipping_status, v_status) then raise exception 'Invalid shipping transition' using errcode = 'P0001'; end if;
  -- Carrier and waybill count once merged with what the shipment already carries.
  if v_status in ('handed_to_carrier', 'in_transit', 'out_for_delivery', 'delivered')
     and (coalesce(v_code, nullif(btrim(coalesce(v_cur.tracking_code, '')), '')) is null
          or coalesce(v_carrier, nullif(btrim(coalesce(v_cur.carrier_name, '')), '')) is null) then
    raise exception 'Carrier and waybill are required' using errcode = 'P0001';
  end if;

  perform set_config('elan.shipment_event', v_key || '|merchant_api|' || v_at::text, true);
  if v_cur.id is null then
    insert into public.store_shipments (request_id, store_id, carrier_name, tracking_code, shipping_status, status_note, estimated_delivery_at, delivered_at)
    values (v_req.id, v_req.store_id, v_carrier, v_code, v_status, v_note, v_eta, case when v_status = 'delivered' then v_at end);
  else
    update public.store_shipments set carrier_name = coalesce(v_carrier, carrier_name), tracking_code = coalesce(v_code, tracking_code),
           shipping_status = v_status, status_note = coalesce(v_note, status_note), estimated_delivery_at = coalesce(v_eta, estimated_delivery_at),
           delivered_at = case when v_status = 'delivered' then coalesce(delivered_at, v_at) else delivered_at end, updated_at = now()
    where id = v_cur.id;
  end if;
  perform set_config('elan.shipment_event', '', true);
  if v_status = 'delivered' then perform private.apply_delivery_proof(v_req.id, 'event:' || v_key); end if;
  return jsonb_build_object('trackingNumber', v_tracking, 'shippingStatus', v_status, 'duplicate', false,
                            'orderStatus', (select status from public.store_order_requests where id = v_req.id),
                            'saleProven', (select sale_proven_at is not null from public.store_order_requests where id = v_req.id));
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. The merchant's signed notice, matched against the platform notice (replaces the earlier matcher; same name and signature)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.receive_store_order_notification(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private' as $function$
declare
  v_tracking text := coalesce(p_payload->>'trackingNumber', p_payload->>'orderNumber');
  v_idempotency text := nullif(p_payload->>'idempotencyKey','');
  v_request public.store_order_requests;
  v_updated public.store_order_requests;
  v_existing public.store_order_notifications;
  v_status text := lower(coalesce(p_payload->>'status',''));
  v_match boolean := true;
  v_mismatches jsonb := '[]'::jsonb;
  v_items jsonb := case when jsonb_typeof(p_payload->'items') = 'array' then p_payload->'items' else '[]'::jsonb end;
  v_expected_count integer;
  v_received_count integer;
  v_event_type text;
  v_match_status text;
  v_new_status text;
  v_apply_inventory boolean := false;
  v_completed_like boolean := v_status in ('completed','success','succeeded','paid','confirmed');
  v_rejected_like boolean := v_status in ('rejected','failed','cancelled','not_completed','declined');
  v_complete boolean;
  v_has_commission boolean;
  v_ref text := coalesce(nullif(trim(coalesce(p_payload->>'merchantOrderNumber','')),''), nullif(trim(coalesce(p_payload->>'storeOrderReference','')),''));
  v_inv text := nullif(trim(coalesce(p_payload->>'merchantInvoiceNumber','')),'');
  v_payref text := nullif(trim(coalesce(p_payload->>'paymentReference','')),'');
  v_ref_taken boolean := false;
  v_notice public.platform_order_notices;
  v_ship jsonb := case when jsonb_typeof(p_payload->'shipment') = 'object' then p_payload->'shipment' else null end;
  v_ship_status text;
  v_ship_ok boolean := false;
  v_ship_carrier text;
  v_ship_code text;
  v_ship_eta timestamptz;
  v_current_ship public.store_shipments;
  v_customer jsonb := case when jsonb_typeof(p_payload->'customer') = 'object' then p_payload->'customer' else null end;
begin
  if v_tracking is null or v_tracking = '' then
    raise exception 'Missing tracking number';
  end if;

  select * into v_request
  from public.store_order_requests
  where tracking_number = v_tracking
  for update;
  if not found then
    raise exception 'Order not found for tracking number %', v_tracking;
  end if;

  if v_idempotency is not null then
    select * into v_existing
    from public.store_order_notifications
    where idempotency_key = v_idempotency
    limit 1;
    if found then
      return jsonb_build_object(
        'trackingNumber', v_existing.tracking_number,
        'matched', v_existing.match_status = 'matched',
        'status', case when v_existing.match_status = 'matched'
          and v_existing.store_status in ('completed','success','succeeded','paid','confirmed')
          then 'completed' else v_request.status end,
        'mismatches', coalesce(v_existing.mismatch_fields,'[]'::jsonb),
        'inventoryApplied', v_request.inventory_applied_at is not null,
        'duplicate', true
      );
    end if;
  end if;

  select count(*) into v_expected_count
  from public.store_order_request_items
  where request_id = v_request.id;
  select jsonb_array_length(v_items) into v_received_count;
  if v_expected_count <> v_received_count then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('items.length');
  end if;

  if exists (
    select 1
    from public.store_order_request_items i
    where i.request_id = v_request.id
      and not exists (
        select 1
        from jsonb_array_elements(v_items) j
        where nullif(j->>'productSizeId','')::uuid = i.product_size_id
          and (j->>'quantity')::integer = i.quantity
          and (j->>'unitPrice')::numeric = i.unit_price
          and coalesce(j->>'currency','EGP') = i.currency
          and (j->>'total')::numeric = i.line_total
          and j->>'platformOrderNumber' = i.platform_order_number
      )
  ) then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('items');
  end if;

  if (p_payload->>'subtotal')::numeric is distinct from v_request.subtotal then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('subtotal');
  end if;
  -- Shipping and total are the merchant's own display amounts. They are compared with an earlier ACCEPTED report only:
  -- a report that was held for review can be corrected with different amounts.
  if p_payload ? 'shipping' and v_request.shipping_amount is not null and v_request.status = 'completed'
     and (p_payload->>'shipping')::numeric is distinct from v_request.shipping_amount then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('shipping');
  end if;
  if p_payload ? 'total' and v_request.total_amount is not null and v_request.status = 'completed'
     and (p_payload->>'total')::numeric is distinct from v_request.total_amount then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('total');
  end if;
  -- The total the customer was asked to pay is fixed at approval: the merchant's notice must repeat it.
  if p_payload ? 'total' and v_request.payable_amount is not null
     and (p_payload->>'total')::numeric is distinct from v_request.payable_amount and not v_mismatches ? 'total' then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('total');
  end if;
  if upper(coalesce(nullif(p_payload->>'currency',''), 'EGP')) <> 'EGP' then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('currency');
  end if;

  if v_customer is null or coalesce(trim(v_customer->>'name'),'') = '' or coalesce(trim(v_customer->>'phone'),'') = ''
     or coalesce(trim(v_customer->>'address'),'') = '' then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('customer');
  elsif right(regexp_replace(coalesce(v_customer->>'phone',''), '\D', '', 'g'), 9)
        is distinct from right(regexp_replace(coalesce(v_request.customer_phone,''), '\D', '', 'g'), 9) then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('customer.phone');
  end if;
  if nullif(v_customer->>'id', '') is not null and ((v_customer->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_request.user_id is null or (v_customer->>'id')::uuid is distinct from v_request.user_id) then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('customer.id');
  end if;

  if v_ship is not null then
    v_ship_status := coalesce(nullif(v_ship->>'status',''), 'preparing');
    v_ship_carrier := nullif(trim(coalesce(v_ship->>'carrier','')), '');
    v_ship_code := nullif(trim(coalesce(v_ship->>'trackingCode','')), '');
    if v_ship_status not in ('preparing','handed_to_carrier','in_transit','out_for_delivery','delivered','delayed','returned','cancelled') then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('shipment.status');
    elsif v_ship_status in ('handed_to_carrier','in_transit','out_for_delivery','delivered') and v_ship_code is null then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('shipment.trackingCode');
    elsif v_ship_status <> 'preparing' and not private.payment_executed(v_request.payment_status) then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('shipment.payment_required');
    else
      v_ship_ok := true;
    end if;
    begin
      v_ship_eta := nullif(v_ship->>'estimatedDeliveryAt','')::timestamptz;
    exception when others then
      v_ship_eta := null;
    end;
  end if;

  if v_completed_like then
    select * into v_notice from public.platform_order_notices where request_id = v_request.id;
    if not found then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('platform_notice_missing');
    end if;
    if v_ref is null then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('merchantOrderNumber');
    elsif v_request.merchant_order_number is not null and v_ref is distinct from v_request.merchant_order_number then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('merchantOrderNumber.conflict');
    end if;
    if v_inv is null then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('merchantInvoiceNumber');
    elsif v_request.merchant_invoice_number is not null and v_inv is distinct from v_request.merchant_invoice_number then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('merchantInvoiceNumber.conflict');
    end if;
    if v_request.payment_status = 'paid' then
      if v_payref is distinct from v_request.payment_reference then
        v_match := false;
        v_mismatches := v_mismatches || jsonb_build_array('paymentReference');
      end if;
    elsif v_request.payment_status <> 'cod_selected' then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('payment_not_recorded');
    end if;
    if exists (
      select nullif(trim(j->>'merchantOrderReference'), '')
      from jsonb_array_elements(v_items) j
      where nullif(trim(j->>'merchantOrderReference'), '') is not null
      group by nullif(trim(j->>'merchantOrderReference'), '') having count(*) > 1
    ) then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('merchantOrderReference.duplicate');
    end if;
    if v_ref is not null and exists (select 1 from public.store_order_requests r
                  where r.store_id = v_request.store_id and r.id <> v_request.id
                    and (r.store_order_reference = v_ref or r.merchant_order_number = v_ref)) then
      v_ref_taken := true;
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('merchantOrderNumber.duplicate');
    end if;
    if v_ship is null or v_ship_carrier is null then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('shipment.carrier');
    end if;
    if not (p_payload ? 'shipping') then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('shipping');
    end if;
    if v_request.status in ('store_cancelled','cancelled','restored') then
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('order_closed');
    end if;
  elsif v_rejected_like and nullif(trim(coalesce(p_payload->>'reason','')),'') is null then
    v_match := false;
    v_mismatches := v_mismatches || jsonb_build_array('reason');
  end if;

  v_has_commission := exists (
    select 1 from public.commissions c
    join public.store_order_request_items i on i.id = c.store_order_request_item_id
    where i.request_id = v_request.id and c.status in ('pending','payable','paid')
  );

  v_complete := v_completed_like and v_match;
  if v_completed_like then
    v_event_type := 'store_completed';
    v_new_status := case when v_complete then 'completed' else 'needs_review' end;
    if v_complete and v_request.status in ('shipped','delivered') then
      v_new_status := v_request.status;
    end if;
  elsif v_rejected_like then
    v_event_type := 'store_rejected';
    if v_has_commission then
      v_new_status := 'needs_review';
      v_match := false;
      v_mismatches := v_mismatches || jsonb_build_array('reversal_after_sale');
    else
      v_new_status := 'store_rejected';
    end if;
  else
    v_event_type := 'store_update';
    v_new_status := 'needs_review';
  end if;

  v_match_status := case when v_match then 'matched' else 'mismatched' end;
  v_apply_inventory := v_complete and v_request.inventory_applied_at is null;

  -- The merchant's own numbers are recorded only by a matched notice, and a recorded number is never overwritten.
  perform set_config('elan.pay_write', 'on', true);
  update public.store_order_requests
  set latest_store_payload = p_payload,
      reconciliation_status = v_match_status,
      mismatch_fields = v_mismatches,
      status = v_new_status,
      failure_reason = nullif(p_payload->>'reason',''),
      shipping_amount = case when p_payload ? 'shipping' then (p_payload->>'shipping')::numeric else shipping_amount end,
      total_amount = case when p_payload ? 'total' then (p_payload->>'total')::numeric else total_amount end,
      merchant_order_number = case when v_complete and merchant_order_number is null then v_ref else merchant_order_number end,
      merchant_invoice_number = case when v_complete and merchant_invoice_number is null then v_inv else merchant_invoice_number end,
      store_order_reference = case when v_complete and not v_ref_taken then coalesce(v_ref, store_order_reference) else store_order_reference end,
      payment_reference = case when v_complete and payment_status = 'cod_selected' and payment_reference is null then v_payref else payment_reference end,
      inventory_applied_at = case when v_apply_inventory then now() else inventory_applied_at end,
      updated_at = now()
  where id = v_request.id
  returning * into v_updated;
  perform set_config('elan.pay_write', 'off', true);

  if v_completed_like and v_match then
    update public.store_order_request_items i
    set merchant_order_reference = nullif(trim(j->>'merchantOrderReference'), '')
    from jsonb_array_elements(v_items) j
    where i.request_id = v_request.id
      and j->>'platformOrderNumber' = i.platform_order_number;
  end if;

  if v_apply_inventory then
    update public.store_products sp
    set stock_quantity = greatest(0, sp.stock_quantity - quantities.total_quantity),
        is_available = case
          when greatest(0, sp.stock_quantity - quantities.total_quantity) = 0 then false
          else sp.is_available
        end,
        updated_at = now()
    from (
      select i.store_product_id, sum(i.quantity)::integer as total_quantity
      from public.store_order_request_items i
      where i.request_id = v_request.id
        and i.store_product_id is not null
      group by i.store_product_id
    ) quantities
    where sp.id = quantities.store_product_id
      and sp.stock_quantity is not null;
  end if;

  -- The shipment data of the merchant's notice is recorded only when the notice matched.
  if v_ship_ok and v_match then
    select * into v_current_ship from public.store_shipments where request_id = v_request.id;
    perform set_config('elan.shipment_event', coalesce(v_idempotency, 'notice:' || md5(p_payload::text)) || '|merchant_notice|', true);
    if v_current_ship.id is null then
      insert into public.store_shipments (request_id, store_id, carrier_name, tracking_code, shipping_status, status_note, estimated_delivery_at, delivered_at)
      values (v_request.id, v_request.store_id, left(v_ship_carrier, 120), left(v_ship_code, 160), v_ship_status,
              left(nullif(trim(coalesce(v_ship->>'note','')), ''), 500), v_ship_eta,
              case when v_ship_status = 'delivered' then now() end);
    elsif private.can_shipping_transition(v_current_ship.shipping_status, v_ship_status) then
      update public.store_shipments
      set carrier_name = coalesce(left(v_ship_carrier, 120), carrier_name),
          tracking_code = coalesce(left(v_ship_code, 160), tracking_code),
          shipping_status = v_ship_status,
          status_note = coalesce(left(nullif(trim(coalesce(v_ship->>'note','')), ''), 500), status_note),
          estimated_delivery_at = coalesce(v_ship_eta, estimated_delivery_at),
          delivered_at = case when v_ship_status = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
          updated_at = now()
      where id = v_current_ship.id;
    end if;
    perform set_config('elan.shipment_event', '', true);
  end if;

  if v_completed_like then
    if v_complete then
      perform private.accrue_store_order_commission(v_request.id, 'store_completed', false, null);
    else
      perform private.accrue_store_order_commission(v_request.id, 'store_report_mismatch', true, 'store_report_mismatch');
    end if;
  end if;

  insert into public.store_order_notifications
    (request_id,tracking_number,event_type,store_status,match_status,mismatch_fields,payload,idempotency_key)
  values
    (v_request.id,v_tracking,v_event_type,v_status,v_match_status,v_mismatches,p_payload,v_idempotency);

  if v_completed_like then
    perform public.emit_order_notification(
      v_updated,
      case when v_complete then 'store_purchase_completed' else 'store_purchase_needs_review' end,
      case when v_complete then 'إشعار المتجر بعملية شراء' else 'إشعار شراء من المتجر يحتاج مراجعة' end,
      'أبلغ المتجر بعملية شراء للطلب ' || v_tracking
        || case when v_ref is not null then ' (رقم طلب المتجر: ' || v_ref || ')' else '' end
        || ' للعميل ' || coalesce(v_customer->>'name', v_request.customer_name)
        || case when v_complete then '.' else '. عدم مطابقة في: ' || (select string_agg(m, '، ') from jsonb_array_elements_text(v_mismatches) m) || '.' end,
      jsonb_build_object(
        'status', v_new_status, 'trackingNumber', v_tracking, 'merchantOrderNumber', v_ref,
        'customerId', v_request.user_id,
        'customer', coalesce(v_customer, '{}'::jsonb) || jsonb_build_object('id', v_request.user_id),
        'items', v_items, 'subtotal', p_payload->'subtotal',
        'shipping', p_payload->'shipping', 'total', p_payload->'total', 'shipment', v_ship,
        'matched', v_match, 'mismatches', v_mismatches));
  end if;

  if v_complete then
    perform private.apply_delivery_proof(v_request.id, null);
  end if;

  return jsonb_build_object(
    'trackingNumber', v_tracking,
    'matched', v_match,
    'status', v_new_status,
    'mismatches', v_mismatches,
    'inventoryApplied', v_apply_inventory,
    'duplicate', false
  );
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 11. Who may call what: the server only
-- ---------------------------------------------------------------------------------------------------------------------
revoke all on function public.merchant_review_order(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.select_order_payment_server(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.record_payment_event(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.record_shipment_event(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.receive_store_order_notification(jsonb) from public, anon, authenticated;
grant execute on function public.merchant_review_order(uuid, jsonb) to service_role;
grant execute on function public.select_order_payment_server(uuid, uuid, uuid, text) to service_role;
grant execute on function public.record_payment_event(uuid, jsonb) to service_role;
grant execute on function public.record_shipment_event(uuid, jsonb) to service_role;
grant execute on function public.receive_store_order_notification(jsonb) to service_role;
revoke all on function private.finalize_payment(uuid), private.payment_instructions(public.order_payments, public.store_order_requests),
  private.apply_delivery_proof(uuid, text), private.store_payment_options(uuid) from public, anon, authenticated;

commit;
