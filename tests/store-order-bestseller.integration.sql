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
  -- A synthetic customer (no real account is read or touched); everything is rolled back.
  v_uid := 'b0000000-0000-4000-8000-0000000000e1';
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data)
  VALUES (v_uid, 'authenticated', 'authenticated', 'bestseller-1@example.invalid', '{"full_name":"Best Seller One"}'::jsonb);
  INSERT INTO public.customer_details (user_id, full_name, phone, governorate, address, ship_same)
  VALUES (v_uid, 'احمد محمد علي حسن', '01012345678', 'القاهرة', 'شارع التحرير', true);
  SELECT sp.* INTO v_sp
  FROM public.store_products sp
  JOIN public.stores s ON s.id = sp.store_id AND s.status = 'active'
  -- only a line the platform really offers can be ordered (place_store_order checks the same view)
  JOIN public.catalog_platform_offers po ON po.store_product_id = sp.id AND po.store_id = sp.store_id
       AND po.product_size_id = sp.product_size_id AND po.price = sp.price AND po.currency = sp.currency
  WHERE sp.is_available
  ORDER BY sp.created_at
  LIMIT 1;

  IF v_sp.id IS NULL THEN
    RAISE NOTICE 'SKIPPED: requires one available store product';
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
  -- A product with no sale yet has no row in the view: that is zero units, not NULL.
  v_before_units := COALESCE((SELECT units_sold FROM public.registered_customer_best_sellers WHERE product_id = v_product_id), 0);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);

  -- 1) The platform cart is only a request basket; it does not represent a sale.
  INSERT INTO public.cart_items (user_id, store_product_id, quantity)
  VALUES (v_uid, v_sp.id, 2)
  RETURNING id INTO v_cart_item_id;

  v_total := round(v_sp.price * 2, 2);
  -- The server places the order for the verified customer from his account and his saved cart (phase 1); the tracking number is the server's.
  v_result := public.place_store_order_server(jsonb_build_object('storeId', v_sp.store_id, 'idempotencyKey', 'bestseller-key-0001'), v_uid);

  v_request_id := (v_result->>'id')::uuid;
  v_tracking := v_result->>'trackingNumber';
  ASSERT v_tracking ~ '^ELN-[0-9]{8}-[0-9]{6}$', 'the tracking number is made by the server';
  ASSERT v_result->>'createdFromCart' = 'true', 'request must be created from the cart';
  ASSERT v_result->>'cartCleared' = 'false', 'the cart is not cleared at creation: only a trusted payment result clears it (phase 2)';
  ASSERT EXISTS (SELECT 1 FROM public.cart_items WHERE id = v_cart_item_id), 'the cart row is still there after submission';
  ASSERT (SELECT status FROM public.store_order_requests WHERE id = v_request_id) = 'awaiting_store_confirmation', 'submitted request is not a sale yet';
  ASSERT (SELECT source_cart_item_id FROM public.store_order_request_items WHERE request_id = v_request_id) = v_cart_item_id, 'request item retains cart lineage';

  -- 2) Before the merchant confirms execution, the request is absent from best sellers.
  v_units := COALESCE((SELECT units_sold FROM public.registered_customer_best_sellers WHERE product_id = v_product_id), 0);
  ASSERT v_units = v_before_units, 'unconfirmed store request must not count as a sale';

  -- (phase 2) The store offers cash on delivery and approves, the customer chooses it: the platform's first notice exists, and only then
  -- can the merchant's own notice match it.
  INSERT INTO public.store_payment_methods (store_id, kind, mode, provider, label_ar)
  VALUES (v_sp.store_id, 'cod', 'none', 'merchant', 'الدفع عند الاستلام') ON CONFLICT DO NOTHING;
  PERFORM public.merchant_review_order(v_sp.store_id, jsonb_build_object('trackingNumber', v_tracking, 'decision', 'approve', 'shipping', 0));
  PERFORM public.select_order_payment_server(v_request_id, v_uid,
    (SELECT (o->>'id')::uuid FROM public.store_order_requests r, jsonb_array_elements(r.payment_options) o WHERE r.id = v_request_id AND o->>'kind' = 'cod' LIMIT 1),
    'bestseller-pay-key-1');
  ASSERT (SELECT count(*) FROM public.platform_order_notices WHERE request_id = v_request_id) = 1, 'the first platform notice exists before the merchant reports';

  SELECT id INTO v_request_item_id
  FROM public.store_order_request_items
  WHERE request_id = v_request_id
  LIMIT 1;

  -- 3) Merchant sends the complete, matching execution notification: every line with its platform number, the customer as the order holds
  --    him, the shipping amount and the carrier (the matcher refuses a report without them).
  v_notification := jsonb_build_object(
    'trackingNumber', v_tracking,
    'status', 'completed',
    'subtotal', v_total,
    'shipping', 0,
    'customer', (SELECT jsonb_build_object('name', customer_name, 'phone', customer_phone, 'address', customer_address)
                 FROM public.store_order_requests WHERE id = v_request_id),
    'shipment', jsonb_build_object('carrier', 'Test Carrier', 'status', 'preparing'),
    'items', jsonb_build_array(jsonb_build_object(
      'productSizeId', v_sp.product_size_id,
      'platformOrderNumber', (SELECT platform_order_number FROM public.store_order_request_items WHERE id = v_request_item_id),
      'quantity', 2,
      'unitPrice', v_sp.price,
      'total', v_total,
      'currency', v_sp.currency
    )),
    'merchantOrderNumber', 'MERCHANT-' || v_tracking,
    'merchantInvoiceNumber', 'INVOICE-' || v_tracking,
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
