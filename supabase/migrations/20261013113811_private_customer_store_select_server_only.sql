-- Private customer and store-operation records are accessed through role-checked server APIs.
-- Keep INSERT/UPDATE permissions and owner/store RLS policies unchanged; remove direct SELECT only.
DO $$
DECLARE
  target_table text;
  target_column text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'checkout_sessions',
    'commissions',
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
