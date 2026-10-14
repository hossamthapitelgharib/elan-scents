begin;

do $$
begin
  if has_table_privilege('anon', 'public.guest_visitors', 'SELECT') then
    raise exception 'anon must not read guest_visitors';
  end if;
  if has_table_privilege('authenticated', 'public.guest_visitors', 'SELECT') then
    raise exception 'authenticated users must not read guest_visitors directly';
  end if;
  if has_table_privilege('anon', 'public.customer_product_events', 'SELECT')
     or has_table_privilege('authenticated', 'public.customer_product_events', 'SELECT') then
    raise exception 'customer activity events must be server-only';
  end if;
  if has_table_privilege('anon', 'public.guest_product_analytics', 'SELECT')
     or has_table_privilege('authenticated', 'public.guest_product_analytics', 'SELECT') then
    raise exception 'guest product analytics must be server-only';
  end if;
  if has_table_privilege('anon', 'public.profiles', 'SELECT')
     or has_table_privilege('anon', 'public.cart_items', 'SELECT') then
    raise exception 'anonymous users must not directly read customer profiles or carts';
  end if;
  if has_table_privilege('anon', 'public.analytics_events', 'SELECT')
     or has_table_privilege('anon', 'public.checkout_sessions', 'SELECT')
     or has_table_privilege('anon', 'public.contact_messages', 'SELECT')
     or has_table_privilege('anon', 'public.favorites', 'SELECT')
     or has_table_privilege('anon', 'public.notifications', 'SELECT')
     or has_table_privilege('anon', 'public.orders', 'SELECT')
     or has_table_privilege('anon', 'public.order_items', 'SELECT') then
    raise exception 'anonymous users must not directly read private customer or order tables';
  end if;
  if has_table_privilege('anon', 'public.commissions', 'SELECT')
     or has_table_privilege('anon', 'public.order_operation_events', 'SELECT')
     or has_table_privilege('anon', 'public.order_reconciliation_checks', 'SELECT')
     or has_table_privilege('anon', 'public.store_accounts', 'SELECT')
     or has_table_privilege('anon', 'public.store_order_cart_restorations', 'SELECT')
     or has_table_privilege('anon', 'public.store_order_notifications', 'SELECT')
     or has_table_privilege('anon', 'public.store_order_request_items', 'SELECT')
     or has_table_privilege('anon', 'public.store_order_requests', 'SELECT')
     or has_table_privilege('anon', 'public.store_shipments', 'SELECT')
     or has_table_privilege('anon', 'public.sync_logs', 'SELECT') then
    raise exception 'anonymous users must not directly read store-operation tables';
  end if;
  if has_table_privilege('authenticated', 'public.checkout_sessions', 'SELECT') or has_any_column_privilege('authenticated', 'public.checkout_sessions', 'SELECT')
     or has_table_privilege('authenticated', 'public.orders', 'SELECT') or has_any_column_privilege('authenticated', 'public.orders', 'SELECT')
     or has_table_privilege('authenticated', 'public.order_items', 'SELECT') or has_any_column_privilege('authenticated', 'public.order_items', 'SELECT')
     or has_table_privilege('authenticated', 'public.store_order_requests', 'SELECT') or has_any_column_privilege('authenticated', 'public.store_order_requests', 'SELECT')
     or has_table_privilege('authenticated', 'public.store_order_request_items', 'SELECT') or has_any_column_privilege('authenticated', 'public.store_order_request_items', 'SELECT')
     or has_table_privilege('authenticated', 'public.store_shipments', 'SELECT') or has_any_column_privilege('authenticated', 'public.store_shipments', 'SELECT')
     or has_table_privilege('authenticated', 'public.store_order_notifications', 'SELECT') or has_any_column_privilege('authenticated', 'public.store_order_notifications', 'SELECT')
     or has_table_privilege('authenticated', 'public.store_order_cart_restorations', 'SELECT') or has_any_column_privilege('authenticated', 'public.store_order_cart_restorations', 'SELECT')
     or has_table_privilege('authenticated', 'public.order_operation_events', 'SELECT') or has_any_column_privilege('authenticated', 'public.order_operation_events', 'SELECT')
     or has_table_privilege('authenticated', 'public.order_reconciliation_checks', 'SELECT') or has_any_column_privilege('authenticated', 'public.order_reconciliation_checks', 'SELECT')
     or has_table_privilege('authenticated', 'public.store_accounts', 'SELECT') or has_any_column_privilege('authenticated', 'public.store_accounts', 'SELECT')
     or has_table_privilege('authenticated', 'public.commissions', 'SELECT') or has_any_column_privilege('authenticated', 'public.commissions', 'SELECT')
     or has_table_privilege('authenticated', 'public.notifications', 'SELECT') or has_any_column_privilege('authenticated', 'public.notifications', 'SELECT')
     or has_table_privilege('authenticated', 'public.notifications', 'UPDATE') or has_any_column_privilege('authenticated', 'public.notifications', 'UPDATE')
     or has_table_privilege('authenticated', 'public.sync_logs', 'SELECT') or has_any_column_privilege('authenticated', 'public.sync_logs', 'SELECT') then
    raise exception 'authenticated customers and store admins must use role-checked APIs for private order and store records';
  end if;
  if not has_table_privilege('anon', 'public.public_stores', 'SELECT')
     or not has_table_privilege('anon', 'public.public_products', 'SELECT')
     or not has_table_privilege('anon', 'public.cheapest_offers', 'SELECT') then
    raise exception 'public catalog views must remain readable';
  end if;
  if not has_column_privilege('anon', 'public.stores', 'name', 'SELECT')
     or has_column_privilege('anon', 'public.stores', 'website_url', 'SELECT')
     or has_column_privilege('anon', 'public.stores', 'commission_rate', 'SELECT')
     or has_column_privilege('anon', 'public.stores', 'priority_rank', 'SELECT')
     or has_column_privilege('anon', 'public.stores', 'created_at', 'SELECT') then
    raise exception 'anonymous store reads must be limited to public profile fields';
  end if;
  if not has_column_privilege('anon', 'public.store_products', 'product_size_id', 'SELECT')
     or not has_column_privilege('anon', 'public.store_products', 'is_new_arrival', 'SELECT')
     or not has_column_privilege('anon', 'public.store_products', 'sync_status', 'SELECT')
     or not has_column_privilege('anon', 'public.store_products', 'is_catalog_bestseller', 'SELECT')
     or has_column_privilege('anon', 'public.store_products', 'data_source', 'SELECT')
     or has_column_privilege('anon', 'public.store_products', 'original_price', 'SELECT')
     or has_column_privilege('anon', 'public.store_products', 'discount_percentage', 'SELECT')
     or has_column_privilege('anon', 'public.store_products', 'product_url', 'SELECT') then
    raise exception 'anonymous product reads must be limited to storefront-required fields';
  end if;
  if not has_column_privilege('anon', 'public.offers', 'product_size_id', 'SELECT')
     or has_column_privilege('anon', 'public.offers', 'discount_value', 'SELECT')
     or has_column_privilege('anon', 'public.offers', 'description', 'SELECT') then
    raise exception 'anonymous offer reads must be limited to product-size identifiers';
  end if;
  if not has_table_privilege('service_role', 'public.store_order_requests', 'SELECT')
     or not has_table_privilege('service_role', 'public.store_products', 'SELECT')
     or not has_table_privilege('service_role', 'public.commissions', 'SELECT') then
    raise exception 'admin APIs must retain service-role reads';
  end if;
  if has_table_privilege('authenticated', 'public.cart_items', 'SELECT') then
    raise exception 'customer clients must use the limited cart column grants';
  end if;
  if not has_column_privilege('authenticated', 'public.cart_items', 'user_id', 'SELECT')
     or not has_column_privilege('authenticated', 'public.cart_items', 'store_product_id', 'SELECT')
     or not has_column_privilege('authenticated', 'public.cart_items', 'quantity', 'SELECT') then
    raise exception 'customer cart synchronization lost required read columns';
  end if;
  if has_column_privilege('authenticated', 'public.cart_items', 'product_snapshot', 'SELECT')
     or has_column_privilege('authenticated', 'public.cart_items', 'product_snapshot', 'INSERT')
     or has_column_privilege('authenticated', 'public.cart_items', 'product_snapshot', 'UPDATE') then
    raise exception 'customer clients must not read or write the private cart snapshot';
  end if;
  if not has_column_privilege('authenticated', 'public.cart_items', 'store_product_id', 'INSERT')
     or not has_column_privilege('authenticated', 'public.cart_items', 'quantity', 'INSERT')
     or not has_table_privilege('authenticated', 'public.cart_items', 'DELETE') then
    raise exception 'customer cart synchronization lost required write privileges';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='customer_product_events' and column_name='product_snapshot' and data_type='jsonb' limit 1)
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='guest_product_analytics' and column_name='product_snapshot' and data_type='jsonb' limit 1)
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='cart_items' and column_name='product_snapshot' and data_type='jsonb' limit 1) then
    raise exception 'product snapshots are missing from customer activity or cart storage';
  end if;
  if exists (select 1 from pg_constraint where conrelid='public.customer_product_events'::regclass and conname='customer_product_events_product_id_fkey' limit 1)
     or exists (select 1 from pg_constraint where conrelid='public.guest_product_analytics'::regclass and conname='guest_product_analytics_product_id_fkey' limit 1) then
    raise exception 'catalog deletion must not cascade into historical activity';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.cart_items'::regclass and tgname='cart_items_product_snapshot' and not tgisinternal limit 1) then
    raise exception 'registered basket product snapshots must be maintained by a database trigger';
  end if;
  if has_function_privilege('anon', 'public.platform_store_summary()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.platform_store_summary()', 'EXECUTE') then
    raise exception 'store summary RPC must not be directly executable by clients';
  end if;
  if has_function_privilege('anon', 'public.customer_activity_summary(text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.customer_activity_summary(text,text)', 'EXECUTE') then
    raise exception 'customer activity summary RPC must remain server-only';
  end if;
  if has_function_privilege('anon', 'public.capture_product_snapshot(uuid,uuid,uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.capture_product_snapshot(uuid,uuid,uuid,text)', 'EXECUTE') then
    raise exception 'product snapshot function must remain server-only';
  end if;
  if has_function_privilege('anon', 'public.customer_product_ranking(text,text,text,integer,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.customer_product_ranking(text,text,text,integer,integer)', 'EXECUTE') then
    raise exception 'customer product ranking RPC must remain server-only';
  end if;
  if not has_function_privilege('service_role', 'public.platform_store_summary()', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.customer_activity_summary(text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.capture_product_snapshot(uuid,uuid,uuid,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.customer_product_ranking(text,text,text,integer,integer)', 'EXECUTE') then
    raise exception 'server APIs must retain access to administrative summary, ranking and snapshot functions';
  end if;
end;
$$;

rollback;
