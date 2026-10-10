-- RECONCILE BEFORE APPLYING: 20261010014304_harden_order_user_binding (live) already redefines create_store_order_request and
-- requires auth.uid() to be non-null. Section 3 below must keep that check (v_user_id is null -> raise) or it weakens the live function.
-- PENDING: not applied to the live database yet. Needs the project owner's approval.
-- After it is applied, move it to supabase/migrations/ and rename it with the version the database recorded.
--
-- 1. anon keeps read access (and the intentional analytics insert) but loses every direct write/ancillary privilege.
--    RLS already blocks these writes today; this removes the privilege so a future wrong policy cannot expose a table.
-- 2. The seven owner/store read policies call auth.uid() once per query instead of once per row.
-- 3. create_store_order_request no longer trusts prices sent by the client: it checks every item against
--    public.store_products (price, availability, stock), checks the line totals and the subtotal, stores the
--    database values, and requires the checkout session to belong to the caller.
begin;
set local lock_timeout = '5s';

-- 1) least privilege for anon / authenticated -------------------------------------------------------
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon;
grant insert on public.analytics_events to anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;
alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon;
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated;

-- 2) RLS initplan: evaluate auth.uid() once per statement ---------------------------------------------
alter policy checkout_sessions_owner_read on public.checkout_sessions
  using (user_id = (select auth.uid()));
alter policy notifications_realtime_user_read on public.notifications
  using (user_id = (select auth.uid()));
alter policy notifications_realtime_store_read on public.notifications
  using (exists (select 1 from public.store_accounts sa where sa.user_id = (select auth.uid()) and sa.store_id = notifications.store_id));
alter policy store_order_cart_restorations_owner_read on public.store_order_cart_restorations
  using (user_id = (select auth.uid()));
alter policy store_order_notifications_owner_read on public.store_order_notifications
  using (exists (select 1 from public.store_order_requests r where r.id = store_order_notifications.request_id and r.user_id = (select auth.uid())));
alter policy store_order_request_items_owner_read on public.store_order_request_items
  using (exists (select 1 from public.store_order_requests r where r.id = store_order_request_items.request_id and r.user_id = (select auth.uid())));
alter policy store_order_requests_owner_read on public.store_order_requests
  using (user_id = (select auth.uid()));

