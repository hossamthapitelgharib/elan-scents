-- Phase 1 of the purchase redesign (docs/implementation-phase-1-purchase-core.ar.md): the order core.
--
-- 1. An order is built by the server from the customer's saved cart and the live catalog; the customer's data comes from his account
--    (customer_details) and is frozen on the order together with the products (immutable snapshot).
-- 2. The cart is NOT cleared when the order is created (Phase 2 deletes only the paid store's lines after a trusted payment result).
-- 3. One order per store, one attempt key per press; the same key, or the same open order for the same lines, returns the same order.
-- 4. merchant_order_number / merchant_invoice_number exist but are empty at creation and can be recorded only after a matched merchant notice.
-- 5. The customer's own "I bought it" confirmation is retired: no function writes it, the watch view and the health report ignore it.
-- 6. EGP only, in the database.
begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. EGP only
-- ---------------------------------------------------------------------------------------------------------------------
alter table public.store_order_requests add constraint store_order_requests_currency_egp check (currency = 'EGP');
alter table public.store_order_request_items add constraint store_order_request_items_currency_egp check (currency = 'EGP');
alter table public.checkout_sessions add constraint checkout_sessions_currency_egp check (currency = 'EGP');
alter table public.commission_settlements add constraint commission_settlements_currency_egp check (currency = 'EGP');

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. New columns
-- ---------------------------------------------------------------------------------------------------------------------
alter table public.store_order_requests
  add column if not exists merchant_order_number text,
  add column if not exists merchant_invoice_number text,
  add column if not exists customer_snapshot jsonb not null default '{}'::jsonb;
alter table public.store_order_requests
  add constraint store_order_requests_merchant_numbers_fmt check (
    (merchant_order_number is null or char_length(btrim(merchant_order_number)) between 1 and 160)
    and (merchant_invoice_number is null or char_length(btrim(merchant_invoice_number)) between 1 and 160));
comment on column public.store_order_requests.merchant_order_number is 'The merchant''s own order number. Empty when the order is created; recorded only after the merchant notice matched the platform notice.';
comment on column public.store_order_requests.merchant_invoice_number is 'The merchant''s own invoice number. Empty when the order is created; recorded only after the merchant notice matched the platform notice.';
comment on column public.store_order_requests.customer_snapshot is 'Immutable copy of the customer''s account data (buyer, shipping address, recipient, notes) and of what the merchant and the courier receive, taken when the order is created.';

alter table public.store_order_request_items
  add column if not exists product_snapshot jsonb,
  add column if not exists product_description text;
comment on column public.store_order_request_items.product_snapshot is 'Immutable copy of the product as sold (name, brand, description, size, this store''s offer), taken when the order is created. Reading an order never depends on the live catalog.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The snapshots: built by the database for every order, whatever path created it
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.build_customer_snapshot(p_user_id uuid, p_name text, p_phone text, p_email text, p_address text, p_notes text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v public.customer_details;
  v_delivery jsonb := jsonb_build_object('name', p_name, 'phone', p_phone, 'email', p_email, 'address', p_address, 'notes', p_notes);
begin
  select * into v from public.customer_details cd where cd.user_id = p_user_id;
  if not found then
    return jsonb_build_object('source', 'order_columns', 'capturedAt', now(), 'delivery', v_delivery);
  end if;
  return jsonb_build_object(
    'source', 'customer_details',
    'capturedAt', now(),
    'buyer', jsonb_build_object('name', v.full_name, 'phone', v.phone, 'email', p_email, 'governorate', v.governorate,
                                'address', v.address, 'lat', v.address_lat, 'lng', v.address_lng),
    'shipping', jsonb_build_object('sameAsBuyer', v.ship_same,
                                   'governorate', case when v.ship_same then v.governorate else v.ship_governorate end,
                                   'address', v.ship_address,
                                   'lat', case when v.ship_same then v.address_lat else v.ship_lat end,
                                   'lng', case when v.ship_same then v.address_lng else v.ship_lng end),
    'recipient', case when v.recipient_name is not null or v.recipient_phone is not null
                      then jsonb_build_object('name', v.recipient_name, 'phone', v.recipient_phone) end,
    'deliveryNotes', v.delivery_notes,
    'delivery', v_delivery);
end;
$function$;
revoke all on function private.build_customer_snapshot(uuid, text, text, text, text, text) from public, anon, authenticated;

create or replace function private.snapshot_order_customer()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  if new.merchant_order_number is not null or new.merchant_invoice_number is not null then
    raise exception 'Merchant numbers do not exist when an order is created' using errcode = 'P0001';
  end if;
  -- Never taken from the caller: the database freezes what the account and the order columns hold at this moment.
  new.customer_snapshot := private.build_customer_snapshot(new.user_id, new.customer_name, new.customer_phone, new.customer_email, new.customer_address, new.customer_notes);
  return new;
end;
$function$;
revoke all on function private.snapshot_order_customer() from public, anon, authenticated;

create or replace function private.snapshot_order_item()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_snapshot jsonb;
  v_description text;
begin
  select jsonb_build_object(
           'productId', p.id, 'name', p.name, 'slug', p.slug, 'brand', b.name,
           'shortDescription', p.short_description, 'officialDescription', p.official_description,
           'composition', p.composition, 'gender', p.gender,
           'sizeId', ps.id, 'sizeLabel', ps.size_label, 'sizeMl', ps.size_ml, 'sku', ps.sku,
           'storeProductId', new.store_product_id, 'productUrl', sp.product_url,
           'unitPrice', new.unit_price, 'quantity', new.quantity, 'lineTotal', new.line_total, 'currency', new.currency,
           'capturedAt', now()),
         coalesce(nullif(btrim(p.official_description), ''), nullif(btrim(p.short_description), ''))
    into v_snapshot, v_description
  from public.product_sizes ps
  join public.products p on p.id = ps.product_id
  left join public.brands b on b.id = p.brand_id
  left join public.store_products sp on sp.id = new.store_product_id
  where ps.id = new.product_size_id;
  new.product_snapshot := coalesce(v_snapshot, jsonb_build_object('source', 'order_columns', 'name', new.product_name, 'brand', new.brand_name,
                                   'sizeLabel', new.size_label, 'unitPrice', new.unit_price, 'quantity', new.quantity, 'currency', new.currency, 'capturedAt', now()));
  new.product_description := v_description;
  return new;
end;
$function$;
revoke all on function private.snapshot_order_item() from public, anon, authenticated;

-- Existing orders (all EGP): freeze them the same way. The row triggers are switched off only for this statement, in this transaction.
alter table public.store_order_requests disable trigger user;
update public.store_order_requests r
set customer_snapshot = private.build_customer_snapshot(r.user_id, r.customer_name, r.customer_phone, r.customer_email, r.customer_address, r.customer_notes);
alter table public.store_order_requests enable trigger user;

alter table public.store_order_request_items disable trigger user;
update public.store_order_request_items i
set product_snapshot = coalesce((
      select jsonb_build_object('productId', p.id, 'name', p.name, 'slug', p.slug, 'brand', b.name,
               'shortDescription', p.short_description, 'officialDescription', p.official_description,
               'composition', p.composition, 'gender', p.gender, 'sizeId', ps.id, 'sizeLabel', ps.size_label,
               'sizeMl', ps.size_ml, 'sku', ps.sku, 'storeProductId', i.store_product_id,
               'unitPrice', i.unit_price, 'quantity', i.quantity, 'lineTotal', i.line_total, 'currency', i.currency,
               'capturedAt', now(), 'backfilled', true)
      from public.product_sizes ps join public.products p on p.id = ps.product_id left join public.brands b on b.id = p.brand_id
      where ps.id = i.product_size_id),
    jsonb_build_object('source', 'order_columns', 'name', i.product_name, 'brand', i.brand_name, 'sizeLabel', i.size_label,
                       'unitPrice', i.unit_price, 'quantity', i.quantity, 'currency', i.currency, 'backfilled', true)),
    product_description = (select coalesce(nullif(btrim(p.official_description), ''), nullif(btrim(p.short_description), ''))
                           from public.product_sizes ps join public.products p on p.id = ps.product_id where ps.id = i.product_size_id);
alter table public.store_order_request_items enable trigger user;

create trigger snapshot_order_customer before insert on public.store_order_requests
  for each row execute function private.snapshot_order_customer();
create trigger snapshot_order_item before insert on public.store_order_request_items
  for each row execute function private.snapshot_order_item();

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. What may never change, and what is never deleted
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.protect_order_base()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  if tg_table_name = 'store_order_request_items' then
    if tg_op = 'DELETE' then
      if exists (select 1 from public.store_order_requests r where r.id = old.request_id and r.user_id is not null) then
        raise exception 'Order lines of a registered customer are never deleted' using errcode = 'P0001';
      end if;
      return old;
    end if;
    if new.request_id is distinct from old.request_id or new.quantity is distinct from old.quantity
       or new.unit_price is distinct from old.unit_price or new.line_total is distinct from old.line_total
       or new.currency is distinct from old.currency or new.store_product_id is distinct from old.store_product_id
       or new.product_size_id is distinct from old.product_size_id or new.product_id is distinct from old.product_id
       or new.product_name is distinct from old.product_name or new.brand_name is distinct from old.brand_name
       or new.size_label is distinct from old.size_label or new.product_snapshot is distinct from old.product_snapshot
       or new.product_description is distinct from old.product_description
       or new.platform_order_number is distinct from old.platform_order_number then
      raise exception 'Order lines are immutable; use an adjustment' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.user_id is not null then
      raise exception 'Orders of a registered customer are never deleted' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if new.subtotal is distinct from old.subtotal or new.store_id is distinct from old.store_id
     or new.tracking_number is distinct from old.tracking_number or new.currency is distinct from old.currency
     or (old.user_id is not null and new.user_id is not null and new.user_id is distinct from old.user_id)
     or new.customer_name is distinct from old.customer_name or new.customer_phone is distinct from old.customer_phone
     or new.customer_email is distinct from old.customer_email or new.customer_address is distinct from old.customer_address
     or new.customer_notes is distinct from old.customer_notes or new.customer_snapshot is distinct from old.customer_snapshot
     or new.created_at is distinct from old.created_at then
    raise exception 'The order base is immutable' using errcode = 'P0001';
  end if;
  if new.customer_confirmed_at is distinct from old.customer_confirmed_at then
    raise exception 'Customer purchase confirmation is retired' using errcode = 'P0001';
  end if;
  if (old.merchant_order_number is not null and new.merchant_order_number is distinct from old.merchant_order_number)
     or (old.merchant_invoice_number is not null and new.merchant_invoice_number is distinct from old.merchant_invoice_number) then
    raise exception 'A merchant number is fixed once it is recorded' using errcode = 'P0001';
  end if;
  if (new.merchant_order_number is distinct from old.merchant_order_number or new.merchant_invoice_number is distinct from old.merchant_invoice_number)
     and new.reconciliation_status is distinct from 'matched' then
    raise exception 'Merchant numbers are recorded only after the merchant notice matched the platform notice' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;

drop trigger if exists protect_order_base_trigger on public.store_order_requests;
create trigger protect_order_base_trigger before delete or update on public.store_order_requests
  for each row execute function private.protect_order_base();

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The customer's confirmation is retired (the columns and the old rows stay as history)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.confirm_store_order_purchase(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  raise exception 'Customer purchase confirmation is retired' using errcode = 'P0001';
end;
$function$;
comment on function public.confirm_store_order_purchase(uuid) is 'DEPRECATED (2026-11-07): the sale is proven by shipping and delivery, never by the customer''s own word. Kept only so an old caller gets a clear refusal.';

create or replace function public.confirm_store_order_purchase_server(p_request_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  raise exception 'Customer purchase confirmation is retired' using errcode = 'P0001';
end;
$function$;
comment on function public.confirm_store_order_purchase_server(uuid, uuid) is 'DEPRECATED (2026-11-07): see confirm_store_order_purchase.';

-- The watch list no longer reads the customer's word.
create or replace view public.platform_commission_watch with (security_invoker = true) as
select r.id as request_id, r.tracking_number, r.store_id, r.status, r.reconciliation_status,
       r.created_at, r.updated_at, f.flag
from public.store_order_requests r
left join public.store_shipments sh on sh.request_id = r.id
cross join lateral (values
  ('no_store_report', r.status = 'awaiting_store_confirmation' and r.created_at < now() - interval '3 days'),
  ('stuck_in_review', r.status = 'needs_review' and r.updated_at < now() - interval '2 days'),
  ('report_mismatched', r.status = 'needs_review'
      and lower(coalesce(r.latest_store_payload->>'status', '')) in ('completed', 'success', 'succeeded', 'paid', 'confirmed')),
  ('rejected_but_shipped', r.status in ('store_rejected', 'store_cancelled', 'cancelled')
      and sh.shipping_status in ('handed_to_carrier', 'in_transit', 'out_for_delivery', 'delivered')),
  ('reversed_after_sale', r.mismatch_fields ? 'reversal_after_sale'
      or (r.status in ('store_rejected', 'store_cancelled', 'cancelled') and exists (
            select 1 from public.commissions c join public.store_order_request_items i on i.id = c.store_order_request_item_id
            where i.request_id = r.id))),
  ('shipped_unreported', sh.shipping_status in ('handed_to_carrier', 'in_transit', 'out_for_delivery', 'delivered')
      and r.status not in ('store_rejected', 'store_cancelled', 'cancelled', 'restored')
      and r.reconciliation_status is distinct from 'matched' and r.created_at < now() - interval '1 day'),
  ('delivery_not_confirmed', sh.shipping_status in ('handed_to_carrier', 'in_transit', 'out_for_delivery', 'delayed')
      and sh.updated_at < now() - interval '14 days'),
  ('delivered_unverified', sh.shipping_status = 'delivered' and sh.delivery_verified_at is null
      and sh.updated_at < now() - interval '3 days'),
  ('below_catalog_total', r.total_amount is not null and r.total_amount + 0.005 < r.subtotal)
) as f(flag, hit)
where f.hit;
revoke all on public.platform_commission_watch from public, anon, authenticated;
grant select on public.platform_commission_watch to service_role;
comment on view public.platform_commission_watch is 'Orders where the store''s report and the carrier disagree. Reads the unified commission ledger; service_role only. The customer''s own word is not an input.';

drop function if exists public.platform_store_order_health(integer);
create function public.platform_store_order_health(p_days integer default 90)
returns table(store_id uuid, store_name text, orders bigint, reported bigint, rejected bigint, needs_review bigint,
              awaiting_over_3d bigint, commission_total numeric)
language sql
stable
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
  select s.id, s.name,
         count(r.id),
         count(*) filter (where r.reconciliation_status = 'matched' and r.status in ('completed', 'shipped', 'delivered')),
         count(*) filter (where r.status in ('store_rejected', 'store_cancelled', 'cancelled')),
         count(*) filter (where r.status = 'needs_review'),
         count(*) filter (where r.status = 'awaiting_store_confirmation' and r.created_at < now() - interval '3 days'),
         coalesce(sum(cm.amount), 0)
  from public.stores s
  left join public.store_order_requests r
    on r.store_id = s.id and r.created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 90), 1000)))
  left join lateral (
    select sum(c.amount) as amount
    from public.commissions c join public.store_order_request_items i on i.id = c.store_order_request_item_id
    where i.request_id = r.id
  ) cm on true
  group by s.id, s.name
  order by s.name
