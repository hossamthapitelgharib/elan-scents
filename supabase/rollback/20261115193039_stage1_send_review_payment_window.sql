-- Rollback for supabase/migrations/20261115193039_stage1_send_review_payment_window.sql
-- Restores the previous definitions (taken from the migrations that last defined them) and removes what stage 1 added.
-- The two trial orders go back to "awaiting_store_confirmation" (their cancellation requests are untouched in store_order_cancellation_requests).
-- Orders cancelled by the new rules keep status 'cancelled' (a valid status before stage 1). The new tables and their rows are dropped.
begin;

update public.store_order_requests set status = 'awaiting_store_confirmation', cancel_reason = null, cancelled_at = null, updated_at = now()
  where cancel_reason = 'customer_requested_before_payment';

drop function if exists public.customer_order_state(uuid, uuid);
drop function if exists public.expire_payment_windows();
drop function if exists public.payment_window_return(uuid, uuid, text);
drop function if exists public.open_payment_window(uuid, uuid);
drop function if exists public.finish_merchant_delivery(uuid, integer, jsonb);
drop function if exists public.claim_merchant_deliveries(uuid, integer);
drop function if exists public.reserve_order_draft(uuid, uuid);
drop function if exists public.store_order_readiness();
drop function if exists private.record_delivery_failure(uuid, integer, text, integer, text);
drop function if exists private.delivery_failure_label(text);
drop function if exists private.cancel_unpaid_order(uuid, text, text);
drop function if exists private.merchant_order_payload(uuid);

