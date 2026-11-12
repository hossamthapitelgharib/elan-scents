-- Canonical catalog offer contract, safely based on the live production definitions through migration 20261110060252.
-- NULL/zero stock and NULL prices cannot be sold; coming-soon announcements are a separate, non-price feed.
-- place_store_order preserves the current address-part snapshot and validates exact canonical store/product/price identity.
BEGIN;

ALTER TABLE public.store_products ALTER COLUMN price DROP NOT NULL;
ALTER TABLE public.store_products
  ADD CONSTRAINT store_products_price_required_unless_coming_soon
  CHECK (is_coming_soon IS TRUE OR price IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_store_products_platform_sale_eligible
  ON public.store_products (product_size_id, price, store_id, id)
  WHERE is_available
    AND sync_status = 'synced'
    AND currency = 'EGP'
    AND stock_quantity IS NOT NULL
    AND stock_quantity > 0
    AND price IS NOT NULL
    AND is_coming_soon IS NOT TRUE;

CREATE OR REPLACE FUNCTION private.fn_catalog_eligible_offers()
 RETURNS TABLE(store_product_id uuid, product_size_id uuid, product_id uuid, brand_id uuid, store_id uuid, store_name text, price numeric, currency text, stock_quantity integer, price_includes_tax boolean, price_includes_shipping boolean, last_synced_at timestamp with time zone, is_available boolean, sync_status text, store_status text, is_new_arrival boolean, is_coming_soon boolean, is_catalog_bestseller boolean, commission_rate numeric, priority_rank integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT sp.id,
         sp.product_size_id,
         ps.product_id,
         p.brand_id,
         sp.store_id,
         s.name,
         sp.price,
         sp.currency,
         sp.stock_quantity,
         sp.price_includes_tax,
         sp.price_includes_shipping,
         sp.last_synced_at,
         sp.is_available,
         sp.sync_status,
         s.status,
         sp.is_new_arrival,
         sp.is_coming_soon,
         sp.is_catalog_bestseller,
         s.commission_rate,
         s.priority_rank
  FROM public.store_products sp
  JOIN public.stores s ON s.id = sp.store_id
  JOIN public.product_sizes ps ON ps.id = sp.product_size_id
  JOIN public.products p ON p.id = ps.product_id
  WHERE s.status = 'active'
    AND p.status = 'published'
    AND p.is_active
    AND sp.is_available
    AND sp.sync_status = 'synced'
    AND sp.stock_quantity IS NOT NULL
    AND sp.stock_quantity > 0
    AND sp.price IS NOT NULL
    AND sp.currency = 'EGP'
    AND sp.is_coming_soon IS NOT TRUE;
$function$;

CREATE OR REPLACE FUNCTION private.fn_catalog_coming_soon_announcements()
RETURNS TABLE(
  product_size_id uuid,
  product_id uuid,
  store_id uuid,
  store_name text,
  stock_unknown boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
  SELECT DISTINCT ON (ps.id)
         ps.id,
         ps.product_id,
         s.id,
         s.name,
         (sp.stock_quantity IS NULL)
    FROM public.store_products sp
    JOIN public.stores s ON s.id = sp.store_id
    JOIN public.product_sizes ps ON ps.id = sp.product_size_id
    JOIN public.products p ON p.id = ps.product_id
   WHERE s.status = 'active'
     AND p.status = 'published'
     AND p.is_active
     AND sp.is_coming_soon IS TRUE
     AND NOT EXISTS (
       SELECT 1 FROM private.fn_catalog_eligible_offers() sale
        WHERE sale.product_size_id = sp.product_size_id
     )
   ORDER BY ps.id, s.priority_rank ASC, s.id ASC, sp.id ASC;
$function$;
REVOKE ALL ON FUNCTION private.fn_catalog_coming_soon_announcements() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE VIEW public.catalog_coming_soon_announcements AS
SELECT product_size_id, product_id, store_id, store_name, stock_unknown
FROM private.fn_catalog_coming_soon_announcements();
REVOKE ALL ON public.catalog_coming_soon_announcements FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.catalog_coming_soon_announcements TO anon, authenticated, service_role;
COMMENT ON VIEW public.catalog_coming_soon_announcements IS
  'Published active product sizes explicitly announced as coming soon by an active platform store, only when no eligible platform sale offer exists. Contains no price or sellable offer id.';

create or replace view public.public_products with (security_invoker = true) as
 SELECT p.id,
    p.brand_id,
    b.name AS brand_name,
    b.slug AS brand_slug,
    p.name,
    p.slug,
    p.short_description,
    p.official_description,
    p.composition,
    p.gender,
    p.notes_source,
    p.meta_title,
    p.meta_description,
    ( SELECT min(co.price) AS min
           FROM cheapest_offers co
          WHERE co.product_id = p.id) AS min_price,
    ( SELECT count(*) AS count
           FROM cheapest_offers co
          WHERE co.product_id = p.id) AS available_sizes,
    COALESCE(st.views_count, 0) AS views_count,
    COALESCE(st.sales_count, 0) AS sales_count,
    COALESCE(st.search_count, 0) AS search_count,
    st.average_rating::numeric(3,2) AS average_rating,
    nullif(st.reviews_count, 0) AS reviews_count
   FROM products p
     JOIN brands b ON b.id = p.brand_id
     LEFT JOIN private.fn_product_final_stats() st ON st.product_id = p.id
  WHERE p.status = 'published'::text AND p.is_active AND (EXISTS ( SELECT 1
           FROM cheapest_offers co
          WHERE co.product_id = p.id) OR EXISTS (SELECT 1 FROM public.catalog_coming_soon_announcements a WHERE a.product_id = p.id));

comment on view public.public_products is
  'Published active perfumes with a platform sale offer or a separate coming-soon announcement. Sale prices and available-size counts come only from cheapest_offers; product activity and ratings use the current final stats source.';

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

COMMIT;