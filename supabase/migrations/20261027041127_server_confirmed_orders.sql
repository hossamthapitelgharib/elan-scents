begin;

-- Server-confirmed orders (owner decision of 2026-10-26: the customer sees "done" only after the server has saved the
-- order, the tracking number is made by the server, and what is ordered is exactly what the customer saw).
--
-- Before this, the browser made the tracking number, called two functions one after the other and showed "sent" without
-- waiting for either: a number clash or any error left the customer with a confirmation for an order that did not exist,
-- and a first call that succeeded followed by a failing second one left an orphan checkout session and made every retry
-- with the same number fail. place_store_order does all of it in ONE transaction:
--   * checks the lines the customer saw (store product, quantity 1..99, price still the same, still in stock),
--   * makes the store's rows in the saved cart equal to those lines (so the order is the displayed cart, not whatever an
--     older cart on another device left behind),
--   * makes the tracking number (ELN-YYYYMMDD-NNNNNN, Cairo date, 6 random digits, never used before),
--   * creates the checkout session and the store order request through the existing functions, which also clear the cart,
--   * remembers the retry key so a repeated call after a lost answer returns the same order instead of making a second one.
-- Any failure rolls everything back, including the cart change. The two older functions stay as they are for browsers that
-- still hold the previous script; they are not used by the new one.

-- 1. Retry keys. Server-only: RLS on and no policy, in the private schema.
create table private.store_order_idempotency (
  user_id uuid not null references auth.users (id) on delete cascade,
  idem_key text not null check (char_length(idem_key) between 8 and 64),
  request_id uuid not null references public.store_order_requests (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, idem_key)
);
create index store_order_idempotency_request_idx on private.store_order_idempotency (request_id);
create index store_order_idempotency_created_idx on private.store_order_idempotency (created_at);
alter table private.store_order_idempotency enable row level security;

-- 2. Tracking number: ELN-<Cairo date>-<6 random digits>, retried until neither table has it.
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
revoke all on function private.new_tracking_number() from public, anon, authenticated;

