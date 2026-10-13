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
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='customer_product_events' and column_name='product_snapshot' and data_type='jsonb')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='guest_product_analytics' and column_name='product_snapshot' and data_type='jsonb')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='cart_items' and column_name='product_snapshot' and data_type='jsonb') then
    raise exception 'product snapshots are missing from customer activity or cart storage';
  end if;
  if exists (select 1 from pg_constraint where conrelid='public.customer_product_events'::regclass and conname='customer_product_events_product_id_fkey')
     or exists (select 1 from pg_constraint where conrelid='public.guest_product_analytics'::regclass and conname='guest_product_analytics_product_id_fkey') then
    raise exception 'catalog deletion must not cascade into historical activity';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.cart_items'::regclass and tgname='cart_items_product_snapshot' and not tgisinternal) then
    raise exception 'registered basket product snapshots must be maintained by a database trigger';
  end if;
  if has_function_privilege('anon', 'public.platform_store_summary()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.platform_store_summary()', 'EXECUTE') then
    raise exception 'store summary RPC must not be directly executable by clients';
  end if;
  if has_function_privilege('anon', 'public.capture_product_snapshot(uuid,uuid,uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.capture_product_snapshot(uuid,uuid,uuid,text)', 'EXECUTE') then
    raise exception 'product snapshot function must remain server-only';
  end if;
  if not has_function_privilege('service_role', 'public.platform_store_summary()', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.capture_product_snapshot(uuid,uuid,uuid,text)', 'EXECUTE') then
    raise exception 'server APIs must retain access to administrative summary and snapshot functions';
  end if;
end;
$$;

rollback;