-- 3) server-side price and ownership validation -------------------------------------------------------
create or replace function public.create_store_order_request(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_request public.store_order_requests;
  v_item jsonb;
  v_row jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_sp public.store_products;
  v_store_id uuid;
  v_user_id uuid := auth.uid();
  v_session_id uuid := nullif(p_payload->>'checkoutSessionId', '')::uuid;
  v_size_id uuid;
  v_store_product_id uuid;
  v_qty integer;
  v_line numeric;
  v_subtotal numeric := 0;
  v_currency text;
begin
  v_store_id := (p_payload->>'storeId')::uuid;
  if not exists (select 1 from public.stores s where s.id = v_store_id and s.status = 'active') then
    raise exception 'Invalid or inactive store';
  end if;
  if coalesce(trim(p_payload->'customer'->>'name'), '') = '' or coalesce(trim(p_payload->'customer'->>'phone'), '') = '' or coalesce(trim(p_payload->'customer'->>'address'), '') = '' then
    raise exception 'Customer details are required';
  end if;
  if coalesce(trim(p_payload->>'trackingNumber'), '') = '' then
    raise exception 'Tracking number is required';
  end if;
  if jsonb_typeof(p_payload->'items') is distinct from 'array' or jsonb_array_length(p_payload->'items') = 0 then
    raise exception 'Order items are required';
  end if;
  if v_session_id is not null and not exists (select 1 from public.checkout_sessions cs where cs.id = v_session_id and cs.user_id is not distinct from v_user_id) then
    raise exception 'Checkout session not found';
  end if;

  for v_item in select value from jsonb_array_elements(p_payload->'items') loop
    v_size_id := nullif(v_item->>'productSizeId', '')::uuid;
    v_store_product_id := nullif(v_item->>'storeProductId', '')::uuid;
    v_qty := (v_item->>'quantity')::integer;
    if v_size_id is null or v_qty is null or v_qty < 1 or coalesce(trim(v_item->>'name'), '') = '' then
      raise exception 'Invalid order item';
    end if;
    select * into v_sp from public.store_products sp
      where sp.store_id = v_store_id
        and sp.product_size_id = v_size_id
        and (v_store_product_id is null or sp.id = v_store_product_id)
      limit 1;
    if not found then
      raise exception 'Product is not offered by this store';
    end if;
    if not v_sp.is_available or (v_sp.stock_quantity is not null and v_sp.stock_quantity < v_qty) then
      raise exception 'Product is unavailable or has insufficient stock';
    end if;
    if abs(coalesce((v_item->>'unitPrice')::numeric, -1) - v_sp.price) > 0.005 then
      raise exception 'Price changed for product %', v_size_id;
    end if;
    v_line := round(v_sp.price * v_qty, 2);
    if abs(coalesce((v_item->>'total')::numeric, -1) - v_line) > 0.005 then
      raise exception 'Line total mismatch for product %', v_size_id;
    end if;
    if v_currency is null then
      v_currency := v_sp.currency;
    elsif v_currency <> v_sp.currency then
      raise exception 'Mixed currencies are not supported';
    end if;
    v_subtotal := v_subtotal + v_line;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'sp_id', v_sp.id, 'size_id', v_sp.product_size_id, 'name', v_item->>'name', 'brand', v_item->>'brand',
      'size', nullif(v_item->>'size', ''), 'qty', v_qty, 'unit', v_sp.price, 'line', v_line, 'currency', v_sp.currency));
  end loop;

  if p_payload ? 'subtotal' and abs(coalesce((p_payload->>'subtotal')::numeric, -1) - v_subtotal) > 0.005 then
    raise exception 'Subtotal mismatch';
  end if;

  insert into public.store_order_requests (tracking_number, checkout_tracking_number, checkout_session_id, store_id, user_id, customer_name, customer_phone, customer_email, customer_address, customer_notes, subtotal, currency, initial_payload)
  values (p_payload->>'trackingNumber', coalesce(nullif(p_payload->>'checkoutTrackingNumber', ''), p_payload->>'trackingNumber'), v_session_id, v_store_id, v_user_id, trim(p_payload->'customer'->>'name'), trim(p_payload->'customer'->>'phone'), nullif(trim(p_payload->'customer'->>'email'), ''), trim(p_payload->'customer'->>'address'), nullif(trim(p_payload->'customer'->>'notes'), ''), v_subtotal, v_currency, p_payload)
  returning * into v_request;

  for v_row in select value from jsonb_array_elements(v_rows) loop
    insert into public.store_order_request_items (request_id, store_product_id, product_size_id, product_name, brand_name, size_label, quantity, unit_price, line_total, currency)
    values (v_request.id, (v_row->>'sp_id')::uuid, (v_row->>'size_id')::uuid, v_row->>'name', v_row->>'brand', v_row->>'size', (v_row->>'qty')::integer, (v_row->>'unit')::numeric, (v_row->>'line')::numeric, v_row->>'currency');
  end loop;

  insert into public.store_order_notifications (request_id, tracking_number, event_type, store_status, match_status, payload)
  values (v_request.id, v_request.tracking_number, 'initial_submitted', 'awaiting_store_confirmation', 'matched', p_payload);

  return jsonb_build_object('id', v_request.id, 'trackingNumber', v_request.tracking_number, 'checkoutTrackingNumber', v_request.checkout_tracking_number, 'checkoutSessionId', v_request.checkout_session_id, 'status', v_request.status);
end;
$$;

revoke all on function public.create_store_order_request(jsonb) from public, anon;
grant execute on function public.create_store_order_request(jsonb) to authenticated;

commit;