$function$;
revoke all on function public.platform_store_order_health(integer) from public, anon, authenticated;
grant execute on function public.platform_store_order_health(integer) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Creating the order
-- ---------------------------------------------------------------------------------------------------------------------
-- The answer to the browser, always read back from the stored order.
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
revoke all on function private.order_result(uuid) from public, anon, authenticated;

-- The old cart-clearing path that trusted the caller's customer data is closed. place_store_order is the one way in.
create or replace function public.create_store_order_request_from_cart(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  raise exception 'Retired: orders are created only by place_store_order' using errcode = 'P0001';
end;
$function$;
comment on function public.create_store_order_request_from_cart(jsonb) is 'RETIRED (2026-11-07): it cleared the cart when the order was created. Use place_store_order.';

-- The checkout session never takes a currency from the caller.
create or replace function public.create_checkout_session(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_session public.checkout_sessions;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;
  if coalesce(trim(p_payload->'customer'->>'name'),'') = ''
     or coalesce(trim(p_payload->'customer'->>'phone'),'') = ''
     or coalesce(trim(p_payload->'customer'->>'address'),'') = '' then
    raise exception 'Customer details are required';
  end if;
  insert into public.checkout_sessions
    (tracking_number, user_id, customer_name, customer_phone, customer_email,
     customer_address, currency, subtotal)
  values
    (p_payload->>'trackingNumber', v_user,
     trim(p_payload->'customer'->>'name'),
     trim(p_payload->'customer'->>'phone'),
     nullif(trim(p_payload->'customer'->>'email'), ''),
     trim(p_payload->'customer'->>'address'),
     'EGP',
     coalesce((p_payload->>'subtotal')::numeric, 0))
  returning * into v_session;
  return jsonb_build_object(
    'id', v_session.id,
    'trackingNumber', v_session.tracking_number,
    'status', v_session.status);
end;
$function$;

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
  v_address := concat_ws('، ', nullif(btrim(case when v_cd.ship_same then v_cd.governorate else v_cd.ship_governorate end), ''), v_cd.ship_address);
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
    if not r.is_available or (r.stock_quantity is not null and r.stock_quantity < r.quantity) then
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

-- The notice the store and the platform see says it is an Élan Scents order.
create or replace function private.enrich_initial_order_notification(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_req public.store_order_requests;
  v_store text;
  v_items jsonb;
  v_count integer;
  v_payload jsonb;
begin
  select * into v_req from public.store_order_requests where id = p_request_id;
  if not found then
    return;
  end if;
  select s.name into v_store from public.stores s where s.id = v_req.store_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'platformOrderNumber', i.platform_order_number, 'productName', i.product_name, 'brandName', i.brand_name,
           'size', i.size_label, 'productSizeId', i.product_size_id, 'quantity', i.quantity, 'unitPrice', i.unit_price,
           'lineTotal', i.line_total) order by i.created_at, i.id), '[]'::jsonb), count(*)
    into v_items, v_count
  from public.store_order_request_items i where i.request_id = p_request_id;
  v_payload := jsonb_build_object(
    'platform', 'Élan Scents', 'elanOrderId', v_req.id,
    'status', v_req.status, 'subtotal', v_req.subtotal, 'currency', v_req.currency,
    'trackingNumber', v_req.tracking_number, 'checkoutTrackingNumber', v_req.checkout_tracking_number,
    'store', jsonb_build_object('id', v_req.store_id, 'name', v_store),
    'customer', jsonb_build_object('name', v_req.customer_name, 'phone', v_req.customer_phone,
                                   'email', v_req.customer_email, 'address', v_req.customer_address,
                                   'notes', v_req.customer_notes),
    'items', v_items, 'itemCount', v_count, 'handedOffAt', v_req.created_at);
  update public.notifications set payload = v_payload
  where request_id = p_request_id and type = 'order_initial';
  update public.notifications
  set body = 'طلب جديد عبر Élan Scents من العميل ' || v_req.customer_name || ' (' || v_req.customer_phone || ') إلى متجر ' || coalesce(v_store, '')
             || ': ' || v_count || ' منتج بإجمالي ' || v_req.subtotal || ' ' || v_req.currency
             || '. رقم تتبع Élan Scents: ' || v_req.tracking_number
  where request_id = p_request_id and type = 'order_initial' and recipient_role in ('platform_admin', 'store_admin');
end;
$function$;

commit;