-- Previous definitions.
create or replace function public.place_store_order(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_store_id uuid;
  v_key text;
  v_cd public.customer_details;
  v_email text;
  v_customer jsonb;
  v_lat double precision;
  v_lng double precision;
  v_address text;
  v_notes text;
  v_lines jsonb := '[]'::jsonb;
  v_signature jsonb;
  v_subtotal numeric := 0;
  v_expected numeric;
  v_existing uuid;
  v_session jsonb;
  v_tracking text;
  v_attempt integer;
  v_result jsonb;
  v_request_id uuid;
  r record;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Order payload is required';
  end if;
  begin
    v_store_id := nullif(p_payload->>'storeId', '')::uuid;
  exception when others then
    v_store_id := null;
  end;
  if v_store_id is null or not exists (select 1 from public.stores s where s.id = v_store_id and s.status = 'active') then
    raise exception 'Invalid or inactive store';
  end if;
  v_key := nullif(trim(p_payload->>'idempotencyKey'), '');
  if v_key is null or char_length(v_key) not between 8 and 64 then
    raise exception 'Invalid retry key';
  end if;

  -- One order at a time per customer: a double tap, or a retry that overlaps the first call, waits here and then finds the first call's key.
  perform pg_advisory_xact_lock(hashtextextended('place_store_order:' || v_user_id::text, 0));

  select i.request_id into v_existing from private.store_order_idempotency i where i.user_id = v_user_id and i.idem_key = v_key;
  if found then
    if not exists (select 1 from public.store_order_requests q where q.id = v_existing and q.user_id = v_user_id and q.store_id = v_store_id) then
      raise exception 'Invalid retry key';
    end if;
    return private.order_result(v_existing) || jsonb_build_object('duplicate', true);
  end if;

  if (select count(*) from public.store_order_requests q
      where q.user_id = v_user_id and q.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Too many orders, try again later';
  end if;

  -- The customer's data comes from his account, never from the browser. The first order completes it once.
  select * into v_cd from public.customer_details cd where cd.user_id = v_user_id;
  if not found or coalesce(btrim(v_cd.full_name), '') = '' or coalesce(btrim(v_cd.phone), '') = ''
     or coalesce(btrim(v_cd.governorate), '') = '' or coalesce(btrim(v_cd.address), '') = '' or coalesce(btrim(v_cd.ship_address), '') = '' then
    raise exception 'Account details are incomplete';
  end if;
  select u.email into v_email from auth.users u where u.id = v_user_id;
  v_lat := case when v_cd.ship_same then v_cd.address_lat else v_cd.ship_lat end;
  v_lng := case when v_cd.ship_same then v_cd.address_lng else v_cd.ship_lng end;
  v_address := private.compose_ship_address(v_cd);
  if v_lat is not null and v_lng is not null then
    v_address := v_address || E'\nhttps://www.google.com/maps?q=' || v_lat::text || ',' || v_lng::text;
  end if;
  v_notes := nullif(concat_ws(E'\n',
    case when nullif(btrim(v_cd.recipient_name), '') is not null or nullif(btrim(v_cd.recipient_phone), '') is not null
         then 'المشتري: ' || v_cd.full_name || ' - ' || v_cd.phone end,
    nullif(btrim(v_cd.delivery_notes), '')), '');
  v_customer := jsonb_build_object(
    'name', coalesce(nullif(btrim(v_cd.recipient_name), ''), v_cd.full_name),
    'phone', coalesce(nullif(btrim(v_cd.recipient_phone), ''), v_cd.phone),
    'email', coalesce(v_email, ''),
    'address', v_address,
    'notes', coalesce(v_notes, ''));

  -- The lines are the customer's saved cart for this store, priced by the live catalog. Nothing in the payload but the store and the key is read as truth.
  for r in
    select ci.id as cart_item_id, ci.quantity, sp.id as store_product_id, sp.product_size_id, sp.price, sp.currency, sp.is_available, sp.stock_quantity
    from public.cart_items ci
    join public.store_products sp on sp.id = ci.store_product_id
    where ci.user_id = v_user_id and sp.store_id = v_store_id
    order by ci.created_at, ci.id
  loop
    if not exists (
      select 1 from public.catalog_platform_offers po
      where po.product_size_id = r.product_size_id
        and po.store_product_id = r.store_product_id
        and po.store_id = v_store_id
        and po.price = r.price
        and po.currency = r.currency
    ) then
      raise exception 'Product is not offered by this store';
    end if;
    if not r.is_available or r.stock_quantity is null or r.stock_quantity <= 0 or r.stock_quantity < r.quantity then
      raise exception 'Product is unavailable or has insufficient stock';
    end if;
    if r.currency is distinct from 'EGP' then
      raise exception 'Only EGP orders are supported';
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'cartItemId', r.cart_item_id, 'productSizeId', r.product_size_id, 'storeProductId', r.store_product_id,
      'quantity', r.quantity, 'unitPrice', r.price, 'total', round(r.price * r.quantity, 2)));
    v_subtotal := v_subtotal + round(r.price * r.quantity, 2);
  end loop;
  if jsonb_array_length(v_lines) = 0 then
    raise exception 'Cart is empty for this store';
  end if;

  -- What the customer saw is only a guard against a stale screen; it never sets a price.
  begin
    v_expected := coalesce(nullif(p_payload->>'expectedSubtotal', ''), nullif(p_payload->>'subtotal', ''))::numeric;
  exception when others then
    raise exception 'Subtotal mismatch';
  end;
  if v_expected is not null and abs(v_expected - v_subtotal) > 0.005 then
    raise exception 'Subtotal mismatch';
  end if;

  -- The same lines at the same prices, already waiting for the store, are the same order (a second tab, a reload).
  select jsonb_agg(jsonb_build_array(e->>'storeProductId', (e->>'quantity')::integer, (e->>'unitPrice')::numeric) order by e->>'storeProductId')
    into v_signature from jsonb_array_elements(v_lines) e;
  select q.id into v_existing
  from public.store_order_requests q
  where q.user_id = v_user_id and q.store_id = v_store_id and q.status = 'awaiting_store_confirmation'
    and not exists (select 1 from public.store_order_cancellation_requests c where c.request_id = q.id)
    and (select jsonb_agg(jsonb_build_array(i.store_product_id::text, i.quantity, i.unit_price) order by i.store_product_id::text)
         from public.store_order_request_items i where i.request_id = q.id) = v_signature
  order by q.created_at desc limit 1;
  if found then
    insert into private.store_order_idempotency (user_id, idem_key, request_id) values (v_user_id, v_key, v_existing);
    return private.order_result(v_existing) || jsonb_build_object('duplicate', true, 'sameOpenOrder', true);
  end if;

  -- The tracking number and the checkout session. A clash with a number made at the same instant by someone else is retried.
  for v_attempt in 1..8 loop
    v_tracking := private.new_tracking_number();
    begin
      v_session := public.create_checkout_session(jsonb_build_object(
        'trackingNumber', v_tracking, 'customer', v_customer, 'subtotal', v_subtotal));
      exit;
    exception when unique_violation then
      v_session := null;
    end;
  end loop;
  if v_session is null then
    raise exception 'Could not allocate a tracking number';
  end if;

  v_result := public.create_store_order_request(jsonb_build_object(
    'storeId', v_store_id, 'trackingNumber', v_tracking, 'checkoutTrackingNumber', v_tracking,
    'checkoutSessionId', v_session->>'id', 'customer', v_customer, 'items', v_lines,
    'subtotal', v_subtotal, 'currency', 'EGP'));
  v_request_id := (v_result->>'id')::uuid;

  update public.store_order_request_items ri
  set source_cart_item_id = (select ci.id from public.cart_items ci where ci.user_id = v_user_id and ci.store_product_id = ri.store_product_id)
  where ri.request_id = v_request_id;

  insert into private.store_order_idempotency (user_id, idem_key, request_id) values (v_user_id, v_key, v_request_id);

  -- The cart stays as it is: the lines leave it only after a trusted payment result (phase 2).
  return private.order_result(v_request_id) || jsonb_build_object('duplicate', false);