-- 3. The order itself.
create or replace function public.place_store_order(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_store_id uuid;
  v_key text := nullif(trim(p_payload->>'idempotencyKey'), '');
  v_items jsonb := p_payload->'items';
  v_customer jsonb := p_payload->'customer';
  v_item jsonb;
  v_sp public.store_products;
  v_sp_id uuid;
  v_size_id uuid;
  v_qty integer;
  v_seen uuid[] := array[]::uuid[];
  v_subtotal numeric := 0;
  v_currency text;
  v_existing uuid;
  v_result jsonb;
  v_session jsonb;
  v_tracking text;
  v_attempt integer;
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
  if v_key is not null and char_length(v_key) not between 8 and 64 then
    raise exception 'Invalid retry key';
  end if;

  -- One order at a time per customer: a double tap, or a retry that overlaps the first call, waits here and then
  -- finds the first call's retry key.
  perform pg_advisory_xact_lock(hashtextextended('place_store_order:' || v_user_id::text, 0));

  if v_key is not null then
    select i.request_id into v_existing
    from private.store_order_idempotency i
    where i.user_id = v_user_id and i.idem_key = v_key;
    if found then
      select jsonb_build_object(
               'id', r.id, 'trackingNumber', r.tracking_number, 'checkoutTrackingNumber', r.checkout_tracking_number,
               'checkoutSessionId', r.checkout_session_id, 'status', r.status, 'subtotal', r.subtotal,
               'currency', r.currency, 'createdFromCart', true, 'cartCleared', true, 'duplicate', true)
        into v_result
      from public.store_order_requests r
      where r.id = v_existing and r.user_id = v_user_id;
      if v_result is not null then
        return v_result;
      end if;
    end if;
  end if;

  if (select count(*) from public.store_order_requests r
      where r.user_id = v_user_id and r.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Too many orders, try again later';
  end if;

  if v_customer is null or jsonb_typeof(v_customer) <> 'object'
     or coalesce(trim(v_customer->>'name'), '') = ''
     or coalesce(trim(v_customer->>'phone'), '') = ''
     or coalesce(trim(v_customer->>'address'), '') = '' then
    raise exception 'Customer details are required';
  end if;
  if char_length(trim(v_customer->>'name')) > 120 or char_length(trim(v_customer->>'phone')) > 32
     or char_length(trim(v_customer->>'address')) > 500
     or char_length(coalesce(trim(v_customer->>'email'), '')) > 254
     or char_length(coalesce(trim(v_customer->>'notes'), '')) > 1000 then
    raise exception 'Customer details are too long';
  end if;

  if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) not between 1 and 100 then
    raise exception 'Order items are required';
  end if;

  -- The lines the customer saw: each must be a product this store offers, in stock, at the price shown.
  for v_item in select value from jsonb_array_elements(v_items) loop
    begin
      v_sp_id := nullif(v_item->>'storeProductId', '')::uuid;
      v_size_id := nullif(v_item->>'productSizeId', '')::uuid;
      v_qty := (v_item->>'quantity')::integer;
    exception when others then
      raise exception 'Invalid order item';
    end;
    if v_sp_id is null or v_qty is null or v_qty < 1 or v_qty > 99 or v_sp_id = any (v_seen) then
      raise exception 'Invalid order item';
    end if;
    v_seen := v_seen || v_sp_id;
    select * into v_sp from public.store_products sp where sp.id = v_sp_id and sp.store_id = v_store_id;
    if not found then
      raise exception 'Product is not offered by this store';
    end if;
    if v_size_id is not null and v_size_id is distinct from v_sp.product_size_id then
      raise exception 'Invalid order item';
    end if;
    if not v_sp.is_available or (v_sp.stock_quantity is not null and v_sp.stock_quantity < v_qty) then
      raise exception 'Product is unavailable or has insufficient stock';
    end if;
    begin
      if abs(coalesce((v_item->>'unitPrice')::numeric, -1) - v_sp.price) > 0.005 then
        raise exception 'Price changed for product %', v_sp.product_size_id;
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Invalid order item';
    end;
    if v_currency is null then
      v_currency := v_sp.currency;
    elsif v_currency <> v_sp.currency then
      raise exception 'Mixed currencies are not supported';
    end if;
    v_subtotal := v_subtotal + round(v_sp.price * v_qty, 2);
  end loop;

  if p_payload ? 'subtotal' then
    begin
      if abs(coalesce((p_payload->>'subtotal')::numeric, -1) - v_subtotal) > 0.005 then
        raise exception 'Subtotal mismatch';
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Subtotal mismatch';
    end;
  end if;

  -- The saved cart for this store becomes exactly the displayed lines (other stores' rows are not touched).
  delete from public.cart_items ci
  using public.store_products sp
  where ci.store_product_id = sp.id and ci.user_id = v_user_id and sp.store_id = v_store_id;
  insert into public.cart_items (user_id, store_product_id, quantity)
  select v_user_id, (e->>'storeProductId')::uuid, (e->>'quantity')::integer
  from jsonb_array_elements(v_items) e;

  -- The tracking number and the checkout session. A clash with a number made at the same instant by someone else is
  -- retried with a new number.
  for v_attempt in 1..8 loop
    v_tracking := private.new_tracking_number();
    begin
      v_session := public.create_checkout_session(jsonb_build_object(
        'trackingNumber', v_tracking, 'customer', v_customer, 'currency', v_currency, 'subtotal', v_subtotal));
      exit;
    exception when unique_violation then
      v_session := null;
    end;
  end loop;
  if v_session is null then
    raise exception 'Could not allocate a tracking number';
  end if;

  v_result := public.create_store_order_request_from_cart(jsonb_build_object(
    'storeId', v_store_id, 'trackingNumber', v_tracking, 'checkoutTrackingNumber', v_tracking,
    'checkoutSessionId', v_session->>'id', 'customer', v_customer));

  if v_key is not null then
    insert into private.store_order_idempotency (user_id, idem_key, request_id)
    values (v_user_id, v_key, (v_result->>'id')::uuid);
  end if;

  return v_result || jsonb_build_object('subtotal', v_subtotal, 'currency', v_currency);
end;
$function$;

revoke all on function public.place_store_order(jsonb) from public, anon;
grant execute on function public.place_store_order(jsonb) to authenticated, service_role;

-- 4. The retry keys are only useful for a short while.
select cron.schedule('order-idempotency-retention-7d', '29 3 * * *',
  $$delete from private.store_order_idempotency where created_at < now() - interval '7 days'$$);

commit;
