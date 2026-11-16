-- Stage 1 of docs/purchase-flow-correction-plan.ar.md (owner-approved 14 Nov 2026): send the order to the merchant, the merchant's automatic
-- review, and the merchant-owned payment window (steps 3 to 6 of docs/purchase-flow-final.ar.md).
--
--  * The order is queued for the merchant the moment the customer presses "موافق" and is sent signed by the Worker: six attempts about
--    ten seconds apart, every failed attempt classified and the platform told; after the sixth the order is cancelled ("store_unresponsive")
--    and the merchant is told so (a cancel delivery).
--  * The merchant answers with a rejection (and a reason) or an approval that carries the address of ITS OWN payment window (https) and a
--    validity of at most 30 minutes. Elan no longer lists payment methods or opens payment attempts: the payment-method table and the
--    customer's method chooser are removed.
--  * Closing the window before a trusted payment (cancel, close mark, expiry) cancels the order at once, tells the merchant, keeps the
--    products in the cart, and is never reopened. There is no customer cancel button: the cancellation-request functions are removed.
--  * A store without a technical link (an enabled integration with an order endpoint and a secret) cannot take an order.
--  * The two trial orders the owner asked to cancel become "cancelled by the customer" at the time the request was recorded.
-- Rollback: supabase/rollback/20261115150000_stage1_send_review_payment_window.sql

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------------------------------
alter table public.store_order_requests
  add column if not exists cancel_reason text,
  add column if not exists cancel_detail text,
  add column if not exists cancelled_at timestamptz;
alter table public.store_order_requests
  add constraint store_order_requests_cancel_reason_check check (cancel_reason is null or cancel_reason in (
    'store_unresponsive', 'payment_window_cancelled', 'payment_window_closed', 'payment_window_expired', 'customer_requested_before_payment')),
  add constraint store_order_requests_cancel_detail_len check (cancel_detail is null or char_length(cancel_detail) <= 500),
  add constraint store_order_requests_cancel_only_when_cancelled check (cancel_reason is null or status = 'cancelled');
comment on column public.store_order_requests.cancel_reason is 'Why an unpaid order was cancelled: store_unresponsive (six attempts failed) | payment_window_cancelled | payment_window_closed | payment_window_expired | customer_requested_before_payment (the two trial orders). Written only by private.cancel_unpaid_order.';

alter table public.store_integrations add column if not exists order_endpoint text;
alter table public.store_integrations
  add constraint store_integrations_order_endpoint_https check (order_endpoint is null
    or (char_length(order_endpoint) <= 500 and order_endpoint ~* '^https://[^[:space:]/?#@]+(/[^[:space:]]*)?$'));
comment on column public.store_integrations.order_endpoint is 'The merchant address that receives Elan''s signed order (and cancel) messages. A store is connected only with an enabled integration, this address and a secret.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Is the store technically linked? (the button is locked "غير متاح حاليًا" otherwise)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.store_order_ready(p_store_id uuid)
returns boolean language sql stable security definer set search_path to 'public', 'private', 'pg_temp' as $$
  select exists (
    select 1 from public.store_integrations i join public.stores s on s.id = i.store_id
    where i.store_id = p_store_id and s.status = 'active' and i.enabled
      and i.order_endpoint is not null and char_length(btrim(i.webhook_secret)) >= 16);
$$;

create or replace function public.store_order_readiness()
returns table (store_id uuid, ready boolean)
language sql stable security definer set search_path to 'public', 'private', 'pg_temp' as $$
  select s.id, private.store_order_ready(s.id) from public.stores s where s.status = 'active';
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. New tables (server only, like every order table)
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists public.order_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  store_id uuid not null references public.stores(id),
  tracking_number text not null unique check (char_length(tracking_number) between 1 and 64),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 hours',
  used_at timestamptz,
  request_id uuid references public.store_order_requests(id)
);
create unique index if not exists order_drafts_open_idx on public.order_drafts(user_id, store_id) where used_at is null;
comment on table public.order_drafts is 'The tracking number shown on the order page before the customer presses "موافق". One open draft per customer and store; expired drafts are closed, never deleted.';

