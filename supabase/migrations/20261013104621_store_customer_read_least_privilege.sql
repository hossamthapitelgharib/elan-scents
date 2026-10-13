-- Anonymous visitors need the published storefront, not private customer or store-operation tables.
-- Keep authenticated owner/store RLS policies unchanged and preserve server-role dashboard access.
DO $$
DECLARE
  target_table text;
  target_column text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'analytics_events',
    'checkout_sessions',
    'commissions',
    'contact_messages',
    'favorites',
    'notifications',
    'order_items',
    'order_operation_events',
    'order_reconciliation_checks',
    'orders',
    'store_accounts',
    'store_order_cart_restorations',
    'store_order_notifications',
    'store_order_request_items',
    'store_order_requests',
    'store_shipments',
    'sync_logs'
  ] LOOP
    EXECUTE format('REVOKE SELECT ON TABLE public.%I FROM anon', target_table);
    FOR target_column IN
      SELECT a.attname
      FROM pg_attribute a
      WHERE a.attrelid = format('public.%I', target_table)::regclass
        AND a.attnum > 0
        AND NOT a.attisdropped
    LOOP
      EXECUTE format('REVOKE SELECT (%I) ON TABLE public.%I FROM anon', target_column, target_table);
    END LOOP;
  END LOOP;

  -- These tables back the public catalog. Remove broad SELECT grants and re-grant only
  -- fields needed by the security-invoker public views and the storefront's explicit queries.
  FOREACH target_table IN ARRAY ARRAY['stores', 'store_products', 'offers'] LOOP
    EXECUTE format('REVOKE SELECT ON TABLE public.%I FROM anon, authenticated', target_table);
    FOR target_column IN
      SELECT a.attname
      FROM pg_attribute a
      WHERE a.attrelid = format('public.%I', target_table)::regclass
        AND a.attnum > 0
        AND NOT a.attisdropped
    LOOP
      EXECUTE format('REVOKE SELECT (%I) ON TABLE public.%I FROM anon, authenticated', target_column, target_table);
    END LOOP;
  END LOOP;
END;
$$;

GRANT SELECT (id, name, slug, logo_url, image_url, short_description, status)
  ON TABLE public.stores TO anon, authenticated;

GRANT SELECT (id, store_id, product_size_id, price, stock_quantity, is_available, is_new_arrival,
              price_includes_tax, price_includes_shipping, currency, sync_status, last_synced_at,
              is_catalog_bestseller)
  ON TABLE public.store_products TO anon, authenticated;

GRANT SELECT (product_size_id) ON TABLE public.offers TO anon, authenticated;