end;
$function$;

create or replace function public.place_store_order_server(p_payload jsonb, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  if p_user_id is null then raise exception 'Authentication required'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
  return public.place_store_order(p_payload);
end;
$function$;

create or replace function private.order_result(p_request_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
  select jsonb_build_object(
    'id', r.id, 'elanOrderId', r.id, 'trackingNumber', r.tracking_number,
    'checkoutTrackingNumber', r.checkout_tracking_number, 'checkoutSessionId', r.checkout_session_id,
    'status', r.status, 'subtotal', r.subtotal, 'currency', r.currency,
    'merchantOrderNumber', r.merchant_order_number, 'merchantInvoiceNumber', r.merchant_invoice_number,
    'createdFromCart', true, 'cartCleared', false,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'lineId', i.id, 'platformOrderNumber', i.platform_order_number, 'productName', i.product_name,
                'brandName', i.brand_name, 'sizeLabel', i.size_label, 'quantity', i.quantity,
                'unitPrice', i.unit_price, 'lineTotal', i.line_total) order by i.created_at, i.id), '[]'::jsonb)
              from public.store_order_request_items i where i.request_id = r.id))
  from public.store_order_requests r where r.id = p_request_id;
$function$;

create or replace function private.new_tracking_number()
returns text
language plpgsql
volatile
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_candidate text;
  v_tries integer := 0;
begin
  loop
    v_candidate := 'ELN-' || to_char(timezone('Africa/Cairo', now()), 'YYYYMMDD') || '-'
      || lpad((((('x' || substr(md5(gen_random_uuid()::text), 1, 7))::bit(28))::bigint) % 1000000)::text, 6, '0');
    exit when not exists (select 1 from public.checkout_sessions where tracking_number = v_candidate)
          and not exists (select 1 from public.store_order_requests where tracking_number = v_candidate);
    v_tries := v_tries + 1;
    if v_tries >= 20 then
      raise exception 'Could not allocate a tracking number';
    end if;
  end loop;
  return v_candidate;
end;
$function$;

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

drop table if exists public.merchant_delivery_attempts;
drop table if exists public.merchant_deliveries;
drop table if exists public.payment_windows;
drop table if exists public.order_drafts;
drop function if exists private.store_order_ready(uuid);

alter table public.store_integrations drop constraint if exists store_integrations_order_endpoint_https;
alter table public.store_integrations drop column if exists order_endpoint;
alter table public.store_order_requests
  drop constraint if exists store_order_requests_cancel_only_when_cancelled,
  drop constraint if exists store_order_requests_cancel_detail_len,
  drop constraint if exists store_order_requests_cancel_reason_check;
alter table public.store_order_requests drop column if exists cancel_detail, drop column if exists cancel_reason, drop column if exists cancelled_at;

-- What stage 1 removed: the Elan-side payment methods, the method chooser and the customer's cancel request.
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
create or replace function private.store_payment_options(p_store_id uuid)
returns jsonb language sql stable security definer set search_path to 'public', 'private', 'pg_temp' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'mode', m.mode, 'provider', m.provider,
           'labelAr', m.label_ar, 'labelEn', m.label_en, 'redirectUrl', m.redirect_url, 'hostedConfig', m.hosted_config)
         order by m.sort_order, m.created_at, m.id), '[]'::jsonb)
  from public.store_payment_methods m where m.store_id = p_store_id and m.enabled;
$$;

create or replace function private.payment_instructions(p_payment public.order_payments, p_req public.store_order_requests)
returns jsonb language sql stable security definer set search_path to 'public', 'private', 'pg_temp' as $$
  select jsonb_build_object('paymentId', p_payment.id, 'elanOrderId', p_req.id, 'trackingNumber', p_req.tracking_number,
    'kind', p_payment.method_kind, 'mode', p_payment.mode, 'provider', p_payment.provider, 'status', p_payment.status,
    'amount', p_payment.amount, 'currency', p_payment.currency,
    'redirectUrl', (select o->>'redirectUrl' from jsonb_array_elements(coalesce(p_req.payment_options, '[]'::jsonb)) o
                    where o->>'kind' = p_payment.method_kind and o->>'provider' = p_payment.provider limit 1),
    'paymentStatus', p_req.payment_status);
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

