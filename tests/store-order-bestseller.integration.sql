-- Integration test: store request -> merchant notification -> bestseller ranking -> return/refund adjustment.
-- Run against the target Supabase database with service-role/postgres privileges.
-- Everything runs inside one transaction and is rolled back at the end.

BEGIN;

DO $$
declare
  v_uid uuid;
  v_sp public.store_products;
  v_product_id uuid;
  v_cart_item_id uuid;
  v_result jsonb;
  v_notification jsonb;
  v_request_id uuid;
  v_request_item_id uuid;
  v_total numeric;
  v_units bigint;
  v_rpc_units bigint;
  v_before_units bigint := 0;
  v_tracking text := 'IT-' || replace(gen_random_uuid()::text, '-', '');
begin
  SELECT id INTO v_uid FROM auth.users ORDER BY created_at LIMIT 1;
  SELECT sp.* INTO v_sp
  FROM public.store_products sp
  JOIN public.stores s ON s.id = sp.store_id AND s.status = 'active'
  WHERE sp.is_available
  ORDER BY sp.created_at
  LIMIT 1;

  IF v_uid IS NULL OR v_sp.id IS NULL THEN
    RAISE NOTICE 'SKIPPED: requires one auth user and one available store product';
    RETURN;
  END IF;

  -- Keep the fixture deterministic while the outer transaction guarantees rollback.
  UPDATE public.store_products
  SET stock_quantity = 2
  WHERE id = v_sp.id AND stock_quantity IS NOT NULL AND stock_quantity < 2;

  SELECT product_id INTO v_product_id
  FROM public.product_sizes
  WHERE id = v_sp.product_size_id;
  ASSERT v_product_id IS NOT NULL, 'store product must resolve to a base product';
  SELECT COALESCE(units_sold, 0) INTO v_before_units FROM public.registered_customer_best_sellers WHERE product_id = v_product_id;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);

  -- 1) The platform cart is only a request basket; it does not represent a sale.
  INSERT INTO public.cart_items (user_id, store_product_id, quantity)
  VALUES (v_uid, v_sp.id, 2)
  RETURNING id INTO v_cart_item_id;

  v_total := round(v_sp.price * 2, 2);
  v_result := public.create_store_order_request_from_cart(jsonb_build_object(
    'storeId', v_sp.store_id,
    'trackingNumber', v_tracking,
    'customer', jsonb_build_object('name', 'Integration Test', 'phone', '000', 'address', 'Test address')
  ));

  v_request_id := (v_result->>'id')::uuid;
  ASSERT v_result->>'createdFromCart' = 'true', 'request must be created from the cart';
  ASSERT v_result->>'cartCleared' = 'true', 'cart must be cleared after request submission';
  ASSERT NOT EXISTS (SELECT 1 FROM public.cart_items WHERE id = v_cart_item_id), 'cart row is cleared after submission';
  ASSERT (SELECT status FROM public.store_order_requests WHERE id = v_request_id) = 'awaiting_store_confirmation', 'submitted request is not a sale yet';
  ASSERT (SELECT source_cart_item_id FROM public.store_order_request_items WHERE request_id = v_request_id) = v_cart_item_id, 'request item retains cart lineage';

  -- 2) Before the merchant confirms execution, the request is absent from best sellers.
  SELECT COALESCE(units_sold, 0) INTO v_units FROM public.registered_customer_best_sellers WHERE product_id = v_product_id;
  ASSERT v_units = v_before_units, 'unconfirmed store request must not count as a sale';

  SELECT id INTO v_request_item_id
  FROM public.store_order_request_items
  WHERE request_id = v_request_id
  LIMIT 1;

  -- 3) Merchant sends the complete, matching execution notification.
  v_notification := jsonb_build_object(
    'trackingNumber', v_tracking,
    'status', 'completed',
    'subtotal', v_total,
    'items', jsonb_build_array(jsonb_build_object(
      'productSizeId', v_sp.product_size_id,
      'quantity', 2,
      'unitPrice', v_sp.price,
      'total', v_total,
      'currency', v_sp.currency
    )),
    'storeOrderReference', 'MERCHANT-' || v_tracking,
    'idempotencyKey', 'idempotent-' || v_tracking
  );
  v_result := public.receive_store_order_notification(v_notification);

  ASSERT (v_result->>'matched')::boolean, 'matching merchant notification must reconcile';
  ASSERT v_result->>'status' = 'completed', 'matching completed notification must complete the request';
  ASSERT (SELECT status FROM public.store_order_requests WHERE id = v_request_id) = 'completed', 'request status must be completed';
  ASSERT (SELECT reconciliation_status FROM public.store_order_requests WHERE id = v_request_id) = 'matched', 'request must be marked matched';

  SELECT units_sold INTO v_units
  FROM public.registered_customer_best_sellers
  WHERE product_id = v_product_id;
  ASSERT v_units = v_before_units + 2, 'confirmed merchant sale must add two units to best sellers';

  v_result := public.platform_registered_customer_best_sellers('all', 100, 0);
  ASSERT (v_result->'audit'->>'returnsAndRefundsTracked')::boolean, 'RPC must report adjustment tracking enabled';
  ASSERT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_result->'records') AS rec
    WHERE rec->'product'->>'id' = v_product_id::text
      AND (rec->>'unitsSold')::bigint = v_before_units + 2
  ), 'RPC best-seller record must expose the confirmed units';

  -- 4) Duplicate webhook delivery is idempotent and does not change the sale count.
  v_result := public.receive_store_order_notification(v_notification);
  ASSERT (v_result->>'duplicate')::boolean, 'duplicate merchant notification must be idempotent';
  ASSERT (SELECT units_sold FROM public.registered_customer_best_sellers WHERE product_id = v_product_id) = v_before_units + 2, 'duplicate webhook must not duplicate units';

  -- 5) A pending adjustment does not reduce net sales.
  INSERT INTO public.store_order_item_adjustments (
    request_id, request_item_id, adjustment_type, status, quantity, amount, currency, reason, created_by
  ) VALUES (
    v_request_id, v_request_item_id, 'return', 'pending', 1, v_sp.price, v_sp.currency, 'pending test return', v_uid
  );
  ASSERT (SELECT units_sold FROM public.registered_customer_best_sellers WHERE product_id = v_product_id) = v_before_units + 2, 'pending return must not reduce units';

  -- 6) A completed partial return/refund reduces net units exactly once.
  INSERT INTO public.store_order_item_adjustments (
    request_id, request_item_id, adjustment_type, status, quantity, amount, currency, reason, created_by
  ) VALUES (
    v_request_id, v_request_item_id, 'refund', 'completed', 1, v_sp.price, v_sp.currency, 'completed partial refund', v_uid
  );
  SELECT units_sold INTO v_units
  FROM public.registered_customer_best_sellers
  WHERE product_id = v_product_id;
  ASSERT v_units = v_before_units + 1, 'completed partial refund must reduce net units by one';

  v_result := public.platform_registered_customer_best_sellers('all', 100, 0);
  v_rpc_units := COALESCE((
    SELECT (rec->>'unitsSold')::bigint
    FROM jsonb_array_elements(v_result->'records') AS rec
    WHERE rec->'product'->>'id' = v_product_id::text
    LIMIT 1
  ), -1);
  ASSERT v_rpc_units = v_before_units + 1, 'RPC must expose the adjusted net units';
  ASSERT (v_result->'audit'->>'reversedUnits')::bigint >= 1, 'RPC audit must report reversed units';

  RAISE NOTICE 'ALL STORE ORDER -> BEST SELLER INTEGRATION CHECKS PASSED';
END $$;

ROLLBACK;