create table if not exists public.merchant_deliveries (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.store_order_requests(id),
  store_id uuid not null references public.stores(id),
  kind text not null check (kind in ('order', 'cancel')),
  status text not null default 'pending' check (status in ('pending', 'sending', 'delivered', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 6 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_failure_kind text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (request_id, kind)
);
create index if not exists merchant_deliveries_due_idx on public.merchant_deliveries(next_attempt_at) where status in ('pending', 'sending');
create index if not exists merchant_deliveries_store_idx on public.merchant_deliveries(store_id);

create table if not exists public.merchant_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.merchant_deliveries(id),
  attempt_no integer not null check (attempt_no >= 1),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text check (outcome in ('decision_approved', 'decision_rejected', 'delivered', 'failed')),
  failure_kind text check (failure_kind in ('timeout', 'network', 'merchant_error', 'signature_rejected', 'no_decision', 'invalid_response',
                                            'not_connected', 'integration_disabled', 'worker_lost')),
  http_status integer,
  detail text check (detail is null or char_length(detail) <= 300),
  unique (delivery_id, attempt_no)
);
comment on table public.merchant_delivery_attempts is 'One row per send attempt: what went wrong is classified (failure_kind) so the platform can study the causes and their repetition. Never holds the message body, a secret or a signature.';

create table if not exists public.payment_windows (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.store_order_requests(id),
  store_id uuid not null references public.stores(id),
  url text not null check (char_length(url) <= 2000 and url ~* '^https://[^[:space:]/?#@]+(/[^[:space:]]*)?$'),
  state text not null default 'issued' check (state in ('issued', 'opened', 'success_claimed', 'closed', 'expired')),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  opened_at timestamptz,
  returned_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > issued_at and expires_at <= issued_at + interval '30 minutes')
);
comment on table public.payment_windows is 'The merchant''s own payment window for an approved order. success_claimed is only what the customer''s browser said on return: it proves nothing, a payment is proven by a neutral confirmation (stage 2).';

alter table public.order_drafts enable row level security;
alter table public.merchant_deliveries enable row level security;
alter table public.merchant_delivery_attempts enable row level security;
alter table public.payment_windows enable row level security;
create policy order_drafts_admin_all on public.order_drafts for all to authenticated using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy merchant_deliveries_admin_all on public.merchant_deliveries for all to authenticated using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy merchant_delivery_attempts_admin_all on public.merchant_delivery_attempts for all to authenticated using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy payment_windows_admin_all on public.payment_windows for all to authenticated using (private.is_platform_admin()) with check (private.is_platform_admin());
revoke all on public.order_drafts, public.merchant_deliveries, public.merchant_delivery_attempts, public.payment_windows from anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Approval no longer needs Elan-side payment methods
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.order_approval_stamp()
returns trigger language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
begin
  if new.status = 'store_confirmed' and old.status is distinct from 'store_confirmed' and old.approved_at is null then
    new.payable_amount := coalesce(new.total_amount, new.subtotal + coalesce(new.shipping_amount, 0));
    new.total_amount := new.payable_amount;
    new.approved_at := now();
  end if;
  return new;
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Tracking numbers never collide with a number held by an order draft
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.new_tracking_number()
returns text language plpgsql set search_path to 'public', 'private', 'pg_temp' as $$
declare v_candidate text; v_tries integer := 0;
begin
  loop
    v_candidate := 'ELN-' || to_char(timezone('Africa/Cairo', now()), 'YYYYMMDD') || '-'
      || lpad((((('x' || substr(md5(gen_random_uuid()::text), 1, 7))::bit(28))::bigint) % 1000000)::text, 6, '0');
    exit when not exists (select 1 from public.checkout_sessions where tracking_number = v_candidate)
          and not exists (select 1 from public.store_order_requests where tracking_number = v_candidate)
          and not exists (select 1 from public.order_drafts where tracking_number = v_candidate);
    v_tries := v_tries + 1;
    if v_tries >= 20 then raise exception 'Could not allocate a tracking number'; end if;
  end loop;
  return v_candidate;
