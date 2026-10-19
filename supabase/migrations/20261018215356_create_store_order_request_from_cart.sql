ALTER TABLE public.store_order_request_items
  ADD COLUMN IF NOT EXISTS source_cart_item_id uuid REFERENCES public.cart_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS store_order_request_items_source_cart_idx
  ON public.store_order_request_items (source_cart_item_id);

CREATE OR REPLACE FUNCTION public.create_store_order_request_from_cart(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_store_id uuid := nullif(p_payload->>'storeId', '')::uuid;
  v_session_id uuid := nullif(p_payload->>'checkoutSessionId', '')::uuid;
  v_tracking text := nullif(trim(p_payload->>'trackingNumber'), '');
  v_currency text;
  v_subtotal numeric;
  v_items jsonb;
  v_order_payload jsonb;
  v_result jsonb;
  v_request_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if v_store_id is null or not exists (
    select 1 from public.stores s where s.id = v_store_id and s.status = 'active'
  ) then
    raise exception 'Invalid or inactive store';
  end if;
  if v_tracking is null then
    raise exception 'Tracking number is required';
  end if;
  if coalesce(trim(p_payload->'customer'->>'name'), '') = ''
     or coalesce(trim(p_payload->'customer'->>'phone'), '') = ''
     or coalesce(trim(p_payload->'customer'->>'address'), '') = '' then
    raise exception 'Customer details are required';
  end if;
  if v_session_id is not null and not exists (
    select 1 from public.checkout_sessions cs where cs.id = v_session_id and cs.user_id = v_user_id
  ) then
    raise exception 'Checkout session not found';
  end if;

  SELECT min(sp.currency), sum(sp.price * ci.quantity),
         jsonb_agg(jsonb_build_object(
           'cartItemId', ci.id,
           'productSizeId', sp.product_size_id,
           'storeProductId', sp.id,
           'quantity', ci.quantity,
           'unitPrice', sp.price,
           'total', round(sp.price * ci.quantity, 2)
         ) ORDER BY ci.created_at)
  INTO v_currency, v_subtotal, v_items
  FROM public.cart_items ci
  JOIN public.store_products sp ON sp.id = ci.store_product_id
  WHERE ci.user_id = v_user_id
    AND sp.store_id = v_store_id
    AND sp.is_available
    AND (sp.stock_quantity IS NULL OR sp.stock_quantity >= ci.quantity);

  if v_items is null or jsonb_array_length(v_items) = 0 then
    raise exception 'Cart is empty or contains unavailable products for this store';
  end if;

  if exists (
    select 1
    from public.cart_items ci
    join public.store_products sp on sp.id = ci.store_product_id
    where ci.user_id = v_user_id
      and sp.store_id = v_store_id
      and (not sp.is_available or (sp.stock_quantity is not null and sp.stock_quantity < ci.quantity))
  ) then
    raise exception 'Cart contains unavailable or insufficient-stock products';
  end if;

  v_order_payload := jsonb_build_object(
    'storeId', v_store_id,
    'checkoutSessionId', v_session_id,
    'trackingNumber', v_tracking,
    'checkoutTrackingNumber', coalesce(nullif(p_payload->>'checkoutTrackingNumber', ''), v_tracking),
    'customer', p_payload->'customer',
    'items', v_items,
    'subtotal', v_subtotal,
    'currency', coalesce(v_currency, 'EGP')
  );

  v_result := public.create_store_order_request(v_order_payload);
  v_request_id := nullif(v_result->>'id', '')::uuid;

  UPDATE public.store_order_request_items ri
  SET source_cart_item_id = ci.id
  FROM public.cart_items ci
  JOIN public.store_products sp ON sp.id = ci.store_product_id
  WHERE ri.request_id = v_request_id
    AND ci.user_id = v_user_id
    AND sp.store_id = v_store_id
    AND ri.store_product_id = ci.store_product_id;

  DELETE FROM public.cart_items ci
  USING public.store_products sp
  WHERE ci.store_product_id = sp.id
    AND ci.user_id = v_user_id
    AND sp.store_id = v_store_id;

  return v_result || jsonb_build_object('createdFromCart', true, 'cartCleared', true);
end;
$function$;

REVOKE ALL ON FUNCTION public.create_store_order_request_from_cart(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_store_order_request_from_cart(jsonb) TO authenticated, service_role;