create or replace function public.select_order_payment_server(p_request_id uuid, p_user_id uuid, p_method_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_req public.store_order_requests; v_opt jsonb; v_pay public.order_payments; v_key text; v_kind text; v_n integer;
begin
  if p_user_id is null then raise exception 'Authentication required' using errcode = 'P0001'; end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'Invalid retry key' using errcode = 'P0001'; end if;
  select * into v_req from public.store_order_requests where id = p_request_id for update;
  if not found or v_req.user_id is distinct from p_user_id then raise exception 'Order not found' using errcode = 'P0001'; end if;
  v_key := p_request_id::text || ':' || p_idempotency_key;
  -- the latest attempt made under this key (the key itself, then its retries <key>:r2, <key>:r3 …)
  select * into v_pay from public.order_payments where idempotency_key = v_key or idempotency_key like v_key || ':r%' order by created_at desc, idempotency_key desc limit 1;
  if found and v_pay.status in ('initiated', 'paid', 'cod_selected') then return private.payment_instructions(v_pay, v_req); end if;
  if v_req.status <> 'store_confirmed' or v_req.approved_at is null then raise exception 'Order is not approved for payment' using errcode = 'P0001'; end if;
  if private.payment_executed(v_req.payment_status) then raise exception 'Payment is already settled' using errcode = 'P0001'; end if;
  if v_req.currency is distinct from 'EGP' then raise exception 'Only EGP orders are supported' using errcode = 'P0001'; end if;
  if v_req.payable_amount is null or v_req.payable_amount <= 0 then raise exception 'Order has no payable amount' using errcode = 'P0001'; end if;
  select o into v_opt from jsonb_array_elements(coalesce(v_req.payment_options, '[]'::jsonb)) o where o->>'id' = p_method_id::text;
  if v_opt is null then raise exception 'Payment method is not offered for this order' using errcode = 'P0001'; end if;
  v_kind := v_opt->>'kind';

  -- a key that already had a dead attempt gets the next internal key, so a retry is a real new attempt
  select count(*) into v_n from public.order_payments where idempotency_key = v_key or idempotency_key like v_key || ':r%';
  if v_n > 0 then v_key := v_key || ':r' || (v_n + 1); end if;

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

create or replace function public.request_store_order_cancellation(p_request_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_request public.store_order_requests;
  v_row public.store_order_cancellation_requests;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'Reason is too long';
  end if;

  -- The customer's own order, locked so that the store's confirm or reject of the same order waits for this call.
  select * into v_request
  from public.store_order_requests r
  where r.id = p_request_id and r.user_id = v_user_id
  for update;
  if not found then
    raise exception 'Order not found';
  end if;

  select * into v_row from public.store_order_cancellation_requests c where c.request_id = v_request.id;
  if found then
    return jsonb_build_object('requestId', v_request.id, 'trackingNumber', v_request.tracking_number,
                              'createdAt', v_row.created_at, 'duplicate', true);
  end if;

  if v_request.status <> 'awaiting_store_confirmation' then
    raise exception 'Order is no longer waiting for the store';
  end if;

  insert into public.store_order_cancellation_requests (request_id, user_id, reason)
  values (v_request.id, v_user_id, v_reason)
  returning * into v_row;

  perform public.emit_order_notification(
    v_request, 'customer_cancel_requested', 'طلب إلغاء الطلب',
    'طلب العميل إلغاء هذا الطلب قبل تأكيد المتجر، وهو بانتظار رد المتجر.',
    jsonb_build_object('status', v_request.status, 'reason', v_reason));

  return jsonb_build_object('requestId', v_request.id, 'trackingNumber', v_request.tracking_number,
                            'createdAt', v_row.created_at, 'duplicate', false);
end;
$function$;

create or replace function public.request_store_order_cancellation_server(p_request_id uuid, p_reason text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  if p_user_id is null then raise exception 'Authentication required'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
  return public.request_store_order_cancellation(p_request_id, p_reason);
end;
$function$;

revoke all on function public.select_order_payment_server(uuid, uuid, uuid, text), public.request_store_order_cancellation(uuid, text),
  public.request_store_order_cancellation_server(uuid, text, uuid), public.place_store_order(jsonb), public.place_store_order_server(jsonb, uuid),
  public.merchant_review_order(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.select_order_payment_server(uuid, uuid, uuid, text), public.request_store_order_cancellation(uuid, text),
  public.request_store_order_cancellation_server(uuid, text, uuid), public.place_store_order(jsonb), public.place_store_order_server(jsonb, uuid),
  public.merchant_review_order(uuid, jsonb) to service_role;
revoke all on function private.store_payment_options(uuid), private.payment_instructions(public.order_payments, public.store_order_requests),
  private.new_tracking_number() from public, anon, authenticated;

commit;