end; $$;

-- The order page: the number the customer sees before pressing "موافق" is the number the order gets.
create or replace function public.reserve_order_draft(p_user_id uuid, p_store_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_d public.order_drafts;
begin
  if p_user_id is null then raise exception 'Authentication required'; end if;
  if not exists (select 1 from public.stores s where s.id = p_store_id and s.status = 'active') then raise exception 'Invalid or inactive store'; end if;
  if not private.store_order_ready(p_store_id) then raise exception 'Store is not connected'; end if;
  perform pg_advisory_xact_lock(hashtextextended('order_draft:' || p_user_id::text || ':' || p_store_id::text, 0));
  update public.order_drafts set used_at = now() where user_id = p_user_id and store_id = p_store_id and used_at is null and expires_at <= now();
  select * into v_d from public.order_drafts where user_id = p_user_id and store_id = p_store_id and used_at is null;
  if not found then
    insert into public.order_drafts (user_id, store_id, tracking_number) values (p_user_id, p_store_id, private.new_tracking_number()) returning * into v_d;
  end if;
  return jsonb_build_object('draftId', v_d.id, 'trackingNumber', v_d.tracking_number, 'expiresAt', v_d.expires_at);
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. What the merchant receives (built by the database from the frozen order; the Worker signs and sends it)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.merchant_order_payload(p_request_id uuid)
returns jsonb language sql stable security definer set search_path to 'public', 'private', 'pg_temp' as $$
  select jsonb_build_object(
    'type', 'elan_order', 'version', 1,
    'elanOrderId', r.id, 'trackingNumber', r.tracking_number,
    'store', jsonb_build_object('id', r.store_id, 'name', (select s.name from public.stores s where s.id = r.store_id)),
    'customer', r.customer_snapshot,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('lineId', i.id, 'platformOrderNumber', i.platform_order_number,
                'productSizeId', i.product_size_id, 'storeProductId', i.store_product_id, 'productName', i.product_name, 'brandName', i.brand_name,
                'sizeLabel', i.size_label, 'quantity', i.quantity, 'unitPrice', i.unit_price, 'lineTotal', i.line_total) order by i.created_at, i.id), '[]'::jsonb)
              from public.store_order_request_items i where i.request_id = r.id),
    'subtotal', r.subtotal, 'shipping', r.shipping_amount, 'currency', r.currency, 'createdAt', r.created_at)
  from public.store_order_requests r where r.id = p_request_id;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. The customer-facing result of an order now says where it stands
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.order_result(p_request_id uuid)
returns jsonb language sql stable security definer set search_path to 'public', 'private', 'pg_temp' as $$
  select jsonb_build_object(
    'id', r.id, 'elanOrderId', r.id, 'trackingNumber', r.tracking_number,
    'checkoutTrackingNumber', r.checkout_tracking_number, 'checkoutSessionId', r.checkout_session_id,
    'status', r.status, 'paymentStatus', r.payment_status, 'cancelReason', r.cancel_reason, 'failureReason', r.failure_reason,
    'subtotal', r.subtotal, 'currency', r.currency,
    'merchantOrderNumber', r.merchant_order_number, 'merchantInvoiceNumber', r.merchant_invoice_number,
    'createdFromCart', true, 'cartCleared', false,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'lineId', i.id, 'platformOrderNumber', i.platform_order_number, 'productName', i.product_name,
                'brandName', i.brand_name, 'sizeLabel', i.size_label, 'quantity', i.quantity,
                'unitPrice', i.unit_price, 'lineTotal', i.line_total) order by i.created_at, i.id), '[]'::jsonb)
              from public.store_order_request_items i where i.request_id = r.id))
  from public.store_order_requests r where r.id = p_request_id;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Placing the order: the lines come from the cart, the number from the page's draft, and the order is queued for the merchant
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.place_store_order(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_user_id uuid := auth.uid();
  v_store_id uuid;
  v_key text;
  v_draft public.order_drafts;
  v_draft_id uuid;
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
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then raise exception 'Order payload is required'; end if;
  begin v_store_id := nullif(p_payload->>'storeId', '')::uuid; exception when others then v_store_id := null; end;
  if v_store_id is null or not exists (select 1 from public.stores s where s.id = v_store_id and s.status = 'active') then
    raise exception 'Invalid or inactive store';
  end if;
  v_key := nullif(trim(p_payload->>'idempotencyKey'), '');
  if v_key is null or char_length(v_key) not between 8 and 64 then raise exception 'Invalid retry key'; end if;
  begin v_draft_id := nullif(p_payload->>'draftId', '')::uuid; exception when others then raise exception 'Order page expired'; end;

  -- One order at a time per customer: a double tap, or a retry that overlaps the first call, waits here and then finds the first call's key.
  perform pg_advisory_xact_lock(hashtextextended('place_store_order:' || v_user_id::text, 0));

  select i.request_id into v_existing from private.store_order_idempotency i where i.user_id = v_user_id and i.idem_key = v_key;
  if found then
    if not exists (select 1 from public.store_order_requests q where q.id = v_existing and q.user_id = v_user_id and q.store_id = v_store_id) then
      raise exception 'Invalid retry key';
    end if;
    return private.order_result(v_existing) || jsonb_build_object('duplicate', true);
  end if;

  if (select count(*) from public.store_order_requests q where q.user_id = v_user_id and q.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Too many orders, try again later';
  end if;

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

  for r in
    select ci.id as cart_item_id, ci.quantity, sp.id as store_product_id, sp.product_size_id, sp.price, sp.currency, sp.is_available, sp.stock_quantity
    from public.cart_items ci
    join public.store_products sp on sp.id = ci.store_product_id
    where ci.user_id = v_user_id and sp.store_id = v_store_id
    order by ci.created_at, ci.id
  loop
    if not exists (
      select 1 from public.catalog_platform_offers po
      where po.product_size_id = r.product_size_id and po.store_product_id = r.store_product_id and po.store_id = v_store_id
        and po.price = r.price and po.currency = r.currency
    ) then raise exception 'Product is not offered by this store'; end if;
    if not r.is_available or r.stock_quantity is null or r.stock_quantity <= 0 or r.stock_quantity < r.quantity then
      raise exception 'Product is unavailable or has insufficient stock';
    end if;
    if r.currency is distinct from 'EGP' then raise exception 'Only EGP orders are supported'; end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'cartItemId', r.cart_item_id, 'productSizeId', r.product_size_id, 'storeProductId', r.store_product_id,
      'quantity', r.quantity, 'unitPrice', r.price, 'total', round(r.price * r.quantity, 2)));
    v_subtotal := v_subtotal + round(r.price * r.quantity, 2);
  end loop;
  if jsonb_array_length(v_lines) = 0 then raise exception 'Cart is empty for this store'; end if;

  begin
    v_expected := coalesce(nullif(p_payload->>'expectedSubtotal', ''), nullif(p_payload->>'subtotal', ''))::numeric;
  exception when others then raise exception 'Subtotal mismatch';
  end;
  if v_expected is not null and abs(v_expected - v_subtotal) > 0.005 then raise exception 'Subtotal mismatch'; end if;

  -- The same lines at the same prices, already with the merchant or waiting for the payment confirmation, are the same order (a second tab, a reload).
  select jsonb_agg(jsonb_build_array(e->>'storeProductId', (e->>'quantity')::integer, (e->>'unitPrice')::numeric) order by e->>'storeProductId')
    into v_signature from jsonb_array_elements(v_lines) e;
  select q.id into v_existing
  from public.store_order_requests q
  where q.user_id = v_user_id and q.store_id = v_store_id and q.status in ('awaiting_store_confirmation', 'store_confirmed')
    and not private.payment_executed(q.payment_status)
    and not exists (select 1 from public.payment_windows w where w.request_id = q.id and w.state in ('issued', 'opened') and w.expires_at <= now())
    and (select jsonb_agg(jsonb_build_array(i.store_product_id::text, i.quantity, i.unit_price) order by i.store_product_id::text)
         from public.store_order_request_items i where i.request_id = q.id) = v_signature
  order by q.created_at desc limit 1;
  if found then
    insert into private.store_order_idempotency (user_id, idem_key, request_id) values (v_user_id, v_key, v_existing);
    return private.order_result(v_existing) || jsonb_build_object('duplicate', true, 'sameOpenOrder', true);
  end if;

  -- The number the page showed (an open draft of this customer and store), else a fresh one.
  if v_draft_id is not null then
    select * into v_draft from public.order_drafts d
    where d.id = v_draft_id and d.user_id = v_user_id and d.store_id = v_store_id and d.used_at is null and d.expires_at > now() for update;
    if not found then raise exception 'Order page expired'; end if;
    v_tracking := v_draft.tracking_number;
    begin
      v_session := public.create_checkout_session(jsonb_build_object('trackingNumber', v_tracking, 'customer', v_customer, 'subtotal', v_subtotal));
    exception when unique_violation then raise exception 'Order page expired';
    end;
  else
    for v_attempt in 1..8 loop
      v_tracking := private.new_tracking_number();
      begin
        v_session := public.create_checkout_session(jsonb_build_object('trackingNumber', v_tracking, 'customer', v_customer, 'subtotal', v_subtotal));
        exit;
      exception when unique_violation then v_session := null;
      end;
    end loop;
    if v_session is null then raise exception 'Could not allocate a tracking number'; end if;
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
  if v_draft.id is not null then update public.order_drafts set used_at = now(), request_id = v_request_id where id = v_draft.id; end if;

  -- Queued for the merchant in the same transaction as the order; the Worker sends it signed right after.
  insert into public.merchant_deliveries (request_id, store_id, kind) values (v_request_id, v_store_id, 'order');

  -- The cart stays as it is: the lines leave it only after a trusted payment result.
  return private.order_result(v_request_id) || jsonb_build_object('duplicate', false);
end; $$;

create or replace function public.place_store_order_server(p_payload jsonb, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_store uuid;
begin
  if p_user_id is null then raise exception 'Authentication required'; end if;
  begin v_store := nullif(p_payload->>'storeId', '')::uuid; exception when others then v_store := null; end;
  if v_store is not null and not private.store_order_ready(v_store) then raise exception 'Store is not connected'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
  return public.place_store_order(p_payload);
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Cancelling an UNPAID order (the only way an order is cancelled; a paid order is never cancelled here)
-- ---------------------------------------------------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. The outgoing sender's database side: claim a due delivery, then report how the attempt went
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.delivery_failure_label(p_kind text)
returns text language sql immutable set search_path to 'pg_temp' as $$
  select case p_kind
    when 'timeout' then 'انتهت مهلة الردّ (10 ثوانٍ)' when 'network' then 'انقطاع الاتصال بالمتجر'
    when 'merchant_error' then 'خطأ من خادم المتجر' when 'signature_rejected' then 'رفض المتجر التوقيع'
    when 'no_decision' then 'ردّ المتجر دون قرار' when 'invalid_response' then 'ردّ المتجر غير صالح'
    when 'not_connected' then 'المتجر غير مربوط تقنيًا' when 'integration_disabled' then 'ربط المتجر معطَّل'
    when 'worker_lost' then 'توقفت المحاولة قبل أن تكتمل' else 'سبب غير معروف' end;
$$;

-- A failed attempt: record it, tell the platform, then either schedule the next one or give up (the order is cancelled).
create or replace function private.record_delivery_failure(p_delivery_id uuid, p_attempt_no integer, p_kind text, p_http integer, p_detail text)
returns void language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_d public.merchant_deliveries; v_req public.store_order_requests; v_started timestamptz; v_backoff integer[] := array[60, 300, 900, 3600, 21600, 86400, 86400, 86400];
begin
  select * into v_d from public.merchant_deliveries where id = p_delivery_id for update;
  if not found then return; end if;
  update public.merchant_delivery_attempts set finished_at = now(), outcome = 'failed', failure_kind = p_kind, http_status = p_http, detail = left(p_detail, 300)
    where delivery_id = p_delivery_id and attempt_no = p_attempt_no returning started_at into v_started;
  select * into v_req from public.store_order_requests where id = v_d.request_id;
  insert into public.notifications (user_id, recipient_role, request_id, store_id, tracking_number, type, title, body, payload)
  values (null, 'platform_admin', v_d.request_id, v_d.store_id, v_req.tracking_number, 'order_delivery_attempt_failed',
          case when v_d.kind = 'order' then 'فشلت محاولة إرسال الطلب للمتجر' else 'فشلت محاولة إبلاغ المتجر بالإلغاء' end,
          'الطلب ' || v_req.tracking_number || ' — المحاولة ' || p_attempt_no || ' من ' || v_d.max_attempts || ': ' || private.delivery_failure_label(p_kind),
          jsonb_build_object('deliveryKind', v_d.kind, 'attempt', p_attempt_no, 'failureKind', p_kind, 'httpStatus', p_http));
  if p_attempt_no >= v_d.max_attempts then
    update public.merchant_deliveries set status = 'failed', attempts = greatest(attempts, p_attempt_no), last_failure_kind = p_kind, locked_until = null, finished_at = now() where id = v_d.id;
    if v_d.kind = 'order' then
      perform private.cancel_unpaid_order(v_d.request_id, 'store_unresponsive', private.delivery_failure_label(p_kind));
    else
      insert into public.notifications (user_id, recipient_role, request_id, store_id, tracking_number, type, title, body, payload)
      values (null, 'platform_admin', v_d.request_id, v_d.store_id, v_req.tracking_number, 'order_cancel_delivery_failed',
              'تعذّر إبلاغ المتجر بإلغاء الطلب', 'الطلب ' || v_req.tracking_number || ' أُلغي ولم يستلم المتجر رسالة الإلغاء بعد كل المحاولات.',
              jsonb_build_object('failureKind', p_kind));
    end if;
  else
    update public.merchant_deliveries set status = 'pending', attempts = greatest(attempts, p_attempt_no), last_failure_kind = p_kind, locked_until = null,
      next_attempt_at = case when v_d.kind = 'order' then greatest(now(), coalesce(v_started, now()) + interval '10 seconds')
                             else now() + make_interval(secs => v_backoff[least(p_attempt_no, 8)]) end
      where id = v_d.id;
  end if;
end; $$;

create or replace function public.claim_merchant_deliveries(p_request_id uuid default null, p_limit integer default 5)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_row public.merchant_deliveries; v_out jsonb := '[]'::jsonb; v_int public.store_integrations; v_req public.store_order_requests; v_no integer;
begin
  for v_row in
    select * from public.merchant_deliveries d
    where (p_request_id is null or d.request_id = p_request_id)
      and ((d.status = 'pending' and d.next_attempt_at <= now()) or (d.status = 'sending' and d.locked_until < now()))
    order by d.next_attempt_at limit greatest(1, least(coalesce(p_limit, 5), 20)) for update skip locked
  loop
    -- A sender that died mid-attempt leaves an open attempt behind: close it as a failure before going on.
    if v_row.status = 'sending' then
      perform private.record_delivery_failure(v_row.id, v_row.attempts, 'worker_lost', null, null);
      select * into v_row from public.merchant_deliveries where id = v_row.id;
      continue when v_row.status <> 'pending' or v_row.next_attempt_at > now();
    end if;
    select * into v_req from public.store_order_requests where id = v_row.request_id;
    if v_row.kind = 'order' and v_req.status <> 'awaiting_store_confirmation' then
      update public.merchant_deliveries set status = 'delivered', finished_at = now(), locked_until = null where id = v_row.id;
      continue;
    end if;
    v_no := v_row.attempts + 1;
    insert into public.merchant_delivery_attempts (delivery_id, attempt_no) values (v_row.id, v_no);
    update public.merchant_deliveries set status = 'sending', attempts = v_no, locked_until = now() + interval '25 seconds' where id = v_row.id;
    select * into v_int from public.store_integrations i where i.store_id = v_row.store_id;
    if not found or v_int.order_endpoint is null or char_length(btrim(v_int.webhook_secret)) < 16 then
      perform private.record_delivery_failure(v_row.id, v_no, 'not_connected', null, null);
    elsif not v_int.enabled then
      perform private.record_delivery_failure(v_row.id, v_no, 'integration_disabled', null, null);
    else
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'deliveryId', v_row.id, 'attemptNo', v_no, 'kind', v_row.kind, 'maxAttempts', v_row.max_attempts,
        'storeId', v_row.store_id, 'endpoint', v_int.order_endpoint, 'secret', v_int.webhook_secret,
        'requestId', v_row.request_id, 'trackingNumber', v_req.tracking_number,
        'payload', private.merchant_order_payload(v_row.request_id),
        'cancel', case when v_row.kind = 'cancel' then jsonb_build_object('reason', v_req.cancel_reason, 'cancelledAt', v_req.cancelled_at) end));
    end if;
  end loop;
  return v_out;
end; $$;

create or replace function public.finish_merchant_delivery(p_delivery_id uuid, p_attempt_no integer, p_result jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare
  v_d public.merchant_deliveries; v_req public.store_order_requests; v_kind text; v_reply jsonb; v_decision text; v_http integer; v_review jsonb; v_msg text;
begin
  select * into v_d from public.merchant_deliveries where id = p_delivery_id for update;
  if not found or v_d.status <> 'sending' or v_d.attempts <> p_attempt_no then return jsonb_build_object('ignored', true); end if;
  select * into v_req from public.store_order_requests where id = v_d.request_id;
  v_http := case when (p_result->>'httpStatus') ~ '^\d{3}$' then (p_result->>'httpStatus')::integer end;
  if coalesce(p_result->>'outcome', '') <> 'responded' then
    v_kind := coalesce(p_result->>'failureKind', 'network');
    if v_kind not in ('timeout', 'network', 'merchant_error', 'signature_rejected', 'no_decision', 'invalid_response') then v_kind := 'network'; end if;
    perform private.record_delivery_failure(v_d.id, p_attempt_no, v_kind, v_http, p_result->>'detail');
    return jsonb_build_object('ok', false, 'failureKind', v_kind);
  end if;

  if v_d.kind = 'cancel' then
    update public.merchant_delivery_attempts set finished_at = now(), outcome = 'delivered', http_status = v_http where delivery_id = v_d.id and attempt_no = p_attempt_no;
    update public.merchant_deliveries set status = 'delivered', finished_at = now(), locked_until = null where id = v_d.id;
    return jsonb_build_object('ok', true);
  end if;

  v_reply := p_result->'reply';
  v_decision := lower(coalesce(case when jsonb_typeof(v_reply) = 'object' then v_reply->>'decision' end, ''));
  if v_decision not in ('approve', 'reject') then
    perform private.record_delivery_failure(v_d.id, p_attempt_no, 'no_decision', v_http, null);
    return jsonb_build_object('ok', false, 'failureKind', 'no_decision');
  end if;
  begin
    v_review := public.merchant_review_order(v_d.store_id, v_reply || jsonb_build_object('trackingNumber', v_req.tracking_number,
                  'eventId', 'delivery:' || v_d.id::text || ':' || p_attempt_no));
  exception when others then
    get stacked diagnostics v_msg = message_text;
    perform private.record_delivery_failure(v_d.id, p_attempt_no, 'invalid_response', v_http, v_msg);
    return jsonb_build_object('ok', false, 'failureKind', 'invalid_response');
  end;
  update public.merchant_delivery_attempts set finished_at = now(), http_status = v_http,
         outcome = case when v_decision = 'approve' then 'decision_approved' else 'decision_rejected' end
    where delivery_id = v_d.id and attempt_no = p_attempt_no;
  update public.merchant_deliveries set status = 'delivered', finished_at = now(), locked_until = null where id = v_d.id;
  return jsonb_build_object('ok', true, 'decision', v_decision, 'status', v_review->>'status');
end; $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 11. The merchant's decision: a rejection with its reason, or an approval that carries ITS payment window (https, at most 30 minutes)
-- ---------------------------------------------------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------------------------------------------------
-- 13. The two trial orders the owner asked to cancel, and the rule behind them: an unpaid order with a cancellation request is cancelled
--     by the customer at the time the request was recorded
-- ---------------------------------------------------------------------------------------------------------------------
update public.store_order_requests r
set status = 'cancelled', cancel_reason = 'customer_requested_before_payment', cancelled_at = c.created_at, updated_at = now()
from public.store_order_cancellation_requests c
where c.request_id = r.id and r.status = 'awaiting_store_confirmation' and r.payment_status = 'not_started' and r.cancel_reason is null;

-- ---------------------------------------------------------------------------------------------------------------------
-- 14. What the final picture removes: Elan-side payment methods and attempts, and the customer's cancel button
-- ---------------------------------------------------------------------------------------------------------------------
drop function if exists public.select_order_payment_server(uuid, uuid, uuid, text);
drop function if exists private.payment_instructions(public.order_payments, public.store_order_requests);
drop function if exists private.store_payment_options(uuid);
drop table if exists public.store_payment_methods;
drop function if exists public.request_store_order_cancellation_server(uuid, text, uuid);
drop function if exists public.request_store_order_cancellation(uuid, text);

-- ---------------------------------------------------------------------------------------------------------------------
-- 15. Grants: the browser reaches none of this; only the readiness list is public
-- ---------------------------------------------------------------------------------------------------------------------
revoke all on function public.store_order_readiness() from public, anon, authenticated;
grant execute on function public.store_order_readiness() to anon, authenticated, service_role;
revoke all on function public.reserve_order_draft(uuid, uuid), public.place_store_order(jsonb), public.place_store_order_server(jsonb, uuid),
  public.claim_merchant_deliveries(uuid, integer), public.finish_merchant_delivery(uuid, integer, jsonb), public.merchant_review_order(uuid, jsonb),
  public.open_payment_window(uuid, uuid), public.payment_window_return(uuid, uuid, text), public.expire_payment_windows(),
  public.customer_order_state(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_order_draft(uuid, uuid), public.place_store_order(jsonb), public.place_store_order_server(jsonb, uuid),
  public.claim_merchant_deliveries(uuid, integer), public.finish_merchant_delivery(uuid, integer, jsonb), public.merchant_review_order(uuid, jsonb),
  public.open_payment_window(uuid, uuid), public.payment_window_return(uuid, uuid, text), public.expire_payment_windows(),
  public.customer_order_state(uuid, uuid) to service_role;
revoke all on function private.store_order_ready(uuid), private.merchant_order_payload(uuid), private.cancel_unpaid_order(uuid, text, text),
  private.delivery_failure_label(text), private.record_delivery_failure(uuid, integer, text, integer, text), private.new_tracking_number() from public, anon, authenticated;
